import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';
import { expiryToDate } from '../lib/instrument.js';

const log = createChildLogger('OptionChainStore');

/**
 * Persistence and history for option chains.
 *
 * Two things depend on this existing. An options backtest needs premium/IV/OI
 * history to replay, and a genuine IV percentile needs a TIME SERIES.
 *
 * The previous "IV percentile" was computed by handing `calculateIVPercentile`
 * the IVs across strikes in the current chain, because no history existed. That
 * answers "where does ATM IV sit within today's smile", and since the wings of a
 * smile carry higher IV than ATM, the answer is a systematically low number
 * regardless of the vol regime. A premium-selling rule gated on a high IV
 * percentile would essentially never fire.
 */

/** A chain as returned by MarketDataService.getOptionsChain. */
export interface ChainLike {
  underlyingValue?: number;
  strikes?: Array<{
    strike: number;
    callLTP?: number; putLTP?: number;
    callIV?: number; putIV?: number;
    callOI?: number; putOI?: number;
    callOIChange?: number; putOIChange?: number;
    callVolume?: number; putVolume?: number;
    callBidPrice?: number; putBidPrice?: number;
    callAskPrice?: number; putAskPrice?: number;
  }>;
}

export interface IvPercentileResult {
  /** Null when there is not enough history to answer honestly. */
  percentile: number | null;
  /** How many distinct historical observations backed the answer. */
  observations: number;
  source: 'HISTORY' | 'INSUFFICIENT_HISTORY';
}

/**
 * Minimum distinct daily observations before a percentile is reported.
 *
 * Below this the number is noise dressed up as a statistic. Ten is not a
 * statistically motivated threshold, it is a floor to stop a two-day-old install
 * reporting "IV is in the 100th percentile".
 */
const MIN_IV_OBSERVATIONS = 10;

