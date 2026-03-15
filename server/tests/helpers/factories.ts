import { vi } from 'vitest';

// ── IST Timezone Helpers ──────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function toIST(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

export function todayStartIST(): Date {
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

export function istDate(year: number, month: number, day: number, h = 0, m = 0): Date {
  const utc = Date.UTC(year, month - 1, day, h, m) - IST_OFFSET_MS;
  return new Date(utc);
}

export function marketHoursIST(date?: Date): Date {
  const base = date ?? new Date();
  const ist = toIST(base);
  ist.setUTCHours(10, 30, 0, 0); // 10:30 IST = well within 9:15–15:30
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

// ── Entity Factories ──────────────────────────────────────────────────

let idCounter = 0;
function nextId(prefix = 'test'): string {
  return `${prefix}-${++idCounter}-${Date.now().toString(36)}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

export function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId('user'),
    email: 'trader@test.com',
    fullName: 'Test Trader',
    passwordHash: '$2a$10$fake',
    riskAppetite: 'MODERATE',
    virtualCapital: 1_000_000,
    role: 'LEARNER',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makePortfolio(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId('portfolio'),
    userId: nextId('user'),
    name: 'Default Portfolio',
    initialCapital: 1_000_000,
    currentNav: 1_000_000,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId('position'),
    portfolioId: nextId('portfolio'),
    symbol: 'RELIANCE',
    exchange: 'NSE',
    side: 'LONG',
    qty: 10,
    avgEntryPrice: 2500,
    stopLoss: 2450,
    target: 2600,
    status: 'OPEN',
    strategyTag: 'AI_AGENT',
    unrealizedPnl: 0,
    realizedPnl: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId('order'),
    portfolioId: nextId('portfolio'),
    symbol: 'RELIANCE',
    exchange: 'NSE',
    side: 'BUY',
    orderType: 'MARKET',
    qty: 10,
    price: 2500,
    filledQty: 0,
    avgFillPrice: null,
    idealPrice: 2500,
    status: 'PENDING',
    strategyTag: 'AI_AGENT',
    source: 'AI',
    slippageBps: null,
    filledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeTrade(overrides: Record<string, unknown> = {}) {
  const entryPrice = (overrides.entryPrice as number) ?? 2500;
  const exitPrice = (overrides.exitPrice as number) ?? 2550;
  const qty = (overrides.qty as number) ?? 10;
  const grossPnl = (exitPrice - entryPrice) * qty;
  const totalCosts = grossPnl * 0.001; // ~0.1% costs
  const netPnl = grossPnl - Math.abs(totalCosts);

  return {
    id: nextId('trade'),
    portfolioId: nextId('portfolio'),
    symbol: 'RELIANCE',
    exchange: 'NSE',
    side: 'BUY',
    qty,
    entryPrice,
    exitPrice,
    grossPnl,
    totalCosts: Math.abs(totalCosts),
    netPnl,
    entryTime: new Date(Date.now() - 3600_000),
    exitTime: new Date(),
    strategyTag: 'AI_AGENT',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeDailyPnlRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId('pnl'),
    userId: nextId('user'),
    date: todayStartIST(),
    grossPnl: 5000,
    netPnl: 4500,
    tradeCount: 5,
    winCount: 3,
    lossCount: 2,
    status: 'PROFIT',
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Batch Factories ───────────────────────────────────────────────────

export function makeLosingStreak(count: number, portfolioId: string, exitTimeBase?: Date) {
  const base = exitTimeBase ?? new Date();
  return Array.from({ length: count }, (_, i) =>
    makeTrade({
      portfolioId,
      entryPrice: 2500,
      exitPrice: 2480,
      netPnl: -200,
      exitTime: new Date(base.getTime() - (count - i) * 60_000),
    }),
  );
}

export function makeWinningStreak(count: number, portfolioId: string, exitTimeBase?: Date) {
  const base = exitTimeBase ?? new Date();
  return Array.from({ length: count }, (_, i) =>
    makeTrade({
      portfolioId,
      entryPrice: 2500,
      exitPrice: 2550,
      netPnl: 500,
      exitTime: new Date(base.getTime() - (count - i) * 60_000),
    }),
  );
}

export function makeConsecutiveLosingDays(count: number, userId: string) {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - i);
    return makeDailyPnlRecord({
      userId,
      date,
      netPnl: -500,
      status: 'LOSS',
    });
  });
}

// ── Mock Prisma Factory ───────────────────────────────────────────────

export function createMockPrisma() {
  const prisma: any = {
    user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    portfolio: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    position: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    order: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    trade: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    watchlist: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    watchlistItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    aIAgentConfig: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    aITradeSignal: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
    tradingTarget: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    dailyPnlRecord: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    riskEvent: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    decisionAudit: { create: vi.fn() },
    strategyLedger: { findMany: vi.fn(), upsert: vi.fn() },
    strategyParam: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(prisma)),
    $disconnect: vi.fn(),
    $connect: vi.fn(),
  };
  return prisma;
}
