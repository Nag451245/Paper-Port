import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  JWT_SECRET: z.string().min(1),
  JWT_ALGORITHM: z.string().default('HS256'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(8000),
});

describe('Config validation', () => {
  it('should validate a complete config', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'rediss://default:token@host:6379',
      OPENAI_API_KEY: 'sk-test-key',
      JWT_SECRET: 'test-secret',
      JWT_ALGORITHM: 'HS256',
      JWT_EXPIRES_IN: '24h',
      CORS_ORIGINS: 'http://localhost:5173',
      HOST: '0.0.0.0',
      PORT: '8000',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(8000);
      expect(result.data.HOST).toBe('0.0.0.0');
    }
  });

  it('should fail if DATABASE_URL is missing', () => {
    const result = envSchema.safeParse({
      JWT_SECRET: 'secret',
    });

    expect(result.success).toBe(false);
  });

  it('should fail if JWT_SECRET is missing', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://localhost/db',
    });

    expect(result.success).toBe(false);
  });

  it('should apply defaults for optional fields', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://localhost/db',
      JWT_SECRET: 'secret',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.REDIS_URL).toBe('');
      expect(result.data.OPENAI_API_KEY).toBe('');
      expect(result.data.JWT_ALGORITHM).toBe('HS256');
      expect(result.data.JWT_EXPIRES_IN).toBe('24h');
      expect(result.data.CORS_ORIGINS).toBe('http://localhost:5173');
      expect(result.data.PORT).toBe(8000);
    }
  });

  it('should coerce PORT from string to number', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://localhost/db',
      JWT_SECRET: 'secret',
      PORT: '3000',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3000);
      expect(typeof result.data.PORT).toBe('number');
    }
  });

  it('should fail if DATABASE_URL is empty string', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: '',
      JWT_SECRET: 'secret',
    });

    expect(result.success).toBe(false);
  });
});