export class OptionChainStoreService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Persist one capture of a chain.
   *
   * Writes both rights per strike as separate rows. `skipDuplicates` makes a
   * retry harmless — the unique constraint on
   * (underlying, expiry, strike, optionType, capturedAt) is the real guard.
   */
  async saveSnapshot(
    underlying: string,
    expiry: Date | string,
    chain: ChainLike,
    capturedAt: Date = new Date(),
  ): Promise<{ rows: number }> {
    if (!Array.isArray(chain?.strikes) || chain.strikes.length === 0) {
      log.warn({ underlying }, 'Chain snapshot skipped — no strikes in payload');
      return { rows: 0 };
    }

    const expiryDate = expiry instanceof Date ? expiry : expiryToDate(expiry);
    const spot = Number.isFinite(Number(chain.underlyingValue)) ? Number(chain.underlyingValue) : null;

    const rows: any[] = [];
    for (const s of chain.strikes) {
      const strike = Number(s.strike);
      if (!Number.isFinite(strike) || strike <= 0) continue;

      for (const right of ['CE', 'PE'] as const) {
        const isCall = right === 'CE';
        const ltp = Number(isCall ? s.callLTP : s.putLTP);
        const iv = Number(isCall ? s.callIV : s.putIV);
        const oi = Number(isCall ? s.callOI : s.putOI);

        // A row with no price, no IV and no OI carries no information.
        if (!(ltp > 0) && !(iv > 0) && !(oi > 0)) continue;

        rows.push({
          underlying: underlying.toUpperCase(),
          expiry: expiryDate,
          strike,
          optionType: right,
          underlyingValue: spot,
          ltp: ltp > 0 ? ltp : null,
          iv: iv > 0 ? iv : null,
          oi: Number.isFinite(oi) ? BigInt(Math.trunc(oi)) : null,
          oiChange: this.toBigInt(isCall ? s.callOIChange : s.putOIChange),
          volume: this.toBigInt(isCall ? s.callVolume : s.putVolume),
          bidPrice: this.toDecimalOrNull(isCall ? s.callBidPrice : s.putBidPrice),
          askPrice: this.toDecimalOrNull(isCall ? s.callAskPrice : s.putAskPrice),
          capturedAt,
        });
      }
    }

    if (rows.length === 0) return { rows: 0 };

    const result = await this.prisma.optionChainSnapshot.createMany({
      data: rows,
      skipDuplicates: true,
    });

    log.info({ underlying, expiry: expiryDate.toISOString().slice(0, 10), rows: result.count },
      'Option chain snapshot stored');
    return { rows: result.count };
  }

  /**
   * ATM implied volatility per capture, newest first.
   *
   * ATM is the strike nearest the recorded spot for that capture, so the series
   * follows the money rather than a fixed strike — a fixed strike drifts further
   * out of the money as spot moves and its IV stops being comparable.
   */
  async getAtmIvHistory(underlying: string, days = 90): Promise<Array<{ capturedAt: Date; iv: number }>> {
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await this.prisma.optionChainSnapshot.findMany({
      where: {
        underlying: underlying.toUpperCase(),
        capturedAt: { gte: since },
        iv: { not: null },
        underlyingValue: { not: null },
      },
      select: { capturedAt: true, strike: true, iv: true, underlyingValue: true },
      orderBy: { capturedAt: 'desc' },
    });

    // Group by capture, then pick the strike closest to that capture's spot.
    const byCapture = new Map<number, { capturedAt: Date; best: { dist: number; iv: number } | null }>();
    for (const r of rows) {
      const t = r.capturedAt.getTime();
      const spot = Number(r.underlyingValue);
      const dist = Math.abs(Number(r.strike) - spot);
      const iv = Number(r.iv);
      const entry = byCapture.get(t) ?? { capturedAt: r.capturedAt, best: null };
      if (!entry.best || dist < entry.best.dist) entry.best = { dist, iv };
      byCapture.set(t, entry);
    }

    return [...byCapture.values()]
      .filter(e => e.best !== null)
      .map(e => ({ capturedAt: e.capturedAt, iv: e.best!.iv }))
      .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  }

  /**
   * Where the given IV sits within its own history, 0-100.
   *
   * Returns null rather than a number when history is too thin. A caller must be
   * able to tell "IV is low" from "we do not know yet" — conflating them is how
   * the smile-based version came to look like a working signal.
   */
  async getIvPercentile(underlying: string, currentIv: number, days = 90): Promise<IvPercentileResult> {
    if (!(currentIv > 0)) {
      return { percentile: null, observations: 0, source: 'INSUFFICIENT_HISTORY' };
    }

    const history = await this.getAtmIvHistory(underlying, days);
    if (history.length < MIN_IV_OBSERVATIONS) {
      return { percentile: null, observations: history.length, source: 'INSUFFICIENT_HISTORY' };
    }

    const below = history.filter(h => h.iv < currentIv).length;
    return {
      percentile: Math.round((below / history.length) * 100),
      observations: history.length,
      source: 'HISTORY',
    };
  }

  /** Distinct captures held for an underlying — used to report data coverage. */
  async getCoverage(underlying: string): Promise<{ captures: number; oldest: Date | null; newest: Date | null }> {
    const [oldest, newest] = await Promise.all([
      this.prisma.optionChainSnapshot.findFirst({
        where: { underlying: underlying.toUpperCase() },
        orderBy: { capturedAt: 'asc' },
        select: { capturedAt: true },
      }),
      this.prisma.optionChainSnapshot.findFirst({
        where: { underlying: underlying.toUpperCase() },
        orderBy: { capturedAt: 'desc' },
        select: { capturedAt: true },
      }),
    ]);

    const grouped = await this.prisma.optionChainSnapshot.groupBy({
      by: ['capturedAt'],
      where: { underlying: underlying.toUpperCase() },
    });

    return {
      captures: grouped.length,
      oldest: oldest?.capturedAt ?? null,
      newest: newest?.capturedAt ?? null,
    };
  }

  private toBigInt(v: unknown): bigint | null {
    const n = Number(v);
    return Number.isFinite(n) ? BigInt(Math.trunc(n)) : null;
  }

  private toDecimalOrNull(v: unknown): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
}
