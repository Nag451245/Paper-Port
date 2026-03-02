import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');

describe('Gemini AI client', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const mod = await import('../../src/lib/openai.js');
    mod._resetForTesting();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should call Gemini API with correct URL and body structure', async () => {
    const mockResponse = {
      candidates: [{
        content: { parts: [{ text: 'Hello!' }], role: 'model' },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockResponse),
    } as any);

    const { chatCompletion } = await import('../../src/lib/openai.js');

    const result = await chatCompletion({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result).toBe('Hello!');

    const calledUrl = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain('generativelanguage.googleapis.com');
    expect(calledUrl).toContain('gemini-2.5-flash');
    expect(calledUrl).toContain('key=test-gemini-key');

    const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(callBody.contents).toBeDefined();
    expect(callBody.contents[0].role).toBe('user');
    expect(callBody.contents[0].parts[0].text).toBe('Hi');
    expect(callBody.generationConfig).toBeDefined();
  });

  it('should convert system messages to systemInstruction', async () => {
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: 'Response' }], role: 'model' }, finishReason: 'STOP' }],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve(mockResponse),
    } as any);

    const { chatCompletion } = await import('../../src/lib/openai.js');

    await chatCompletion({
      messages: [
        { role: 'system', content: 'You are a trading bot' },
        { role: 'user', content: 'Analyze RELIANCE' },
      ],
    });

    const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(callBody.systemInstruction).toBeDefined();
    expect(callBody.systemInstruction.parts[0].text).toBe('You are a trading bot');
    expect(callBody.contents[0].role).toBe('user');
  });

  it('should throw on quota exceeded (429) and open circuit breaker', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('{"error":{"message":"You exceeded your current quota"}}'),
      headers: { get: () => null },
    } as any);

    const { chatCompletion } = await import('../../src/lib/openai.js');

    await expect(
      chatCompletion({ messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toThrow('Gemini API error (429)');
  });

  it('should throw on empty response content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }],
      }),
    } as any);

    const { chatCompletion } = await import('../../src/lib/openai.js');

    await expect(
      chatCompletion({ messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toThrow('Gemini returned empty response');
  });

  it('should request JSON format when using chatCompletionJSON', async () => {
    const mockResponse = {
      candidates: [{
        content: { parts: [{ text: '{"signal":"BUY","confidence":0.85}' }], role: 'model' },
        finishReason: 'STOP',
      }],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve(mockResponse),
    } as any);

    const { chatCompletionJSON } = await import('../../src/lib/openai.js');

    const result = await chatCompletionJSON<{ signal: string; confidence: number }>({
      messages: [{ role: 'user', content: 'Analyze RELIANCE' }],
    });

    expect(result).toEqual({ signal: 'BUY', confidence: 0.85 });

    const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(callBody.generationConfig.responseMimeType).toBe('application/json');
  });
});
