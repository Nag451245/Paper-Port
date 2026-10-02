/**
 * Does a "seasoned trader" playbook have an edge where the live engine does not?
 *
 * ═══════════════════════ PRE-REGISTRATION ═══════════════════════
 * Written 2026-10-03, BEFORE any result of this test was seen. Every rule and
 * parameter below comes from published trading practice, not from this data.
 * Nothing may be tuned after looking at results; a changed rule needs fresh data.
 *
 * Why this and not more indicators: the live engine (5-minute bars, 8-indicator
 * vote, same-day exit) measured NEGATIVE predictive power, equal to a one-line
 * 5-day return (see measure-signal-ic.mjs). It trades the horizon where
 * short-term reversal dominates and costs eat everything. What experienced
 * position traders do is different in kind, and each piece has independent
 * published support:
 *   - Trade WITH the market: no new longs when NIFTY is below its 200-day
 *     average (Faber 2007, "A Quantitative Approach to Tactical Asset Allocation").
 *   - Buy LEADERS: 12-1 month relative strength in the top 20% of the universe
 *     (Jegadeesh & Titman 1993; NSE itself runs Nifty200 Momentum 30 on it).
 *   - Only stocks in a confirmed uptrend: close > 50DMA > 200DMA, 200DMA rising
 *     over 20 days, within 25% of the 52-week high (Minervini's trend template;
 *     George & Hwang 2004 on 52-week-high proximity).
 *   - Enter on a SETUP, next day's open:
 *       breakout — close above the prior 20-day high on volume ≥ 1.5× its 50-day
 *                  average (Donchian / Turtle breakout with volume confirmation);
 *       pullback — some low in the last 3 sessions within 1 ATR of the 20-day EMA,
 *                  and today's close above yesterday's high (buy the dip in a trend).
 *   - Risk first: initial stop 2×ATR(20) below the signal close; size so the stop
 *     loses 0.75% of equity; at most 15% of equity per stock, 10 positions,
 *     3 per sector, no leverage.
 *   - Let winners run: chandelier trailing stop at highest close − 3×ATR(20)
 *     (LeBeau); exit next open if the close falls below the 50-day average.
 *   - Stops fill at the stop, or at the open if the stock gaps through it.
 * Costs: round trip 0.30% large caps, 0.40% mid caps (as in test-contrarian.mjs),
 * half charged on entry and half on exit. Idle cash earns nothing (conservative:
 * a liquid fund would pay ~6.5%).
 *
 * Universe: today's large + mid caps from engine/data/nse_universe.json with
 * cached daily history; a stock is tradeable only when its 20-day average
 * traded value is at least ₹10 crore.
 * Samples:
 *   S1  2021-06-01 → 2023-11-10   (first date with 252 days of history)
 *   S2  2023-11-13 → 2026-09-30
 * Benchmarks: EW = equal-weight buy-and-hold of the same universe (daily
 * rebalanced mean return); NIFTY buy-and-hold.
 *
 * DECISION RULE — the playbook is SUPPORTED only if, in BOTH S1 and S2:
 *   (a) mean trade result in R (net of costs) > 0 with t > 2.24
 *       (Bonferroni: 2 tests at 5% two-sided), and
 *   (b) Sharpe ≥ EW's Sharpe, OR (max drawdown ≤ half of EW's AND CAGR ≥ half
 *       of EW's) — i.e. it must earn its keep on return-for-risk, or by cutting
 *       risk a lot for a modest loss of return.
 * Otherwise: NOT SUPPORTED, and it must not replace the live engine.
 * Ablations (no regime filter; breakout only; pullback only) are REPORTED ONLY.
 *
 * Caveats — read before believing a positive number:
 *   SURVIVORSHIP: today's constituents; stocks that collapsed or were delisted
 *   are missing, which flatters any long-only strategy. Treat results as an
 *   upper bound. ONE REGIME: 2021–2026 was mostly an Indian bull market.
 *   DAILY BARS ONLY: says nothing about intraday trading.
 * ════════════════════════════════════════════════════════════════
 *
 * Bug fix after the first run (disclosed): the EW benchmark became NaN on days
 * when NIFTY had a bar but no stock did; it is now flat on those days. Rules,
 * samples and the decision rule are unchanged. First-run verdict: NOT SUPPORTED
 * (S2 failed (a)); (b) had passed only because NaN compared as a pass.
 *
 * Usage: node server/scripts/test-trend-trader.mjs
 */
import fs from 'fs';
import path from 'path';
import * as L from './lib/signal-research.mjs';

