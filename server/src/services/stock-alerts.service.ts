/**
 * Telegram stock alerts: few, deduplicated, and only for stocks that pass the
 * statistical checks in lib/alert-math.ts.
 *
 * Candidates come from two places: signals the Rust engine and the bots raise
 * (offered here instead of being sent straight to Telegram), and the exchange's
 * gainer / loser / volume-gainer lists. Every 5 minutes during the session the
 * candidates are scored, and each user gets at most one digest of the best few:
 *  - a stock is alerted at most once per day per user (kept in the database,
 *    so restarts do not resend);
 *  - at most MAX_PER_DIGEST stocks per message and MAX_PER_DAY per day;
 *  - at least MIN_GAP between messages;
 *  - nothing before 09:30 or after 15:20 IST (opening and closing noise).
 */
import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';
import { istDateStr } from '../lib/ist.js';
import { isDerivativeSymbol } from '../lib/instrument.js';
import {
  ALERT_RULES, assess, ewmaVol, logReturns, sessionFraction, stockStats,
  type Assessment, type DailyBar, type StockStats,
} from '../lib/alert-math.js';
import { MarketDataService, type MarketMover } from './market-data.service.js';
import { getMarketMovers } from './market-movers.service.js';
import { TelegramService } from './telegram.service.js';

const log = createChildLogger('StockAlerts');

export const ALERT_LIMITS = {
  maxPerDigest: 3,
  maxPerDay: 6,
  minGapMs: 30 * 60_000,
  /** Engine signals older than this are dropped. */
  candidateTtlMs: 20 * 60_000,
  /** Most stocks scored per run (each needs a quote; history is cached per day). */
  maxScored: 60,
};

const MARKET = 'NIFTY';
const NOT_STOCKS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'INDIAVIX', 'INDIA VIX']);

type Side = 'BUY' | 'SELL';
interface Candidate { direction?: Side; sources: Set<string>; at: number }
export interface AlertPick extends Assessment { symbol: string; sources: string[] }

interface Deps {
  market: Pick<MarketDataService, 'getHistory' | 'getQuote'>;
  telegram: Pick<TelegramService, 'notifyUser'>;
  movers: () => Promise<{ gainers: MarketMover[]; losers: MarketMover[] }>;
  now: () => Date;
}

const side = (direction: string): Side | undefined => {
  const d = direction.toUpperCase();
  return d === 'BUY' || d === 'LONG' ? 'BUY' : d === 'SELL' || d === 'SHORT' ? 'SELL' : undefined;
};

const inr = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The Telegram message for one run. Exported for tests. */
export function formatDigest(picks: AlertPick[], marketChangePct: number, now: Date): string {
  const time = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const lines = picks.map((p) => {
    const sign = p.changePct >= 0 ? '+' : '';
    const from = p.sources.length ? `\nFlagged by: ${p.sources.join(', ')}` : '';
    return (
      `${p.direction === 'BUY' ? '🟢' : '🔴'} <b>${p.direction} ${p.symbol}</b> ${inr(p.ltp)} (${sign}${p.changePct.toFixed(2)}%)\n` +
      `Move: ${Math.abs(p.idioZ).toFixed(1)}σ beyond what NIFTY explains (β ${p.beta.toFixed(2)})\n` +
      `Volume: ${p.relVolume.toFixed(1)}× normal for this time of day\n` +
      `Stop ${inr(p.stop)} (${p.stopPct.toFixed(1)}%) · Target ${inr(p.target)} · 1:2 risk-reward\n` +
      `${p.aboveSma50 ? 'Above' : 'Below'} its 50-day average${from}`
    );
  });
  return (
    `${time} IST · NIFTY ${marketChangePct >= 0 ? '+' : ''}${marketChangePct.toFixed(2)}% today\n\n` +
    lines.join('\n\n') +
    `\n\n<i>Unusual moves measured against each stock's own history. Not a forecast.</i>`
  );
}

