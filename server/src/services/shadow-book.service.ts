/**
 * The shadow book: every signal the Rust engine raises in the automated scans
 * is recorded as the trade it would have been, and settled on live 5-minute
 * candles with costs (lib/shadow-math.ts). It never places orders. Its job is
 * to answer, per strategy, "does this actually make money after costs?" on the
 * same intraday horizon the bots trade.
 *
 * One trade per strategy, stock, side and day: the bots re-scan every 30
 * seconds, and counting each repeat as a new trade would fake the evidence.
 *
 * The evidence gate reads the verdicts. EVIDENCE_GATE=label (default) only
 * labels trades from unproven strategies; EVIDENCE_GATE=enforce stops the bots
 * from auto-executing them (they are still recorded here).
 */
import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';
import { istDateStr } from '../lib/ist.js';
import { isDerivativeSymbol } from '../lib/instrument.js';
import { sessionFraction } from '../lib/alert-math.js';
import { evidenceFor, settle, type Bar, type StrategyEvidence } from '../lib/shadow-math.js';
import type { ScanSignal } from '../lib/rust-engine.js';
import { MarketDataService } from './market-data.service.js';

const log = createChildLogger('ShadowBook');

const INDICES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'INDIAVIX', 'INDIA VIX']);
/** No new shadow entries after 15:00 IST: too little session left before the 15:15 square-off. */
const LAST_ENTRY_FRACTION = (15 * 60 - (9 * 60 + 15)) / 375;

export type GateMode = 'label' | 'enforce';
export const gateMode = (): GateMode => (process.env.EVIDENCE_GATE === 'enforce' ? 'enforce' : 'label');

/** The strategy name a signal is filed under. */
export const strategyOf = (sig: Pick<ScanSignal, 'strategy'>) => sig.strategy || 'composite';

export class ShadowBook {
  /** "strategy|symbol|side|day" keys already recorded, so 30-second repeats skip the database. */
  private seen = new Set<string>();
  private seenDay = '';
  private verdicts = new Map<string, StrategyEvidence>();
  private verdictsAt = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly market: Pick<MarketDataService, 'getHistory'> = new MarketDataService(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Record what the engine just signalled. Safe to call on every scan. */
  async record(signals: ScanSignal[]): Promise<number> {
    const now = this.now();
    const f = sessionFraction(now);
    if (f <= 0 || f >= LAST_ENTRY_FRACTION) return 0;
    const day = istDateStr(now);
    if (day !== this.seenDay) { this.seen.clear(); this.seenDay = day; }
    let added = 0;
    for (const sig of signals) {
      const symbol = sig.symbol?.toUpperCase();
      const stopDist = Math.abs(sig.entry - sig.stop_loss), targetDist = Math.abs(sig.target - sig.entry);
      if (!symbol || INDICES.has(symbol) || isDerivativeSymbol(symbol)) continue;
      if ((sig.direction !== 'BUY' && sig.direction !== 'SELL') || !(sig.entry > 0) || !(stopDist > 0) || !(targetDist > 0)) continue;
      const strategy = strategyOf(sig);
      if (strategy.startsWith('expiry_')) continue;                          // option strategies: not an equity trade
      const key = `${strategy}|${symbol}|${sig.direction}|${day}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      try {
        await this.prisma.shadowTrade.create({
          data: {
            strategy, symbol, side: sig.direction, day, signalAt: now, signalPrice: sig.entry,
            stopDist, targetDist, confidence: sig.confidence,
          },
        });
        added++;
      } catch (err: any) {
        if (err?.code !== 'P2002') log.warn({ err: err?.message, key }, 'Could not record shadow trade');   // P2002: already recorded (restart)
      }
    }
    return added;
  }

  /** Settle open trades against today's candles. `final` after the close voids what has no data. */
  async settleOpen(final = false): Promise<{ closed: number; voided: number; open: number }> {
    const now = this.now();
    const today = istDateStr(now);
    const open = await this.prisma.shadowTrade.findMany({ where: { status: 'OPEN' } });
    const bySymbolDay = new Map<string, typeof open>();
    for (const t of open) {
      const k = `${t.symbol}|${t.day}`;
      bySymbolDay.set(k, [...(bySymbolDay.get(k) ?? []), t]);
    }
    let closed = 0, voided = 0, stillOpen = 0;
    for (const [k, trades] of bySymbolDay) {
      const [symbol, day] = k.split('|');
      const dayOver = day < today || final || sessionFraction(now) >= 1;
      const bars = await this.market.getHistory(symbol, '5minute', day, day).catch(() => [] as Bar[]);
      const dayBars = (bars as Bar[]).filter((b) => b.timestamp.slice(0, 10) === day);
      for (const t of trades) {
        const s = settle({ side: t.side as 'BUY' | 'SELL', signalAt: t.signalAt, stopDist: t.stopDist, targetDist: t.targetDist }, dayBars, dayOver);
        if (s.status === 'OPEN') {
          stillOpen++;
          if (s.entry !== undefined && t.entry === null) {
            await this.prisma.shadowTrade.update({ where: { id: t.id }, data: { entry: s.entry, entryAt: s.entryAt } });
          }
          continue;
        }
        if (s.status === 'VOID') voided++; else closed++;
        await this.prisma.shadowTrade.update({ where: { id: t.id }, data: s });
      }
    }
    if (closed || voided) { this.verdictsAt = 0; log.info({ closed, voided, open: stillOpen }, 'Shadow trades settled'); }
    return { closed, voided, open: stillOpen };
  }

  /** Each strategy's record so far, best evidence first. */
  async evidence(): Promise<StrategyEvidence[]> {
    if (Date.now() - this.verdictsAt < 5 * 60_000 && this.verdicts.size) return [...this.verdicts.values()];
    const rows = await this.prisma.shadowTrade.findMany({
      where: { status: 'CLOSED' },
      select: { strategy: true, rMultiple: true, netReturn: true },
    });
    const by = new Map<string, { r: number; net: number }[]>();
    for (const r of rows) {
      // Pair legs are one strategy family for the verdict.
      const s = r.strategy.startsWith('pairs:') ? 'pairs' : r.strategy;
      by.set(s, [...(by.get(s) ?? []), { r: r.rMultiple ?? 0, net: r.netReturn ?? 0 }]);
    }
    this.verdicts = new Map([...by].map(([s, results]) => [s, evidenceFor(s, results)]));
    this.verdictsAt = Date.now();
    return [...this.verdicts.values()].sort((a, b) => b.tStat - a.tStat);
  }

  /** True only for strategies whose shadow record proves an edge. */
  async isProven(strategy: string): Promise<boolean> {
    const s = strategy.startsWith('pairs:') ? 'pairs' : strategy;
    return (await this.evidence()).some((e) => e.strategy === s && e.verdict === 'proven');
  }
}

let shared: ShadowBook | null = null;
export function getShadowBook(prisma: PrismaClient): ShadowBook {
  shared ??= new ShadowBook(prisma);
  return shared;
}