const P = {
  riskPerTrade: 0.0075, maxPositionPct: 0.15, maxPositions: 10, maxPerSector: 3,
  stopAtr: 2, trailAtr: 3, atrPeriod: 20, rsTopPct: 0.2, minTurnover: 1e8,
  breakoutLookback: 20, breakoutVolume: 1.5, pullbackAtr: 1, pullbackDays: 3, nearHighPct: 0.25,
};
const COST = { large: 0.0030, mid: 0.0040 };
const T_CRIT = 2.24;
const SAMPLES = [
  { id: 'S1', start: '2021-06-01', end: '2023-11-10' },
  { id: 'S2', start: '2023-11-13', end: '2026-09-30' },
];
const VARIANTS = [
  { id: 'PLAYBOOK', regime: true, breakout: true, pullback: true, decision: true },
  { id: 'no-regime', regime: false, breakout: true, pullback: true },
  { id: 'breakout-only', regime: true, breakout: true, pullback: false },
  { id: 'pullback-only', regime: true, breakout: false, pullback: true },
];

// ─────────────── data ───────────────
const CACHE = path.join(import.meta.dirname, '.cache', 'yahoo');
function cachedBars(sym) {
  const files = fs.readdirSync(CACHE).filter((f) => f.startsWith(`${sym}_`) && f.endsWith('.json'));
  const byDate = new Map();
  for (const f of files) for (const b of JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'))) byDate.set(b.t, b);
  return [...byDate.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
}
async function niftyBars() {
  const file = path.join(CACHE, 'NSEI-INDEX_2020-01-01_2026-10-01.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const p1 = Date.parse('2020-01-01') / 1000, p2 = Date.parse('2026-10-01') / 1000;
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&period1=${p1}&period2=${p2}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const q = (await res.json()).chart.result[0], o = q.indicators.quote[0], bars = [];
  q.timestamp.forEach((ts, i) => { if (o.close[i] > 0) bars.push({ t: new Date(ts * 1000).toISOString().slice(0, 10), o: o.open[i], h: o.high[i], l: o.low[i], c: o.close[i], v: 0 }); });
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

// ─────────────── per-stock features (only data up to and including day i) ───────────────
const sma = (a, p) => a.map((_, i) => (i + 1 < p ? NaN : a.slice(i + 1 - p, i + 1).reduce((s, x) => s + x, 0) / p));
function features(bars) {
  const c = bars.map((b) => b.c), h = bars.map((b) => b.h), l = bars.map((b) => b.l), v = bars.map((b) => b.v);
  const sma50 = sma(c, 50), sma200 = sma(c, 200), ema20 = L.ema(c, 20), atr = L.atr(h, l, c, P.atrPeriod);
  const vol50 = sma(v, 50), turnover20 = sma(bars.map((b) => b.v * b.c), 20);
  return bars.map((b, i) => {
    if (i < 252) return null;
    const prior = bars.slice(i - P.breakoutLookback, i);
    return {
      t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, i,
      sma50: sma50[i], sma200: sma200[i], sma200ago: sma200[i - 20], ema20: ema20[i], atr: atr[i],
      hh20: Math.max(...prior.map((x) => x.h)),
      volRatio: vol50[i - 1] > 0 ? v[i] / vol50[i - 1] : 0,
      hi252: Math.max(...h.slice(i - 251, i + 1)),
      rs: c[i - 21] / c[i - 252] - 1,
      turnover: turnover20[i],
      pullbackTouch: [0, 1, 2].slice(0, P.pullbackDays).some((k) => l[i - k] <= ema20[i - k] + P.pullbackAtr * atr[i - k]),
      aboveYesterdayHigh: c[i] > h[i - 1],
    };
  });
}

// ─────────────── statistics ───────────────
function curveStats(equity) {
  const r = equity.slice(1).map((e, i) => e / equity[i] - 1);
  const years = r.length / 250, cagr = (equity.at(-1) / equity[0]) ** (1 / years) - 1;
  const sd = L.std(r), sharpe = sd > 0 ? (L.mean(r) / sd) * Math.sqrt(250) : 0;
  let peak = equity[0], mdd = 0;
  for (const e of equity) { peak = Math.max(peak, e); mdd = Math.max(mdd, 1 - e / peak); }
  return { cagr, sharpe, mdd };
}

// ─────────────── the trader ───────────────
function simulate({ dates, stocks, nifty, variant, sample }) {
  const start = dates.indexOf(dates.find((d) => d >= sample.start)), end = dates.findLastIndex((d) => d <= sample.end);
  let cash = 1e7;
  const positions = new Map(), pending = [], trades = [], equity = [];
  let pendingExits = new Set();
  const niftyIdx = new Map(nifty.map((b, i) => [b.t, i])), niftySma200 = sma(nifty.map((b) => b.c), 200);

  for (let di = start; di <= end; di++) {
    const d = dates[di];
    const today = (s) => stocks[s].byDate.get(d);
    const close = (sym, px, why) => {
      const p = positions.get(sym);
      const cost = (p.shares * px * COST[stocks[sym].cap]) / 2;
      cash += p.shares * px - cost;
      const pnl = p.shares * (px - p.entry) - p.costIn - cost;
      trades.push({ sym, setup: p.setup, r: pnl / p.riskAmt, days: di - p.di, why });
      positions.delete(sym);
    };
    // 1. exits decided at yesterday's close, at today's open
    for (const sym of pendingExits) { const f = today(sym); if (f && positions.has(sym)) close(sym, f.o, 'below 50DMA'); }
    pendingExits = new Set();
    // 2. entries decided at yesterday's close, at today's open
    for (const e of pending.splice(0)) {
      const f = today(e.sym);
      if (!f || positions.has(e.sym) || f.o <= e.stop) continue;           // gapped through the stop: skip
      const equityNow = cash + [...positions].reduce((s, [k, p]) => s + p.shares * (today(k)?.o ?? p.last), 0);
      let shares = Math.floor((P.riskPerTrade * equityNow) / (f.o - e.stop));
      shares = Math.min(shares, Math.floor((P.maxPositionPct * equityNow) / f.o), Math.floor(cash / (f.o * (1 + COST[stocks[e.sym].cap]))));
      if (shares <= 0) continue;
      const costIn = (shares * f.o * COST[stocks[e.sym].cap]) / 2;
      cash -= shares * f.o + costIn;
      positions.set(e.sym, { shares, entry: f.o, stop: e.stop, riskAmt: shares * (f.o - e.stop), costIn, high: f.o, last: f.o, setup: e.setup, di });
    }
    // 3. stops during the day; trailing stop and trend exit at the close
    for (const [sym, p] of positions) {
      const f = today(sym);
      if (!f) continue;
      if (f.l <= p.stop) { close(sym, Math.min(f.o, p.stop), 'stop'); continue; }
      p.last = f.c; p.high = Math.max(p.high, f.c);
      p.stop = Math.max(p.stop, p.high - P.trailAtr * f.atr);
      if (f.c < f.sma50) pendingExits.add(sym);
    }
    // 4. mark to market
    const value = cash + [...positions.values()].reduce((s, p) => s + p.shares * p.last, 0);
    equity.push(value);
    // 5. scan at the close for tomorrow
    const ni = niftyIdx.get(d);
    const riskOn = !variant.regime || (ni !== undefined && nifty[ni].c > niftySma200[ni]);
    if (!riskOn) continue;
    const live = Object.keys(stocks).map((s) => [s, today(s)]).filter(([, f]) => f && f.turnover >= P.minTurnover);
    const rsCut = [...live].map(([, f]) => f.rs).sort((a, b) => b - a)[Math.floor(live.length * P.rsTopPct)] ?? Infinity;
    const sectors = {};
    for (const s of positions.keys()) sectors[stocks[s].sector] = (sectors[stocks[s].sector] ?? 0) + 1;
    const candidates = live.filter(([s, f]) =>
      !positions.has(s) && !pendingExits.has(s) && f.rs >= rsCut &&
      f.c > f.sma50 && f.sma50 > f.sma200 && f.sma200 > f.sma200ago && f.c >= (1 - P.nearHighPct) * f.hi252)
      .map(([s, f]) => {
        const breakout = variant.breakout && f.c > f.hh20 && f.volRatio >= P.breakoutVolume;
        const pullback = variant.pullback && f.pullbackTouch && f.aboveYesterdayHigh;
        return { s, f, setup: breakout ? 'breakout' : pullback ? 'pullback' : null };
      })
      .filter((x) => x.setup)
      .sort((a, b) => b.f.rs - a.f.rs);
    let slots = P.maxPositions - positions.size;
    for (const { s, f, setup } of candidates) {
      if (slots <= 0) break;
      const sec = stocks[s].sector;
      if ((sectors[sec] ?? 0) >= P.maxPerSector) continue;
      sectors[sec] = (sectors[sec] ?? 0) + 1;
      pending.push({ sym: s, stop: f.c - P.stopAtr * f.atr, setup });
      slots--;
    }
  }
  // close what is left at the last close, so every trade is counted
  for (const [sym, p] of positions) {
    const cost = (p.shares * p.last * COST[stocks[sym].cap]) / 2;
    trades.push({ sym, setup: p.setup, r: (p.shares * (p.last - p.entry) - p.costIn - cost) / p.riskAmt, days: end - p.di, why: 'end' });
  }
  return { equity, trades };
}

function benchmarks(dates, stocks, nifty, sample) {
  const ds = dates.filter((d) => d >= sample.start && d <= sample.end);
  const ew = [1];
  for (let k = 1; k < ds.length; k++) {
    const rets = Object.values(stocks).map((s) => { const a = s.byDate.get(ds[k - 1]), b = s.byDate.get(ds[k]); return a && b ? b.c / a.c - 1 : null; }).filter((x) => x !== null);
    ew.push(ew.at(-1) * (1 + (rets.length ? L.mean(rets) : 0)));   // no stock traded (e.g. a NIFTY-only special session): flat
  }
  const nb = nifty.filter((b) => b.t >= sample.start && b.t <= sample.end).map((b) => b.c);
  return { EW: curveStats(ew), NIFTY: curveStats(nb) };
}

// ─────────────── run ───────────────
const universe = (await import('../../engine/data/nse_universe.json', { with: { type: 'json' } })).default.filter((u) => u.cap === 'large' || u.cap === 'mid');
const stocks = {};
for (const u of universe) {
  const bars = cachedBars(u.symbol);
  if (bars.length < 400) continue;
  const feats = features(bars).filter(Boolean);
  stocks[u.symbol] = { cap: u.cap, sector: u.sector, byDate: new Map(feats.map((f) => [f.t, f])) };
}
const nifty = await niftyBars();
const dates = nifty.map((b) => b.t);
console.log(`Universe: ${Object.keys(stocks).length} stocks with history (of ${universe.length} large + mid caps). NIFTY bars: ${nifty.length}.\n`);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const verdicts = [];
for (const sample of SAMPLES) {
  const bm = benchmarks(dates, stocks, nifty, sample);
  console.log(`══ ${sample.id} ${sample.start} → ${sample.end}`);
  console.log(`   EW     CAGR ${pct(bm.EW.cagr)}  Sharpe ${bm.EW.sharpe.toFixed(2)}  MaxDD ${pct(bm.EW.mdd)}`);
  console.log(`   NIFTY  CAGR ${pct(bm.NIFTY.cagr)}  Sharpe ${bm.NIFTY.sharpe.toFixed(2)}  MaxDD ${pct(bm.NIFTY.mdd)}`);
  for (const variant of VARIANTS) {
    const { equity, trades } = simulate({ dates, stocks, nifty, variant, sample });
    const s = curveStats(equity), rs = trades.map((t) => t.r);
    const t = L.tstat(rs), win = rs.filter((r) => r > 0).length / rs.length;
    console.log(`   ${variant.id.padEnd(14)} CAGR ${pct(s.cagr)}  Sharpe ${s.sharpe.toFixed(2)}  MaxDD ${pct(s.mdd)}  | trades ${trades.length}  win ${pct(win)}  avg ${L.mean(rs).toFixed(3)}R  t ${t.toFixed(2)}  avg hold ${L.mean(trades.map((x) => x.days)).toFixed(0)}d`);
    if (variant.decision) {
      for (const setup of ['breakout', 'pullback']) {
        const sr = trades.filter((x) => x.setup === setup).map((x) => x.r);
        if (sr.length) console.log(`      ${setup.padEnd(9)} ${sr.length} trades  avg ${L.mean(sr).toFixed(3)}R  t ${L.tstat(sr).toFixed(2)}`);
      }
      const a = L.mean(rs) > 0 && t > T_CRIT;
      const b = s.sharpe >= bm.EW.sharpe || (s.mdd <= bm.EW.mdd / 2 && s.cagr >= bm.EW.cagr / 2);
      verdicts.push({ sample: sample.id, a, b });
    }
  }
  console.log('');
}
const supported = verdicts.every((v) => v.a && v.b);
console.log('Decision rule:', verdicts.map((v) => `${v.sample}: (a) ${v.a ? 'pass' : 'FAIL'} (b) ${v.b ? 'pass' : 'FAIL'}`).join(' · '));
console.log(`VERDICT: ${supported ? 'SUPPORTED' : 'NOT SUPPORTED'}`);