export class StockAlertService {
  private candidates = new Map<string, Candidate>();
  private stats = new Map<string, StockStats | null>();
  private statsDay = '';
  private marketHistory: { day: string; bars: DailyBar[]; vol: number } | null = null;
  private running = false;
  private readonly deps: Deps;

  constructor(private readonly prisma: PrismaClient, deps: Partial<Deps> = {}) {
    const market = deps.market ?? new MarketDataService();
    this.deps = {
      market,
      telegram: deps.telegram ?? new TelegramService(prisma),
      movers: deps.movers ?? (() => getMarketMovers().scannerMovers(25)),
      now: deps.now ?? (() => new Date()),
    };
  }

  /** A signal worth considering. Only NSE cash stocks with a BUY/SELL side are kept. */
  offer(symbol: string, direction: string, source: string): void {
    const s = symbol.trim().toUpperCase();
    const d = side(direction);
    if (!d || !/^[A-Z0-9&-]{1,20}$/.test(s) || NOT_STOCKS.has(s) || isDerivativeSymbol(s)) return;
    const prev = this.candidates.get(s);
    const label = /rust|engine/i.test(source) ? 'Rust engine' : 'AI bots';
    // A signal flipping side replaces the old one rather than merging with it.
    const sources = prev && prev.direction === d ? prev.sources : new Set<string>();
    sources.add(label);
    this.candidates.set(s, { direction: d, sources, at: this.deps.now().getTime() });
  }

  /** Score the candidates and send each Telegram user at most one digest. */
  async run(): Promise<{ scored: number; picks: AlertPick[]; sent: number }> {
    const idle = { scored: 0, picks: [], sent: 0 };
    const now = this.deps.now();
    const f = sessionFraction(now);
    if (f < 15 / 375 || f > 365 / 375 || this.running) return idle;    // 09:30–15:20 IST only
    this.running = true;
    try {
      const users = await this.prisma.user.findMany({
        where: { notifyTelegram: true, telegramChatId: { not: null } },
        select: { id: true },
      });
      if (!users.length) return idle;

      const day = istDateStr(now);
      if (this.statsDay !== day) { this.stats.clear(); this.statsDay = day; }
      const ctx = await this.marketContext(day);
      if (!ctx) { log.warn('No NIFTY data; skipping stock alerts this run'); return idle; }

      const pool = await this.candidatePool(now);
      const picks: AlertPick[] = [];
      for (const [symbol, c] of [...pool].slice(0, ALERT_LIMITS.maxScored)) {
        const a = await this.score(symbol, c.direction, day, ctx, now).catch(() => null);
        if (a?.pass) picks.push({ ...a, symbol, sources: [...c.sources] });
      }
      picks.sort((a, b) => b.score - a.score);

      let sent = 0;
      for (const u of users) {
        if (await this.deliver(u.id, day, picks, ctx.changePct, now)) sent++;
      }
      log.info({ scored: Math.min(pool.size, ALERT_LIMITS.maxScored), passed: picks.length, sent }, 'Stock alert run');
      return { scored: Math.min(pool.size, ALERT_LIMITS.maxScored), picks, sent };
    } finally {
      this.running = false;
    }
  }

  private async candidatePool(now: Date): Promise<Map<string, Candidate>> {
    const fresh = now.getTime() - ALERT_LIMITS.candidateTtlMs;
    for (const [s, c] of this.candidates) if (c.at < fresh) this.candidates.delete(s);
    // Engine signals first: they name a side, so they are checked against it.
    const pool = new Map<string, Candidate>(this.candidates);
    const lists = await this.deps.movers().catch(() => ({ gainers: [], losers: [] }));
    for (const m of [...lists.gainers, ...lists.losers]) {
      const s = m.symbol.toUpperCase();
      const existing = pool.get(s);
      if (existing) existing.sources = new Set([...existing.sources, 'NSE movers list']);
      else if (!NOT_STOCKS.has(s)) pool.set(s, { sources: new Set(['NSE movers list']), at: now.getTime() });
    }
    return pool;
  }

