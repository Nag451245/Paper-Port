/**
 * Live side of the pattern search: at each checkpoint, checks every stock for
 * the patterns the search promoted (<MARKET_DATA_DIR>/patterns.json) and sends
 * matches to the shadow book as strategy "pattern:<id>". Shadow only; with no
 * promoted patterns it does nothing at all.
 *
 * Conditions are computed by lib/intraday-patterns.ts, the same code the
 * search used, from completed candles only.
 */
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '../lib/logger.js';
import { istDateStr, istDaysAgo } from '../lib/ist.js';
import { barInstant } from '../lib/bar-time.js';
import { lakeDir, readBars } from '../lib/candle-lake.js';
import {
  CHECKPOINTS, buildContext, byDay, featuresAt, patternMask, type Checkpoint, type PatternSpec,
} from '../lib/intraday-patterns.js';
import type { ScanSignal } from '../lib/rust-engine.js';
import type { HistoricalBar, MarketDataService } from './market-data.service.js';
import type { ShadowBook } from './shadow-book.service.js';
import { loadUniverse } from './candle-lake-sync.service.js';

const log = createChildLogger('PatternScanner');
const CONCURRENCY = 4;

export class PatternScanner {
  private loaded: { mtime: number; patterns: PatternSpec[] } = { mtime: -1, patterns: [] };

  constructor(
    private readonly market: Pick<MarketDataService, 'getHistory'>,
    private readonly shadow: Pick<ShadowBook, 'record'>,
    private readonly universe: () => string[] = loadUniverse,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Promoted patterns, re-read whenever the search writes a new file. */
  promoted(): PatternSpec[] {
    const file = path.join(lakeDir(), 'patterns.json');
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime !== this.loaded.mtime) {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.loaded = { mtime, patterns: (doc.promoted ?? []).map((p: PatternSpec) => ({ id: p.id, checkpoint: p.checkpoint, side: p.side, conditions: p.conditions })) };
      }
    } catch {
      this.loaded = { mtime: -1, patterns: [] };
    }
    return this.loaded.patterns;
  }

  /** Completed 5-minute candles today (a candle counts once its 5 minutes are over). */
  private async today(symbol: string): Promise<HistoricalBar[]> {
    const day = istDateStr(this.now()), t = this.now().getTime();
    const bars = await this.market.getHistory(symbol, '5minute', day, day).catch(() => []);
    return (bars ?? []).filter((b) => b.timestamp.slice(0, 10) === day && barInstant(b.timestamp) + 5 * 60_000 <= t);
  }

  async run(checkpoint: Checkpoint): Promise<number> {
    const patterns = this.promoted().filter((p) => p.checkpoint === checkpoint);
    if (!patterns.length) return 0;
    const k = CHECKPOINTS[checkpoint];
    const nifty = await this.today('NIFTY');
    const signals: ScanSignal[] = [];
    const symbols = this.universe();

    const check = async (symbol: string) => {
      const today = await this.today(symbol);
      if (today.length < k) return;
      const prev = byDay(readBars(symbol, '5m', istDaysAgo(25), istDaysAgo(1)));
      const sessions = [...prev.keys()].sort().map((d) => prev.get(d)!);
      const ctx = buildContext(sessions, readBars(symbol, '1d', istDaysAgo(120), istDaysAgo(1)).slice(-60));
      if (!ctx) return;
      const f = featuresAt(today, k, ctx, nifty);
      if (!f) return;
      const c = today[k - 1].close;
      for (const p of patterns) {
        const m = patternMask(p);
        if ((f.mask & m) !== m) continue;
        const sign = p.side === 'BUY' ? 1 : -1;
        signals.push({
          symbol, direction: p.side, confidence: 0.5,
          entry: c, stop_loss: c - sign * f.atr, target: c + sign * 10 * f.atr,
          indicators: {}, votes: {}, strategy: `pattern:${p.id}`,
        });
      }
    };
    for (let i = 0; i < symbols.length; i += CONCURRENCY) {
      await Promise.all(symbols.slice(i, i + CONCURRENCY).map((s) => check(s).catch(() => {})));
    }
    const recorded = await this.shadow.record(signals);
    log.info({ checkpoint, patterns: patterns.length, matches: signals.length, recorded }, 'Pattern scan');
    return recorded;
  }
}
