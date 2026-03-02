import { env } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'text' };
}

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';

// ── Rate Limiter: queues requests so we never exceed RPM ──

const MAX_RPM = 14;
const WINDOW_MS = 60_000;
const MAX_RETRIES = 3;
const CIRCUIT_OPEN_MS = 2 * 60_000;

let requestTimestamps: number[] = [];
let circuitOpenUntil = 0;
let consecutiveFailures = 0;
const pendingQueue: Array<{ resolve: () => void }> = [];
let draining = false;

function isCircuitOpen(): boolean {
  if (circuitOpenUntil > 0 && Date.now() < circuitOpenUntil) return true;
  if (circuitOpenUntil > 0 && Date.now() >= circuitOpenUntil) {
    circuitOpenUntil = 0;
    consecutiveFailures = 0;
    console.log('[Gemini] Circuit breaker reset — resuming API calls');
  }
  return false;
}

function openCircuit(retryAfterSec?: number): void {
  const cooldownMs = retryAfterSec
    ? retryAfterSec * 1000
    : CIRCUIT_OPEN_MS;
  circuitOpenUntil = Date.now() + cooldownMs;
  console.warn(`[Gemini] Circuit breaker OPEN for ${Math.round(cooldownMs / 1000)}s — quota/rate limit hit`);
}

export function getOpenAIStatus(): { circuitOpen: boolean; queueLength: number; recentRequests: number; cooldownRemainingMs: number } {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < WINDOW_MS);
  return {
    circuitOpen: isCircuitOpen(),
    queueLength: pendingQueue.length,
    recentRequests: requestTimestamps.length,
    cooldownRemainingMs: circuitOpenUntil > now ? circuitOpenUntil - now : 0,
  };
}

async function acquireSlot(): Promise<void> {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < WINDOW_MS);

  if (requestTimestamps.length < MAX_RPM) {
    requestTimestamps.push(now);
    return;
  }

  return new Promise<void>((resolve) => {
    pendingQueue.push({ resolve });
    scheduleDrain();
  });
}

function scheduleDrain(): void {
  if (draining) return;
  draining = true;

  const check = () => {
    const now = Date.now();
    requestTimestamps = requestTimestamps.filter(t => now - t < WINDOW_MS);

    while (pendingQueue.length > 0 && requestTimestamps.length < MAX_RPM) {
      const next = pendingQueue.shift()!;
      requestTimestamps.push(now);
      next.resolve();
    }

    if (pendingQueue.length > 0) {
      const oldest = requestTimestamps[0];
      const waitMs = Math.max(100, WINDOW_MS - (now - oldest) + 50);
      setTimeout(check, waitMs);
    } else {
      draining = false;
    }
  };

  const now = Date.now();
  const oldest = requestTimestamps[0];
  const waitMs = oldest ? Math.max(100, WINDOW_MS - (now - oldest) + 50) : 100;
  setTimeout(check, waitMs);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function buildGeminiBody(
  messages: ChatMessage[],
  temperature: number,
  maxTokens: number,
  responseFormat?: { type: 'json_object' | 'text' },
): Record<string, unknown> {
  let systemText = '';
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n' : '') + msg.content;
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const generationConfig: Record<string, unknown> = {
    temperature,
    maxOutputTokens: maxTokens,
  };

  if (responseFormat?.type === 'json_object') {
    generationConfig.responseMimeType = 'application/json';
  }

  const body: Record<string, unknown> = { contents, generationConfig };

  if (systemText) {
    if (responseFormat?.type === 'json_object') {
      systemText += '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no code fences, no extra text.';
    }
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  return body;
}

function getApiKey(): string {
  return env.GEMINI_API_KEY || env.OPENAI_API_KEY;
}

/**
 * Strips markdown code fences that Gemini sometimes wraps around JSON responses.
 * e.g. "```json\n{...}\n```" → "{...}"
 */
function stripMarkdownFences(text: string): string {
  let s = text.trim();
  const fenceMatch = s.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return s;
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<string> {
  if (isCircuitOpen()) {
    const remaining = Math.round((circuitOpenUntil - Date.now()) / 1000);
    throw new Error(`Gemini circuit breaker open — cooling down for ${remaining}s. Quota/rate limit was exceeded.`);
  }

  const { messages, model = DEFAULT_MODEL, temperature = 0.7, maxTokens = 4096, responseFormat } = options;

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No AI API key configured (set GEMINI_API_KEY in environment)');
  }

  const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;
  const body = buildGeminiBody(messages, temperature, maxTokens, responseFormat);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0 && isCircuitOpen()) {
      throw lastError ?? new Error('Gemini circuit breaker opened during retry');
    }

    await acquireSlot();

    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (response.status === 429) {
        const errorBody = await response.text();
        consecutiveFailures++;

        let retryAfterSec: number | undefined;
        try {
          const errData = JSON.parse(errorBody);
          const retryInfo = errData?.error?.details?.find?.((d: any) => d['@type']?.includes('RetryInfo'));
          if (retryInfo?.retryDelay) {
            retryAfterSec = parseInt(retryInfo.retryDelay, 10) || undefined;
          }
        } catch { /* ignore parse error */ }

        if (consecutiveFailures >= 3 || errorBody.includes('RESOURCE_EXHAUSTED') || errorBody.includes('exceeded your current quota')) {
          openCircuit(retryAfterSec);
          throw new Error(`Gemini API error (429): ${errorBody}`);
        }

        const backoffMs = retryAfterSec
          ? retryAfterSec * 1000
          : Math.min(2000 * Math.pow(2, attempt), 30_000);
        console.warn(`[Gemini] Rate limited (attempt ${attempt + 1}/${MAX_RETRIES}), backing off ${Math.round(backoffMs / 1000)}s`);
        await sleep(backoffMs);
        lastError = new Error(`Gemini API error (429): ${errorBody}`);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
      }

      consecutiveFailures = 0;

      const data = await response.json() as any;

      const candidate = data.candidates?.[0];
      if (!candidate) {
        throw new Error(`Gemini returned no candidates: ${JSON.stringify(data).slice(0, 500)}`);
      }

      let content = candidate.content?.parts
        ?.map((p: any) => p.text ?? '')
        .join('')
        .trim();

      if (!content) {
        const reason = candidate.finishReason;
        if (reason === 'MAX_TOKENS') {
          throw new Error('Gemini response truncated (token limit too low)');
        }
        throw new Error(`Gemini returned empty response (finishReason: ${reason})`);
      }

      content = stripMarkdownFences(content);

      return content;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError.message.includes('circuit breaker') || lastError.message.includes('exceeded your current quota') || lastError.message.includes('RESOURCE_EXHAUSTED')) {
        throw lastError;
      }

      if (attempt === MAX_RETRIES - 1) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error('Gemini request failed after retries');
}