  private async marketContext(day: string): Promise<{ bars: DailyBar[]; ret: number; vol: number; changePct: number } | null> {
    if (this.marketHistory?.day !== day) {
      const bars = await this.dailyBars(MARKET, day);
      if (bars.length < 41) return null;
      this.marketHistory = { day, bars, vol: ewmaVol(logReturns(bars.slice(-61).map((b) => b.close))) };
    }
    const q = await this.deps.market.getQuote(MARKET, 'NSE').catch(() => null);
    const prev = q ? q.ltp - q.change : 0;
    if (!q || !(q.ltp > 0) || !(prev > 0)) return null;
    return { bars: this.marketHistory.bars, ret: Math.log(q.ltp / prev), vol: this.marketHistory.vol, changePct: (q.ltp / prev - 1) * 100 };
  }

  private async score(
    symbol: string, direction: Side | undefined, day: string,
    ctx: { bars: DailyBar[]; ret: number; vol: number }, now: Date,
  ): Promise<Assessment | null> {
    if (!this.stats.has(symbol)) {
      this.stats.set(symbol, stockStats(await this.dailyBars(symbol, day), ctx.bars));
    }
    const stats = this.stats.get(symbol);
    if (!stats) return null;
    const q = await this.deps.market.getQuote(symbol, 'NSE');
    const prevClose = q.ltp - q.change;
    if (!(q.ltp > 0) || !(prevClose > 0)) return null;
    return assess({ stats, ltp: q.ltp, prevClose, volume: q.volume, marketReturn: ctx.ret, marketVol: ctx.vol, now, direction });
  }

  /** Completed daily bars before `day`, oldest first. */
  private async dailyBars(symbol: string, day: string): Promise<DailyBar[]> {
    const from = istDateStr(new Date(Date.parse(`${day}T00:00:00+05:30`) - 130 * 86_400_000));
    const bars = await this.deps.market.getHistory(symbol, '1day', from, day).catch(() => []);
    return bars.filter((b) => b.timestamp.slice(0, 10) < day && b.close > 0);
  }

  private async deliver(userId: string, day: string, picks: AlertPick[], marketChangePct: number, now: Date): Promise<boolean> {
    const today = await this.prisma.stockAlert.findMany({
      where: { userId, day },
      select: { symbol: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const room = ALERT_LIMITS.maxPerDay - today.length;
    if (room <= 0) return false;
    if (today[0] && now.getTime() - today[0].createdAt.getTime() < ALERT_LIMITS.minGapMs) return false;
    const already = new Set(today.map((t) => t.symbol));
    const chosen = picks.filter((p) => !already.has(p.symbol)).slice(0, Math.min(ALERT_LIMITS.maxPerDigest, room));
    if (!chosen.length) return false;

    const title = chosen.length === 1 ? '📊 Stock alert' : `📊 ${chosen.length} stock alerts`;
    const ok = await this.deps.telegram.notifyUser(userId, title, formatDigest(chosen, marketChangePct, now));
    if (!ok) return false;
    for (const p of chosen) {
      await this.prisma.stockAlert.create({
        data: {
          userId, symbol: p.symbol, direction: p.direction, day, score: p.score,
          details: JSON.stringify({
            ltp: p.ltp, changePct: p.changePct, idioZ: p.idioZ, beta: p.beta, relVolume: p.relVolume,
            stop: p.stop, target: p.target, sources: p.sources, rules: ALERT_RULES,
          }),
        },
      }).catch((err) => log.warn({ err: (err as Error).message, symbol: p.symbol }, 'Could not record stock alert'));
    }
    return true;
  }
}

let shared: StockAlertService | null = null;
export function getStockAlerts(prisma: PrismaClient): StockAlertService {
  shared ??= new StockAlertService(prisma);
  return shared;
}
