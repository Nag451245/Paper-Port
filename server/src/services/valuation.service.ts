/**
 * The one place a user's money is added up. Every page — Dashboard, Portfolio,
 * Risk — reads these figures, so they cannot disagree.
 *
 *   capital       what the user put in (portfolio.initialCapital)
 *   cash          free to use (portfolio.currentNav)
 *   capitalInUse  what open positions tie up: cost of what was bought outright,
 *                 margin of what was sold or is a future (lib/margin.ts)
 *   openPnl       gain or loss on open positions at the valuation price
 *   netWorth      cash + capitalInUse + openPnl
 *   totalPnl      netWorth − capital
 *   marketValue   open positions at the valuation price (bought + sold, both positive)
 *
 * Valuation price of a position, in order:
 *   1. the live feed's price, when the caller has one;
 *   2. the price saved on the position, once the market has closed (frozen:
 *      the same number on every page and every refresh until it reopens);
 *   3. a fresh quote — saved on the position for next time;
 *   4. the saved price even if old, when no quote can be had;
 *   5. the entry price (the position then shows no gain or loss) — counted in
 *      `unpriced` so the page can say so.
 * Before this, a quote that timed out simply dropped that position's gain or
 * loss from the total, so the profit changed from one refresh to the next.
 */
import { currentAccount, runAs } from '../lib/account-context.js';
import type { PrismaClient } from '@prisma/client';
import { calculateCosts, resolveInstrumentKind } from '../lib/costs.js';
import { capitalBlocked } from '../lib/margin.js';
import { MarketCalendar } from './market-calendar.js';
import { MarketDataService } from './market-data.service.js';
import { brokerAllowed, ownBrokerRequired } from '../lib/broker-access.js';
import { isOwnerWork } from '../lib/account-context.js';

export interface ValuedPosition {
  id: string;
  portfolioId: string;
  symbol: string;
  exchange: string;
  side: string;
  qty: number;
  entry: number;
  price: number;
  /** live = feed or fresh quote; saved = the price stored on the position; entry = no price could be had */
  priceSource: 'live' | 'saved' | 'entry';
  capitalInUse: number;
  marketValue: number;
  /** Gain or loss at the valuation price, before the cost of closing */
  pnl: number;
  /** Charges to close the position at the valuation price */
  exitCost: number;
  /** What opened it: empty or STRAT:/MANUAL = the user, anything else = the app */
  strategyTag: string | null;
}

export interface Valuation {
  capital: number;
  cash: number;
  capitalInUse: number;
  openPnl: number;
  netWorth: number;
  totalPnl: number;
  totalPnlPct: number;
  marketValue: number;
  positions: ValuedPosition[];
  /** Positions valued at their entry price because no price could be had */
  unpriced: number;
  asOf: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The most recent 15:30 IST on a weekday: prices saved after it are the closing prices. */
export function lastSessionClose(now = new Date()): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);
  for (let back = 0; back < 7; back++) {
    const d = new Date(ist.getTime() - back * 86_400_000);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue;
    const close = new Date(`${d.toISOString().slice(0, 10)}T15:30:00+05:30`);
    if (close <= now) return close;
  }
  return new Date(now.getTime() - 7 * 86_400_000);
}

type Quote = (symbol: string, exchange: string) => Promise<{ ltp: number }>;

export class ValuationService {
  private readonly quote: Quote;

  constructor(
    private readonly prisma: PrismaClient,
    quote?: Quote,
    private readonly marketOpen: () => boolean = () => new MarketCalendar().isMarketOpen(),
    private readonly now: () => Date = () => new Date(),
  ) {
    if (quote) this.quote = quote;
    else { const market = new MarketDataService(); this.quote = (s, ex) => market.getQuote(s, ex); }
  }

  /** Every portfolio of the user together. */
  async forUser(userId: string, live?: Record<string, number>): Promise<Valuation> {
    // Runs as the account it is for, so its market data comes from that account's own broker.
    if (currentAccount() !== userId) return runAs(userId, () => this.forUser(userId, live));
    const portfolios = await this.prisma.portfolio.findMany({ where: { userId } });
    return this.value(portfolios, live, undefined, !(await brokerAllowed(userId, this.prisma)).allowed);
  }

  /** One portfolio; pass its open positions when they are already loaded. */
  async forPortfolio(
    portfolio: { id: string; initialCapital: unknown; currentNav: unknown; userId?: string },
    live?: Record<string, number>, openPositions?: any[],
  ): Promise<Valuation> {
    if (portfolio.userId && currentAccount() !== portfolio.userId) return runAs(portfolio.userId, () => this.forPortfolio(portfolio, live, openPositions));
    const offline = portfolio.userId ? !(await brokerAllowed(portfolio.userId, this.prisma)).allowed : false;
    return this.value([portfolio], live, openPositions, offline);
  }