export function _resetForTesting(): void {
  requestTimestamps = [];
  circuitOpenUntil = 0;
  consecutiveFailures = 0;
  pendingQueue.length = 0;
  draining = false;
}

/**
 * Attempt to extract valid JSON from a potentially malformed response.
 * Handles: markdown fences, extra text around JSON, truncated JSON.
 */
function extractJSON(raw: string): string {
  let s = stripMarkdownFences(raw).trim();

  // Already valid?
  try { JSON.parse(s); return s; } catch { /* continue */ }

  // Extract first JSON object or array from the string
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  let start = -1;
  let openChar = '{';
  let closeChar = '}';

  if (objStart >= 0 && (arrStart < 0 || objStart <= arrStart)) {
    start = objStart;
  } else if (arrStart >= 0) {
    start = arrStart;
    openChar = '[';
    closeChar = ']';
  }

  if (start < 0) return s;

  // Find the matching close bracket, accounting for nesting and strings
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) { depth--; if (depth === 0) { end = i; break; } }
  }

  if (end > start) {
    const extracted = s.slice(start, end + 1);
    try { JSON.parse(extracted); return extracted; } catch { /* continue to repair */ }
  }

  // Truncated response: try to close open brackets/braces
  let truncated = end > start ? s.slice(start, end + 1) : s.slice(start);
  // Remove any trailing partial key-value or comma
  truncated = truncated.replace(/,\s*"[^"]*$/, '').replace(/,\s*$/, '');

  // Close any unclosed structures
  let opens = 0, closes = 0;
  let oArr = 0, cArr = 0;
  inString = false;
  escape = false;
  for (const ch of truncated) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') opens++;
    if (ch === '}') closes++;
    if (ch === '[') oArr++;
    if (ch === ']') cArr++;
  }

  // If inside a string, close it
  if (inString) truncated += '"';
  // Close arrays then objects
  for (let i = 0; i < oArr - cArr; i++) truncated += ']';
  for (let i = 0; i < opens - closes; i++) truncated += '}';

  try { JSON.parse(truncated); return truncated; } catch { /* give up */ }

  return s;
}

export async function chatCompletionJSON<T>(options: ChatCompletionOptions): Promise<T> {
  const raw = await chatCompletion({
    ...options,
    responseFormat: { type: 'json_object' },
  });

  // Fast path: raw is already valid JSON
  try { return JSON.parse(raw) as T; } catch { /* try extraction */ }

  // Robust extraction: strip fences, find JSON, repair truncation
  const extracted = extractJSON(raw);
  try {
    return JSON.parse(extracted) as T;
  } catch (e2) {
    console.warn(`[Gemini] JSON parse failed after extraction. Raw (300 chars): ${raw.slice(0, 300)}`);
    // Last resort: return a safe empty object
    const fallback = raw.includes('"signals"') ? '{"signals":[]}' : '{}';
    return JSON.parse(fallback) as T;
  }
}
