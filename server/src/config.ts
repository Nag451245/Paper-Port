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
  GEMINI_API_KEY: z.string().default(''),
  BREEZE_API_KEY: z.string().default(''),
  BREEZE_SECRET_KEY: z.string().default(''),
  BREEZE_SESSION_TOKEN: z.string().default(''),
  // ICICI Direct login used for the automatic daily Breeze session. These live
  // ONLY in server/.env on the machine that runs the app. No web page collects
  // them: a form asking for a bank login and 2FA secret on this site is what got
  // it flagged as phishing, and it put the whole trading account one database
  // leak away from takeover.
  BREEZE_LOGIN_ID: z.string().default(''),
  BREEZE_LOGIN_PASSWORD: z.string().default(''),
  BREEZE_TOTP_SECRET: z.string().default(''),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters for security'),
  JWT_ALGORITHM: z.string().default('HS256'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  ENCRYPTION_KEY: z.string().min(16, 'ENCRYPTION_KEY must be at least 16 characters'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_MAX: z.coerce.number().default(600),
  // Refuse to run automated trading unless a Redis leader lease can be held.
  // Recommended in any environment that might run more than one instance.
  REQUIRE_LEADER_LOCK: z.coerce.boolean().default(false),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z.string().default('development'),
  NEWS_API_KEY: z.string().default(''),
  GNEWS_API_KEY: z.string().default(''),
  ML_SERVICE_URL: z.string().url().default('http://localhost:8002'),
  BREEZE_BRIDGE_URL: z.string().url().default('http://127.0.0.1:8001'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRADING_MODE: z.enum(['PAPER', 'LIVE']).default('PAPER'),
  RUST_ENGINE_URL: z.string().default('http://127.0.0.1:8400'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
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
