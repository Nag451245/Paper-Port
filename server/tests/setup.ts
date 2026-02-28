import { vi } from 'vitest';

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
    $disconnect: vi.fn(),
    $connect: vi.fn(),
  };

  return {
    getPrisma: vi.fn(() => mockPrisma),
    disconnectPrisma: vi.fn(),
    __mockPrisma: mockPrisma,
  };
});
