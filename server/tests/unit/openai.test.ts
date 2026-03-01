import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');

describe('OpenAI client', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should call OpenAI API with correct headers and body', async () => {
    const mockResponse = {
      id: 'chatcmpl-123',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as any);

    const { chatCompletion } = await import('../../src/lib/openai.js');

    const result = await chatCompletion({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result).toBe('Hello!');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: expect.stringContaining('Bearer'),
        }),
      }),
    );

    const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(callBody.model).toBe('gpt-5.2');
    expect(callBody.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('should throw on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limited'),
    } as any);

    const { chatCompletion } = await import('../../src/lib/openai.js');

    await expect(
      chatCompletion({ messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toThrow('OpenAI API error (429)');
  });

  it('should throw on empty response content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'chatcmpl-123',
          choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }),
    } as any);

    const { chatCompletion } = await import('../../src/lib/openai.js');

    await expect(
      chatCompletion({ messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toThrow('OpenAI returned empty response');
  });

  it('should request JSON format when using chatCompletionJSON', async () => {
    const mockResponse = {
      id: 'chatcmpl-123',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{"signal":"BUY","confidence":0.85}' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as any);

    const { chatCompletionJSON } = await import('../../src/lib/openai.js');

    const result = await chatCompletionJSON<{ signal: string; confidence: number }>({
      messages: [{ role: 'user', content: 'Analyze RELIANCE' }],
    });

    expect(result).toEqual({ signal: 'BUY', confidence: 0.85 });

    const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(callBody.response_format).toEqual({ type: 'json_object' });
  });

  it('should allow overriding model and temperature', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'chatcmpl-123',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Response' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    } as any);

    const { chatCompletion } = await import('../../src/lib/openai.js');

    await chatCompletion({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'gpt-4o',
      temperature: 0.2,
      maxTokens: 500,
    });

    const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(callBody.model).toBe('gpt-4o');
    expect(callBody.temperature).toBe(0.2);
    expect(callBody.max_completion_tokens).toBe(500);
  });
});
