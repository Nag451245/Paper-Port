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

interface OpenAIChoice {
  index: number;
  message: { role: string; content: string | null };
  finish_reason: string;
}

interface OpenAIResponse {
  id: string;
  choices: OpenAIChoice[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-5.2';

// ── Rate Limiter: queues requests so we never exceed RPM ──

const MAX_RPM = 8;
const WINDOW_MS = 60_000;
const MAX_RETRIES = 3;
const CIRCUIT_OPEN_MS = 5 * 60_000;

let requestTimestamps: number[] = [];
let circuitOpenUntil = 0;
let consecutiveFailures = 0;
const pendingQueue: Array<{
  resolve: () => void;
}> = [];
let draining = false;

function isCircuitOpen(): boolean {
  if (circuitOpenUntil > 0 && Date.now() < circuitOpenUntil) return true;
  if (circuitOpenUntil > 0 && Date.now() >= circuitOpenUntil) {
    circuitOpenUntil = 0;
    consecutiveFailures = 0;
    console.log('[OpenAI] Circuit breaker reset — resuming API calls');
  }
  return false;
}

function openCircuit(retryAfterSec?: number): void {
  const cooldownMs = retryAfterSec
    ? retryAfterSec * 1000
    : CIRCUIT_OPEN_MS;
  circuitOpenUntil = Date.now() + cooldownMs;
  console.warn(`[OpenAI] Circuit breaker OPEN for ${Math.round(cooldownMs / 1000)}s — quota/rate limit hit`);
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

export async function chatCompletion(options: ChatCompletionOptions): Promise<string> {
  if (isCircuitOpen()) {
    const remaining = Math.round((circuitOpenUntil - Date.now()) / 1000);
    throw new Error(`OpenAI circuit breaker open — cooling down for ${remaining}s. Quota/rate limit was exceeded.`);
  }

  const { messages, model = DEFAULT_MODEL, temperature = 0.7, maxTokens = 2048, responseFormat } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_completion_tokens: maxTokens,
  };

  if (responseFormat) {
    body.response_format = responseFormat;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0 && isCircuitOpen()) {
      throw lastError ?? new Error('OpenAI circuit breaker opened during retry');
    }

    await acquireSlot();

    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 45_000);
      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (response.status === 429) {
        const errorBody = await response.text();
        consecutiveFailures++;

        const retryAfterHeader = response.headers?.get?.('retry-after') ?? null;
        const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

        if (consecutiveFailures >= 3 || errorBody.includes('exceeded your current quota')) {
          openCircuit(retryAfterSec);
          throw new Error(`OpenAI API error (429): ${errorBody}`);
        }

        const backoffMs = retryAfterSec
          ? retryAfterSec * 1000
          : Math.min(2000 * Math.pow(2, attempt), 30_000);
        console.warn(`[OpenAI] Rate limited (attempt ${attempt + 1}/${MAX_RETRIES}), backing off ${Math.round(backoffMs / 1000)}s`);
        await sleep(backoffMs);
        lastError = new Error(`OpenAI API error (429): ${errorBody}`);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
      }

      consecutiveFailures = 0;

      const data = (await response.json()) as OpenAIResponse;
      const choice = data.choices[0];
      const content = choice?.message?.content;
      const finishReason = choice?.finish_reason;

      if (!content) {
        if (finishReason === 'length') {
          throw new Error('OpenAI response truncated (token limit too low)');
        }
        throw new Error(`OpenAI returned empty response (finish_reason: ${finishReason})`);
      }

      return content;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError.message.includes('circuit breaker') || lastError.message.includes('exceeded your current quota')) {
        throw lastError;
      }

      if (attempt === MAX_RETRIES - 1) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error('OpenAI request failed after retries');
}

export function _resetForTesting(): void {
  requestTimestamps = [];
  circuitOpenUntil = 0;
  consecutiveFailures = 0;
  pendingQueue.length = 0;
  draining = false;
}

export async function chatCompletionJSON<T>(options: ChatCompletionOptions): Promise<T> {
  const content = await chatCompletion({
    ...options,
    responseFormat: { type: 'json_object' },
  });
  return JSON.parse(content) as T;
}
