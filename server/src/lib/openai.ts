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

export async function chatCompletion(options: ChatCompletionOptions): Promise<string> {
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

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
  }

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
}

export async function chatCompletionJSON<T>(options: ChatCompletionOptions): Promise<T> {
  const content = await chatCompletion({
    ...options,
    responseFormat: { type: 'json_object' },
  });
  return JSON.parse(content) as T;
}
