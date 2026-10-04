import { describe, it, expect, vi } from 'vitest';

// The market is closed, so positions are valued at the price saved on them: no lookups.
vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: class { isMarketOpen() { return false; } isHoliday() { return false; } },
}));

import { AIAgentService } from '../../src/services/ai-agent.service.js';

const now = new Date();
const portfolio = { id: 'pf', userId: 'u1', initialCapital: 1_000_000, currentNav: 600_000 };
// ₹4,00,000 is in two shares, both exactly at cost: nothing has been lost.
const positions = [
  { id: 'a', portfolioId: 'pf', symbol: 'AAA', exchange: 'NSE', side: 'LONG', status: 'OPEN', qty: 100, avgEntryPrice: 1000, lastPrice: 1000, lastPriceAt: now },
  { id: 'b', portfolioId: 'pf', symbol: 'BBB', exchange: 'NSE', side: 'LONG', status: 'OPEN', qty: 100, avgEntryPrice: 3000, lastPrice: 3000, lastPriceAt: now },
];
const prisma: any = {
  portfolio: { findFirst: vi.fn(async () => portfolio), findMany: vi.fn(async () => [portfolio]) },
  position: { findMany: vi.fn(async () => positions), update: vi.fn(async () => ({})) },
  trade: { findMany: vi.fn(async () => []) },
  dailyPnlRecord: { findMany: vi.fn(async () => []) },
};

describe('AI agent capital rules use the shared valuation', () => {
  it('money held in positions is capital in use, not a drawdown', async () => {
    const rules = await new AIAgentService(prisma).getCapitalRules('u1');
    const rule = (id: string) => rules.find((r) => r.id === id)!;

    // Net worth = ₹6,00,000 cash + ₹4,00,000 in positions = capital: no drawdown.
    // (Free cash used to stand in for net worth, which read as a 40% drawdown.)
    expect(rule('drawdown-circuit')).toMatchObject({ status: 'green', detail: 'Net worth is 0.00% below capital' });
    expect(rule('exposure').detail).toBe('40% of capital in use across 2 positions');
    expect(rule('position-sizing').detail).toBe('Largest position: 30.0% of net worth');
    // Nothing invented: no Sharpe ratio from a handful of open positions, no always-green Greeks line.
    expect(rules.map((r) => r.id)).not.toContain('sharpe-ratio');
    expect(rules.map((r) => r.id)).not.toContain('fno-greeks-limit');
  });
});