  private async value(
    portfolios: { id: string; initialCapital: unknown; currentNav: unknown }[],
    live: Record<string, number> = {},
    loaded?: any[],
    /** The account's own broker is not connected: no live feed and no fresh quotes, only prices already saved. */
    offline = false,
  ): Promise<Valuation> {
    // The shared live feed is priced through the owner's broker: it is used for
    // the owner's valuations only. Other accounts are priced through their own.
    if (offline || (ownBrokerRequired() && !(await isOwnerWork()))) live = {};
    const capital = portfolios.reduce((s, p) => s + Number(p.initialCapital), 0);
    const cash = portfolios.reduce((s, p) => s + Number(p.currentNav), 0);
    const open: any[] = loaded ?? (portfolios.length
      ? await this.prisma.position.findMany({ where: { portfolioId: { in: portfolios.map((p) => p.id) }, status: 'OPEN' } })
      : []);

    const isOpen = this.marketOpen();
    const now = this.now();
    const closedAt = lastSessionClose(now);
    const prices = new Map<any, { price: number; source: ValuedPosition['priceSource'] }>();
    const toFetch: any[] = [];
    for (const p of open ?? []) {
      const saved = p.lastPrice != null ? Number(p.lastPrice) : 0;
      const savedAt: Date | null = p.lastPriceAt ?? null;
      if (live[p.symbol] > 0) prices.set(p, { price: live[p.symbol], source: 'live' });
      else if (!isOpen && saved > 0 && savedAt && savedAt >= closedAt) prices.set(p, { price: saved, source: 'saved' });
      else toFetch.push(p);
    }

    // One quote per symbol, all at once, each with a time limit.
    const symbols = new Map<string, string>();
    for (const p of toFetch) symbols.set(p.symbol, p.exchange ?? 'NSE');
    const fetched = new Map<string, number>();
    if (!offline) await Promise.all([...symbols].map(async ([symbol, exchange]) => {
      try {
        const q = await Promise.race([
          this.quote(symbol, exchange),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
        ]);
        if (Number(q.ltp) > 0) fetched.set(symbol, Number(q.ltp));
      } catch { /* falls back to the saved price below */ }
    }));

    const toSave: { id: string; price: number }[] = [];
    for (const p of toFetch) {
      const fresh = fetched.get(p.symbol);
      const saved = p.lastPrice != null ? Number(p.lastPrice) : 0;
      if (fresh) {
        prices.set(p, { price: fresh, source: 'live' });
        const age = p.lastPriceAt ? now.getTime() - new Date(p.lastPriceAt).getTime() : Infinity;
        if (p.id && (age > 60_000 || saved !== fresh)) toSave.push({ id: p.id, price: fresh });
      } else if (saved > 0) prices.set(p, { price: saved, source: 'saved' });
      else prices.set(p, { price: Number(p.avgEntryPrice), source: 'entry' });
    }
    // Live-feed prices are saved too (at most once a minute), so the close is on record.
    for (const p of open ?? []) {
      const v = prices.get(p)!;
      if (v.source !== 'live' || toSave.some((s) => s.id === p.id)) continue;
      const age = p.lastPriceAt ? now.getTime() - new Date(p.lastPriceAt).getTime() : Infinity;
      if (p.id && age > 60_000) toSave.push({ id: p.id, price: v.price });
    }
    await Promise.allSettled(toSave.map(async (s) =>
      this.prisma.position.update({ where: { id: s.id }, data: { lastPrice: s.price, lastPriceAt: now } })));

    const positions: ValuedPosition[] = (open ?? []).map((p) => {
      const entry = Number(p.avgEntryPrice);
      const { price, source } = prices.get(p)!;
      const exchange = p.exchange ?? 'NSE';
      return {
        id: p.id, portfolioId: p.portfolioId, symbol: p.symbol, exchange, side: p.side, qty: p.qty, entry,
        price, priceSource: source, strategyTag: p.strategyTag ?? null,
        capitalInUse: r2(capitalBlocked(p)),
        marketValue: r2(price * p.qty),
        pnl: r2((p.side === 'SHORT' ? entry - price : price - entry) * p.qty),
        exitCost: source === 'entry' ? 0
          : calculateCosts(p.qty, price, p.side === 'SHORT' ? 'BUY' : 'SELL', exchange, resolveInstrumentKind(exchange, p.symbol)).totalCost,
      };
    });

    const capitalInUse = positions.reduce((s, p) => s + p.capitalInUse, 0);
    const openPnl = positions.reduce((s, p) => s + p.pnl, 0);
    const netWorth = cash + capitalInUse + openPnl;
    return {
      capital: r2(capital),
      cash: r2(cash),
      capitalInUse: r2(capitalInUse),
      openPnl: r2(openPnl),
      netWorth: r2(netWorth),
      totalPnl: r2(netWorth - capital),
      totalPnlPct: capital > 0 ? r2(((netWorth - capital) / capital) * 100) : 0,
      marketValue: r2(positions.reduce((s, p) => s + p.marketValue, 0)),
      positions,
      unpriced: positions.filter((p) => p.priceSource === 'entry').length,
      asOf: now.toISOString(),
    };
  }
}
