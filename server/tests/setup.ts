import { vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Saved market data (candle lake, option prices, FII/DII history) goes to a
// throwaway folder, never the developer's real one.
if (!process.env.MARKET_DATA_DIR) process.env.MARKET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-data-'));

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = '';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.BREEZE_API_KEY = 'test-breeze-key';
process.env.BREEZE_SECRET_KEY = 'test-breeze-secret';
process.env.BREEZE_SESSION_TOKEN = 'test-session';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes';
process.env.JWT_ALGORITHM = 'HS256';
process.env.JWT_EXPIRES_IN = '24h';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.HOST = '0.0.0.0';
process.env.PORT = '8000';

// Account checks (blocked / deleted / pending / password changed / admin role)
// read the users table on every request. Tests mock the database, so by default
// every signed-in test user is an ACTIVE, non-admin account; set
// globalThis.__testAccount to change that. tests/unit/account-access.test.ts
// exercises the real module.
vi.mock('../src/lib/token-revocation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/token-revocation.js')>();
  const acct = () => (globalThis as any).__testAccount ?? { problem: null, role: 'LEARNER' };
  return {
    ...actual,
    sessionProblem: vi.fn(async () => acct().problem),
    accountRole: vi.fn(async () => acct().role),
  };
});

vi.mock('../src/lib/prisma.js', () => {
  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    breezeCredential: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    portfolio: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    position: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    trade: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    watchlist: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    watchlistItem: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    aITradeSignal: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    riskEvent: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    dailyPnlRecord: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    decisionAudit: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    strategyLedger: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    strategyParam: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    $disconnect: vi.fn(),
    $connect: vi.fn(),
  };

  return {
    getPrisma: vi.fn(() => mockPrisma),
    disconnectPrisma: vi.fn(),
    __mockPrisma: mockPrisma,
  };
});
