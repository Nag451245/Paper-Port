/**
 * Options Lab: backtests of multi-leg option strategies on past option prices,
 * and the data for replaying a past trading day with its option chain.
 *
 * The data work (finding expiries, picking strikes, loading candles) happens
 * here; the trade-by-trade simulation runs in the Rust engine
 * (engine/src/options_backtest.rs). Both can take minutes the first time a
 * period is used — every contract is fetched from ICICI once — so they run as
 * background jobs the page polls.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';
import { istDateStr } from '../lib/ist.js';
import { fnoRatesOn, type FnoRates } from '../lib/fno-charges.js';
import { engineOptionsBacktest, isEngineAvailable } from '../lib/rust-engine.js';
import { OptionHistory, STRIKE_STEP, barDay, barMinute, type OptBar } from './option-history.service.js';

const log = createChildLogger('OptionsLab');

export interface LabLeg {
  type: 'CE' | 'PE';
  action: 'BUY' | 'SELL';
  lots: number;
  /** atm: ATM + offset strikes; premium: the strike whose price at entry is nearest `premium` (out of the money side) */
  strikeMode: 'atm' | 'premium';
  offset: number;
  premium?: number;
}

export interface BacktestParams {
  underlying: string;
  from: string;
  to: string;
  expiryKind: 'weekly' | 'monthly';
  /** Trading days before expiry to enter (0 = on expiry day) */
  entryDaysBefore: number;
  entryTime: string;
  /** Trading days before expiry to exit (≤ entryDaysBefore) */
  exitDaysBefore: number;
  exitTime: string;
  /** Hold to the expiry close and settle instead of exiting */
  holdToExpiry: boolean;
  legs: LabLeg[];
  lotSize: number;
  target?: { kind: 'pct' | 'rupees'; value: number };
  stop?: { kind: 'pct' | 'rupees'; value: number };
  slippagePct: number;
  brokeragePerOrder: number;
}

export const MAX_CYCLES = 60;
const ENGINE_BATCH = 8;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const istEpoch = (day: string, hhmm: string) => Math.floor(Date.parse(`${day}T${hhmm}:00+05:30`) / 1000);
const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const rustRates = (r: FnoRates) => ({
  per_order: r.brokeragePerOrder, stt_sell: r.sttOptionSell, stt_exercise: r.sttOptionExercise,
  exchange: r.exchangeOption, stamp_buy: r.stampOptionBuy, sebi: r.sebi, gst: r.gst,
});

// ─── Background jobs ─────────────────────────────────────────────────────────

export interface Job {
  id: string;
  userId: string;
  kind: 'backtest' | 'replay';
  state: 'running' | 'done' | 'failed';
  progress: { done: number; total: number; message: string };
  result?: unknown;
  error?: string;
  startedAt: number;
}
type Report = (done: number, total: number, message: string) => void;

const jobs = new Map<string, Job>();

export function startJob(userId: string, kind: Job['kind'], run: (report: Report) => Promise<unknown>): Job {
  for (const [id, j] of jobs) if (Date.now() - j.startedAt > 2 * 3_600_000) jobs.delete(id);
  const job: Job = { id: randomUUID(), userId, kind, state: 'running', progress: { done: 0, total: 0, message: 'Starting…' }, startedAt: Date.now() };
  jobs.set(job.id, job);
  run((done, total, message) => { job.progress = { done, total, message }; })
    .then((result) => { job.result = result; job.state = 'done'; })
    .catch((err) => { job.error = (err as Error).message; job.state = 'failed'; log.warn({ kind, err: job.error }, 'Options Lab job failed'); });
  return job;
}

export function getJob(id: string, userId: string): Job | null {
  const j = jobs.get(id);
  return j && j.userId === userId ? j : null;
}

/** A user may run one job of each kind at a time (ICICI allows ~100 requests a minute). */
export function runningJob(userId: string, kind: Job['kind']): Job | null {
  for (const j of jobs.values()) if (j.userId === userId && j.kind === kind && j.state === 'running') return j;
  return null;
}

