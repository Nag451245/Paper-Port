import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenvConfig({ path: resolve(__dirname, '..', '.env') });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().default(''),
  REDIS_URL: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  BREEZE_API_KEY: z.string().default(''),
  BREEZE_SECRET_KEY: z.string().default(''),
  BREEZE_SESSION_TOKEN: z.string().default(''),
  JWT_SECRET: z.string().min(1),
  JWT_ALGORITHM: z.string().default('HS256'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  ENCRYPTION_KEY: z.string().min(1).default(''),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z.string().default('development'),
  NEWS_API_KEY: z.string().default(''),
  GNEWS_API_KEY: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

function loadConfig(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.flatten().fieldErrors;
    const missing = Object.entries(formatted)
      .map(([key, errs]) => `  ${key}: ${errs?.join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${missing}`);
  }
  return parsed.data;
}

export const env = loadConfig();
