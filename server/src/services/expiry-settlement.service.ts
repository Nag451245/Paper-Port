/**
 * Settlement of options that have expired while still open.
 *
 * At a broker an option held past its last trading minute is not left open: it
 * is settled at what it is worth at expiry. In the money, that is the difference
 * between the underlying's closing value on the expiry day and the strike; out
 * of the money, nothing. The 15:15 sweep on expiry day closes positions at the
 * market price when it has one; this settles whatever is left (no price that
 * day, the app was down, a holiday), on the day or on any later day.
 *
 * A position is settled only when the underlying's close for its own expiry day
 * is known. Without it the position is reported and left alone: a made-up
 * settlement price would be a made-up profit or loss.
 */
import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';
import { parseInstrumentSymbol } from '../lib/instrument.js';
import { runAs } from '../lib/account-context.js';

const log = createChildLogger('ExpirySettlement');
const r2 = (n: number) => Math.round(n * 100) / 100;

/** What one unit of the option is worth at expiry. */
export function intrinsicAtExpiry(optionType: 'CE' | 'PE', strike: number, settle: number): number {
  return r2(Math.max(0, optionType === 'CE' ? settle - strike : strike - settle));
}

export interface SettlementResult {
  settled: { symbol: string; userId: string; side: string; qty: number; settle: number; price: number }[];
  waiting: { symbol: string; why: string }[];
}

type Close = (positionId: string, userId: string, exitPrice: number) => Promise<unknown>;
/** The underlying's closing value on `day` (YYYY-MM-DD, IST), or null when it is not known. */
type DailyClose = (underlying: string, day: string) => Promise<number | null>;

export class ExpirySettlementService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly close: Close,
    private readonly dailyClose: DailyClose,
  ) {}

  async settleExpired(now: Date = new Date()): Promise<SettlementResult> {
    const out: SettlementResult = { settled: [], waiting: [] };
    // Expiry is stored at IST midnight of the expiry day; trading ends at 15:30.
    // Anything whose expiry day began more than 15.5 hours ago has stopped trading.
    const stopped = new Date(now.getTime() - 15.5 * 3_600_000);
    const rows = await this.prisma.position.findMany({
      where: { status: 'OPEN', expiry: { lte: stopped } },
      include: { portfolio: { select: { userId: true } } },
    });
    if (!rows?.length) return out;

    const closes = new Map<string, Promise<number | null>>();
    const closeOn = (underlying: string, day: string) => {
      const key = `${underlying}|${day}`;
      if (!closes.has(key)) closes.set(key, this.dailyClose(underlying, day).catch(() => null));
      return closes.get(key)!;
    };

    // Sold legs first: a bought option that protects a sold one must not be
    // taken away while the sold one is still open.
    const ordered = [...rows].sort((a, b) => Number(b.side === 'SHORT') - Number(a.side === 'SHORT'));
    for (const p of ordered) {
      let spec: ReturnType<typeof parseInstrumentSymbol> | null = null;
      try { spec = parseInstrumentSymbol(p.symbol, p.exchange ?? undefined); } catch { /* described by its columns */ }
      const type = String((p as any).instrumentType ?? spec?.instrumentType ?? '').toUpperCase();
      const optionType = ((p as any).optionType ?? spec?.optionType ?? null) as 'CE' | 'PE' | null;
      const strike = (p as any).strike != null ? Number((p as any).strike) : spec?.strike ?? null;
      const underlying = ((p as any).underlying ?? spec?.underlying ?? '') as string;
      const expiry = ((p as any).expiry ?? spec?.expiry ?? null) as Date | null;
      if (type !== 'OPTIONS' || !optionType || !strike || !underlying || !expiry) {
        // Futures settle at the underlying's close too, but their margin is
        // released differently; they are left for a person rather than guessed.
        out.waiting.push({ symbol: p.symbol, why: 'not an option: settle it by hand' });
        continue;
      }
      const day = new Date(expiry.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
      const settle = await closeOn(underlying, day);
      if (!settle || !(settle > 0)) {
        out.waiting.push({ symbol: p.symbol, why: `no closing value for ${underlying} on ${day} yet` });
        continue;
      }
      const price = intrinsicAtExpiry(optionType, strike, settle);
      const userId = p.portfolio.userId;
      try {
        await runAs(userId, () => this.close(p.id, userId, price));
        out.settled.push({ symbol: p.symbol, userId, side: p.side, qty: p.qty, settle, price });
        log.info({ symbol: p.symbol, side: p.side, qty: p.qty, settle, price }, 'Expired option settled');
      } catch (err) {
        out.waiting.push({ symbol: p.symbol, why: `could not be closed: ${(err as Error).message}` });
      }
    }
    if (out.waiting.length) log.warn({ waiting: out.waiting.slice(0, 20) }, 'Expired positions not settled');
    return out;
  }
}