export class OptionsLabError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

// ─── The lab ─────────────────────────────────────────────────────────────────

export class OptionsLab {
  constructor(private readonly history: OptionHistory, private readonly prisma?: PrismaClient) {}

  /** Price of a contract at an IST minute on `day`: the open of the first candle at or after it. */
  private priceAt(bars: OptBar[], day: string, minute: number): number | null {
    const b = bars.find((x) => barDay(x[0]) === day && barMinute(x[0]) >= minute);
    return b ? b[1] : null;
  }

  async backtest(userId: string, p: BacktestParams, report: Report = () => {}) {
    if (!isEngineAvailable()) throw new OptionsLabError('The Rust engine is not running on the server, so backtests cannot run.', 503);
    const U = p.underlying.toUpperCase();
    const step = STRIKE_STEP[U];
    if (!step) throw new OptionsLabError(`${U} options are not supported. Choose one of: ${Object.keys(STRIKE_STEP).join(', ')}.`);
    const today = istDateStr();
    const to = [p.to, today].sort()[0];
    if (p.from > to) throw new OptionsLabError('The start date is after the end date.');
    if (!p.holdToExpiry && (p.exitDaysBefore > p.entryDaysBefore
      || (p.exitDaysBefore === p.entryDaysBefore && minuteOf(p.exitTime) <= minuteOf(p.entryTime)))) {
      throw new OptionsLabError('The exit must come after the entry.');
    }
    const entryMin = minuteOf(p.entryTime);

    report(0, 0, `Finding ${U} ${p.expiryKind} expiry dates (checked against ICICI's data)…`);
    const found = await this.history.expiries(U, p.from, to, p.expiryKind);
    const notes: string[] = [];
    if (found.unchecked.length) notes.push(`${found.unchecked.length} period(s) could not be checked yet (${found.error ?? 'ICICI unavailable'}); run again to include them.`);
    let expiries = found.expiries;
    if (expiries.length > MAX_CYCLES) {
      notes.push(`The range has ${expiries.length} expiries; the latest ${MAX_CYCLES} were tested. Run earlier periods separately.`);
      expiries = expiries.slice(-MAX_CYCLES);
    }
    if (!expiries.length) {
      throw new OptionsLabError(found.error
        ? `No expiry dates could be checked: ${found.error}`
        : `No ${p.expiryKind} ${U} expiries found between ${p.from} and ${to}.`, 422);
    }

    const cycles: unknown[] = [];
    const skipped: { id: string; expiry: string; reason: string }[] = [];
    let stopReason: string | null = null;

    for (let i = 0; i < expiries.length; i++) {
      const E = expiries[i];
      report(i, expiries.length, `Loading prices for the ${E} expiry (${i + 1} of ${expiries.length})…`);
      const skip = (reason: string) => skipped.push({ id: E, expiry: E, reason });
      const span = Math.max(10, p.entryDaysBefore * 2 + 7);
      const guess = await this.history.atmBefore(U, addDays(E, -Math.ceil(p.entryDaysBefore * 1.4) - 1));
      if (!guess) { skip(`no index price before ${E}`); continue; }
      const [ce, pe] = [
        await this.history.contract(U, E, guess, 'CE', addDays(E, -span), E),
        await this.history.contract(U, E, guess, 'PE', addDays(E, -span), E),
      ];
      const err = ce.error ?? pe.error;
      if (err && !ce.bars.length) { stopReason = err; break; }

      const days = [...new Set(ce.bars.map((b) => barDay(b[0])))].sort();
      if (days[days.length - 1] !== E) { skip('no prices on the expiry day'); continue; }
      const entryIdx = days.length - 1 - p.entryDaysBefore;
      if (entryIdx < 0) { skip(`the contracts traded only ${days.length} day(s) before expiry`); continue; }
      const entryDay = days[entryIdx];
      const exitDay = p.holdToExpiry ? E : days[days.length - 1 - p.exitDaysBefore];

      const spot = await this.history.spotAt(U, entryDay, entryMin, { strike: guess, ce: ce.bars, pe: pe.bars });
      if (!spot) { skip(`no index level at ${p.entryTime} on ${entryDay}`); continue; }
      const atm = Math.round(spot / step) * step;

      const legs: unknown[] = [];
      let legError: string | null = null;
      for (const leg of p.legs) {
        let strike = atm + leg.offset * step;
        let bars: OptBar[] = [];
        if (leg.strikeMode === 'premium' && leg.premium && leg.premium > 0) {
          // Walk away from the money until the price falls to the target; keep the nearest.
          const dir = leg.type === 'CE' ? 1 : -1;
          let best: { strike: number; bars: OptBar[]; gap: number } | null = null;
          for (let k = 0; k <= 15; k++) {
            const K = atm + dir * k * step;
            const r = await this.history.contract(U, E, K, leg.type, entryDay, exitDay);
            if (r.error && !r.bars.length) { legError = r.error; break; }
            const px = this.priceAt(r.bars, entryDay, entryMin);
            if (px == null) continue;
            const gap = Math.abs(px - leg.premium);
            if (!best || gap < best.gap) best = { strike: K, bars: r.bars, gap };
            if (px <= leg.premium) break;
          }
          if (legError) break;
          if (!best) { legError = `no ${leg.type} priced near ₹${leg.premium}`; break; }
          strike = best.strike; bars = best.bars;
        } else {
          const r = await this.history.contract(U, E, strike, leg.type, entryDay, exitDay);
          if (r.error && !r.bars.length) { legError = r.error; break; }
          bars = r.bars;
        }
        legs.push({
          label: `${strike} ${leg.type}`,
          option_type: leg.type === 'CE' ? 'call' : 'put',
          strike,
          qty: (leg.action === 'BUY' ? 1 : -1) * leg.lots * p.lotSize,
          bars: bars.filter((b) => { const d = barDay(b[0]); return d >= entryDay && d <= exitDay; }).map((b) => [b[0], b[1], b[4]]),
        });
      }
      if (legError) {
        if (/limit|connected|session|bridge|timeout|fetch/i.test(legError)) { stopReason = legError; break; }
        skip(legError); continue;
      }

      cycles.push({
        id: E, expiry: E,
        entry_ts: istEpoch(entryDay, p.entryTime),
        exit_ts: p.holdToExpiry ? istEpoch(E, '15:30') : istEpoch(exitDay, p.exitTime),
        settle: p.holdToExpiry,
        spot,
        rates: rustRates(fnoRatesOn(entryDay, { underlying: U, brokeragePerOrder: p.brokeragePerOrder })),
        legs,
      });
    }
    if (stopReason) notes.push(`Stopped early: ${stopReason}. What was loaded is saved; run again later to continue.`);

    report(expiries.length, expiries.length, 'Simulating trades in the Rust engine…');
    const rules = { target: p.target ?? null, stop: p.stop ?? null, slippage_pct: p.slippagePct };
    let trades: unknown[] = [];
    let engineSkipped: { id: string; expiry: string; reason: string }[] = [];
    let summary: unknown = null;
    for (let i = 0; i < Math.max(1, cycles.length); i += ENGINE_BATCH) {
      const out = await engineOptionsBacktest({
        cycles: cycles.slice(i, i + ENGINE_BATCH), rules,
        prior_trades: trades, prior_skipped: skipped.length + engineSkipped.length,
      }) as { trades: unknown[]; skipped: typeof engineSkipped; summary: unknown };
      trades = [...trades, ...out.trades];
      engineSkipped = [...engineSkipped, ...out.skipped];
      summary = out.summary;
    }

    const result = {
      params: p, summary, trades, skipped: [...skipped, ...engineSkipped], expiriesTested: expiries, notes,
      basis: `5-minute ICICI option prices; entry at the open of the ${p.entryTime} candle, ${p.slippagePct}% slippage each way, ` +
        `charges at the rates in force on each trade date, ${p.lotSize} per lot (today's lot size).`,
      budget: this.history.budget(),
    };
    if (this.prisma) {
      const run = await this.prisma.optionBacktestRun.create({
        data: {
          userId, underlying: U, dateFrom: p.from, dateTo: to,
          params: JSON.stringify(p), summary: JSON.stringify({ ...(summary as object), notes, skipped: result.skipped }),
          trades: JSON.stringify(trades),
        },
      });
      return { id: run.id, ...result };
    }
    return result;
  }

  /**
   * One past trading day for Replay: the index candles (or put-call parity
   * when ICICI has none), and every strike within `each` steps of the money
   * with its call and put candles. Charges rates are those of that day.
   */
  async replayDay(underlying: string, day: string, opts: { expiry?: string; each?: number } = {}, report: Report = () => {}) {
    const U = underlying.toUpperCase();
    const step = STRIKE_STEP[U];
    if (!step) throw new OptionsLabError(`${U} options are not supported.`);
    if (day > istDateStr()) throw new OptionsLabError('Pick a day that has already traded.');
    const each = Math.min(Math.max(opts.each ?? 8, 3), 12);

    report(0, 0, 'Finding the expiry that was trading that day…');
    let expiry = opts.expiry;
    if (!expiry) {
      const found = await this.history.expiries(U, day, addDays(day, 40), 'weekly');
      expiry = found.expiries.find((e) => e >= day);
      if (!expiry) throw new OptionsLabError(found.error ? `Could not check expiries: ${found.error}` : `No ${U} expiry found after ${day}.`, 422);
    }

    const guess = await this.history.atmBefore(U, day);
    if (!guess) throw new OptionsLabError(`No ${U} daily price before ${day}.`, 422);
    const ce0 = await this.history.contract(U, expiry, guess, 'CE', day, day);
    const pe0 = await this.history.contract(U, expiry, guess, 'PE', day, day);
    if (!ce0.bars.length) throw new OptionsLabError(ce0.error ? `ICICI: ${ce0.error}` : `No option prices for ${U} on ${day} — the market may have been closed.`, 422);

    // The index through the day: its own candles, else K + call − put at each candle.
    let spot = await this.history.indexBars(U, day);
    let spotSource: 'index' | 'parity' = 'index';
    if (!spot.length) {
      spotSource = 'parity';
      const peAt = new Map(pe0.bars.map((b) => [b[0], b]));
      spot = ce0.bars.filter((b) => peAt.has(b[0])).map((c) => {
        const p = peAt.get(c[0])!;
        const o = guess + c[1] - p[1], cl = guess + c[4] - p[4];
        return [c[0], o, Math.max(o, cl), Math.min(o, cl), cl, 0] as OptBar;
      });
    }
    const open = spot[0]?.[1] ?? guess;
    const atm = Math.round(open / step) * step;
    const strikes = Array.from({ length: each * 2 + 1 }, (_, i) => atm + (i - each) * step);
    const chain: { strike: number; ce: OptBar[]; pe: OptBar[] }[] = [];
    let n = 0;
    for (const K of strikes) {
      report(n, strikes.length, `Loading the ${K} call and put (${n + 1} of ${strikes.length})…`);
      const ce = K === guess ? ce0 : await this.history.contract(U, expiry, K, 'CE', day, day);
      const pe = K === guess ? pe0 : await this.history.contract(U, expiry, K, 'PE', day, day);
      if ((ce.error && !ce.bars.length) || (pe.error && !pe.bars.length)) {
        const e = ce.error ?? pe.error ?? '';
        if (/limit|connected|session/i.test(e)) throw new OptionsLabError(e, 503);
      }
      chain.push({ strike: K, ce: ce.bars, pe: pe.bars });
      n++;
    }
    const r = fnoRatesOn(day, { underlying: U });
    return {
      underlying: U, day, expiry, step, atm, spotSource, spot, chain,
      daysToExpiry: Math.max(0, Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000)),
      rates: r,
      budget: this.history.budget(),
    };
  }
}
