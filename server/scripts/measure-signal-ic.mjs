/**
 * Measure the predictive power of the live scan composite.
 *
 * WHY THIS EXISTS
 * ---------------
 * engine/src/scan.rs produces the signals that actually trade, but nothing
 * backtests it: backtest::run only ever executes the named strategies in
 * strategy.rs. So the composite has never been compared against forward
 * returns. This script does that comparison.
 *
 * WHAT IT COMPUTES
 * ----------------
 * Information Coefficient (IC): the Spearman rank correlation between the
 * signal produced at bar t and the return realised over the following h bars.
 * It is computed cross-sectionally — ranking all symbols against each other on
 * each date — which is how a signal is actually used when choosing what to buy
 * today out of a universe.
 *
 * Reference points for daily equity signals:
 *   |IC| < 0.01   indistinguishable from noise
 *   |IC| ~ 0.02   weak but potentially tradeable at low cost
 *   |IC| ~ 0.05   strong
 *   |IC| > 0.10   implausible on liquid equities; suspect look-ahead
 *
 * The t-statistic on the mean daily IC matters as much as the IC itself: a
 * respectable IC measured over 30 days is noise.
 *
 * FIDELITY
 * --------
 * This is a hand port of scan.rs, verified against the source function by
 * function. It is NOT the engine. Cross-check it whenever scan.rs changes.
 * Ported from scan.rs: vote thresholds, weights, agreement bonus, volatility
 * and liquidity factors, breakout term. Defaults are the HIGH aggressiveness
 * profile, which is what bot-engine.ts passes in live operation.
 *
 * NO LOOK-AHEAD: at bar t only candles[0..t] are visible, and the forward
 * return is measured from close[t] to close[t+h].
 *
 * Usage:
 *   node scripts/measure-signal-ic.mjs [--years 3] [--symbols 80] [--mode both]
 *     --mode buggy | fixed | both   (buggy = supertrend/VWAP as shipped today)
 */

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const YEARS = Number(argVal('--years', 3));
const MAX_SYMBOLS = Number(argVal('--symbols', 80));
const MODE = argVal('--mode', 'both');
// 'yahoo' = daily bars over the internet (no credentials needed).
// 'breeze' = whatever scripts/.cache/breeze-<interval>.json holds, which is the
// real NSE intraday data the live system trades on. Fetch it first with
// scripts/fetch-breeze-history.mjs.
const SOURCE = argVal('--source', 'yahoo');
const BREEZE_INTERVAL = argVal('--interval', '5minute');
const HORIZONS = [1, 5, 20];

// ── HIGH aggressiveness thresholds (scan.rs resolve_thresholds) ──
const TH = {
  min_confidence: 0.30,
  rsi_oversold: 40, rsi_overbought: 60,
  rsi_strong_oversold: 35, rsi_strong_overbought: 65,
  momentum_candles: 2, volume_surge_ratio: 1.2,
};
// ── default VoteWeights, then normalised (scan.rs normalize_weights) ──
const RAW_W = { ema: 0.15, rsi: 0.10, macd: 0.10, supertrend: 0.10, bollinger: 0.05, vwap: 0.05, momentum: 0.25, volume: 0.20 };
const WSUM = Object.values(RAW_W).reduce((a, b) => a + b, 0);
const W = Object.fromEntries(Object.entries(RAW_W).map(([k, v]) => [k, v / WSUM]));

// ════════════════ indicators — ports of utils.rs / signals.rs ════════════════
const ema = (d, p) => { const r = new Array(d.length).fill(NaN); if (d.length < p) return r;
  const m = 2 / (p + 1); r[p - 1] = d.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < d.length; i++) r[i] = (d[i] - r[i - 1]) * m + r[i - 1]; return r; };

const rsi = (d, p) => { const n = d.length, r = new Array(n).fill(NaN); if (n < p + 1) return r;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const ch = d[i] - d[i - 1]; if (ch > 0) g += ch; else l -= ch; }
  g /= p; l /= p; r[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < n; i++) { const ch = d[i] - d[i - 1];
    g = (g * (p - 1) + Math.max(ch, 0)) / p; l = (l * (p - 1) + Math.max(-ch, 0)) / p;
    r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return r; };

const atr = (h, l, c, p) => { const n = c.length, tr = new Array(n).fill(0), a = new Array(n).fill(0);
  tr[0] = h[0] - l[0];
  for (let i = 1; i < n; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  if (n >= p) { a[p - 1] = tr.slice(0, p).reduce((x, y) => x + y, 0) / p;
    for (let i = p; i < n; i++) a[i] = (a[i - 1] * (p - 1) + tr[i]) / p; } return a; };

const macd = (d) => { const e12 = ema(d, 12), e26 = ema(d, 26);
  const line = d.map((_, i) => (isNaN(e12[i]) || isNaN(e26[i])) ? NaN : e12[i] - e26[i]);
  const sig = ema(line.map(v => isNaN(v) ? 0 : v), 9);
  const hist = d.map((_, i) => (isNaN(line[i]) || isNaN(sig[i])) ? NaN : line[i] - sig[i]);
  return { line, sig, hist }; };

const boll = (d, p) => { const n = d.length, u = new Array(n).fill(0), lo = new Array(n).fill(0);
  for (let i = p - 1; i < n; i++) { const w = d.slice(i - p + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / p;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / p);
    u[i] = m + 2 * sd; lo[i] = m - 2 * sd; } return { u, lo }; };

/** SHIPPED (broken): compares close to the same bar's basic bands. */
const supertrendBuggy = (h, l, c, p, m) => { const n = c.length, r = new Array(n).fill(0);
  if (n < p) return r; const a = atr(h, l, c, p);
  for (let i = p; i < n; i++) { const hl2 = (h[i] + l[i]) / 2, up = hl2 + m * a[i], low = hl2 - m * a[i];
    r[i] = c[i] > up ? low : (c[i] < low ? up : r[i - 1]); if (r[i] === 0) r[i] = low; } return r; };

/** FIXED: ratcheted final bands + persistent trend state. */
const supertrendFixed = (h, l, c, p, m) => { const n = c.length, r = new Array(n).fill(0);
  if (n < p || p === 0) return r; const a = atr(h, l, c, p);
  let fu = 0, fl = 0, up = null;
  for (let i = p; i < n; i++) { const A = a[i];
    if (!isFinite(A) || A <= 0) { r[i] = i > 0 ? r[i - 1] : 0; continue; }
    const hl2 = (h[i] + l[i]) / 2, bu = hl2 + m * A, bl = hl2 - m * A;
    const pu = fu, pl = fl, pc = c[i - 1];
    fl = (bl > pl || pc < pl) ? bl : Math.max(bl, pl);
    fu = (bu < pu || pc > pu) ? bu : Math.min(bu, pu);
    const nowUp = up === null ? c[i] > fu : (up ? c[i] >= fl : c[i] > fu);
    up = nowUp; r[i] = nowUp ? fl : fu; } return r; };

/** SHIPPED (broken): accumulates from bar 0, never resets. */
const vwapBuggy = (bars) => { let pv = 0, v = 0;
  return bars.map(b => { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; v += b.v; return v > 0 ? pv / v : b.c; }); };

/** FIXED: anchored to the session (date prefix of the timestamp). */
const vwapFixed = (bars) => { let pv = 0, v = 0, key = null;
  return bars.map(b => { const k = (b.t || '').slice(0, 10);
    if (k !== key) { key = k; pv = 0; v = 0; }
    const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; v += b.v; return v > 0 ? pv / v : b.c; }); };

// ════════════ per-bar helpers (scan.rs calc_momentum / volume_ratio / breakout) ════════════
function momentumAt(bars, i, lookback) {
  if (i + 1 < lookback + 1) return 0;
  const start = i + 1 - lookback;
  let green = 0, total = 0;
  const avg = bars.slice(start, i + 1).reduce((a, b) => a + b.c, 0) / lookback;
  for (let k = start; k <= i; k++) {
    const p = k > 0 ? k - 1 : 0;
    if (bars[k].c > bars[p].c) green++; else green--;
    if (avg > 0) total += (bars[k].c - bars[p].c) / avg * 100;
  }
  const dir = green / lookback;
  const mag = Math.max(-2, Math.min(2, total / lookback)) / 2;
  return Math.max(-1, Math.min(1, dir * 0.6 + mag * 0.4));
}
function volumeRatioAt(bars, i, lookback) {
  if (i + 1 < lookback + 1) return 1;
  const cur = bars[i].v;
  const avg = bars.slice(i - lookback, i).reduce((a, b) => a + b.v, 0) / lookback;
  return avg > 0 ? cur / avg : 1;
}
function breakoutAt(bars, i, lookback) {
  if (i + 1 < lookback + 1) return 0;
  const w = bars.slice(i - lookback, i);
  const hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
  const c = bars[i].c;
  if (bars[i].h > hi) return Math.min((c - hi) / hi * 100 * 2, 1);
  if (bars[i].l < lo) return -Math.min((lo - c) / lo * 100 * 2, 1);
  return 0;
}

// ════════════════ the composite — port of scan.rs compute() ════════════════
function computeVotes(bars, ind, i) {
  const c = bars[i].c;
  const ema9 = ind.e9[i], ema21 = ind.e21[i], ema9p = ind.e9[i - 1], ema21p = ind.e21[i - 1];
  const r = ind.rsi[i];
  const m = ind.macd.line[i], ms = ind.macd.sig[i], mp = ind.macd.line[i - 1], msp = ind.macd.sig[i - 1];
  const mh = ind.macd.hist[i], mhp = ind.macd.hist[i - 1];
  const st = ind.st[i], bu = ind.bb.u[i], bl = ind.bb.lo[i], vw = ind.vwap[i];
  if (!isFinite(ema21) || ema21 === 0 || st === 0 || bu === 0) return null;
  if ([ema9, ema21, ema9p, ema21p, r, m, ms, mp, msp, mh].some(v => !isFinite(v))) return null;

  const mom = momentumAt(bars, i, TH.momentum_candles);
  const volR = volumeRatioAt(bars, i, 5);
  const brk = breakoutAt(bars, i, 10);
  const a = ind.atr[i];

  // EMA
  let ema_vote;
  if (ema9 > ema21 && ema9p <= ema21p) ema_vote = 1;
  else if (ema9 < ema21 && ema9p >= ema21p) ema_vote = -1;
  else if (ema9 > ema21) ema_vote = Math.min(0.5 + Math.min((ema9 - ema21) / ema21 * 100 * 0.3, 0.5), 1);
  else if (ema9 < ema21) ema_vote = -Math.min(0.5 + Math.min((ema21 - ema9) / ema21 * 100 * 0.3, 0.5), 1);
  else ema_vote = 0;

  // RSI
  let rsi_vote;
  if (r < TH.rsi_strong_oversold) rsi_vote = 0.8;
  else if (r < TH.rsi_oversold) rsi_vote = 0.5;
  else if (r > TH.rsi_strong_overbought) rsi_vote = -0.8;
  else if (r > TH.rsi_overbought) rsi_vote = -0.5;
  else { const mid = (TH.rsi_oversold + TH.rsi_overbought) / 2, half = (TH.rsi_overbought - TH.rsi_oversold) / 2;
    rsi_vote = half > 0 ? Math.max(-0.4, Math.min(0.4, (r - mid) / half * 0.4)) : 0; }

  // MACD
  let macd_vote;
  if (m > ms && mp <= msp) macd_vote = 1;
  else if (m < ms && mp >= msp) macd_vote = -1;
  else if (mh > 0) macd_vote = mh > mhp ? 0.7 : 0.3;
  else if (mh < 0) macd_vote = mh < mhp ? -0.7 : -0.3;
  else macd_vote = 0;

  const st_vote = c > st ? 1 : -1;

  // Bollinger
  let bb_vote = 0; const range = bu - bl;
  if (range > 0) { const pos = (c - bl) / range; const mid = (bu + bl) / 2;
    if (pos > 0.9 && mom > 0.5) bb_vote = 0.9;
    else if (pos > 0.8) bb_vote = 0.5;
    else if (pos < 0.1 && mom < -0.5) bb_vote = -0.9;
    else if (pos < 0.2) bb_vote = -0.5;
    else bb_vote = c > mid ? 0.3 : -0.3; }

  // VWAP
  const vp = vw > 0 ? (c - vw) / vw * 100 : 0;
  const vwap_vote = vp > 1 ? 1 : vp > 0.5 ? 0.7 : vp > 0 ? 0.4 : vp < -1 ? -1 : vp < -0.5 ? -0.7 : -0.4;

  // Volume
  let vol_vote;
  if (volR > TH.volume_surge_ratio * 1.5) vol_vote = mom > 0 ? 1 : -1;
  else if (volR > TH.volume_surge_ratio) vol_vote = mom > 0 ? 0.7 : -0.7;
  else if (volR > 1) vol_vote = mom > 0 ? 0.3 : -0.3;
  else vol_vote = 0;

  return { ema_vote, rsi_vote, macd_vote, st_vote, bb_vote, vwap_vote, momentum_vote: mom, volume_vote: vol_vote, brk, atr: a, close: c, volR };
}

function composite(v) {
  let w = { ...W };
  if (Math.abs(v.volume_vote) < 0.001) {   // scan.rs redistributes volume weight
    const nonVol = w.ema + w.rsi + w.macd + w.supertrend + w.bollinger + w.vwap + w.momentum;
    if (nonVol > 0) { const s = (nonVol + w.volume) / nonVol;
      w = { ...w, ema: w.ema * s, rsi: w.rsi * s, macd: w.macd * s, supertrend: w.supertrend * s,
            bollinger: w.bollinger * s, vwap: w.vwap * s, momentum: w.momentum * s, volume: 0 }; }
  }
  let comp = v.ema_vote * w.ema + v.rsi_vote * w.rsi + v.macd_vote * w.macd + v.st_vote * w.supertrend
           + v.bb_vote * w.bollinger + v.vwap_vote * w.vwap + v.momentum_vote * w.momentum + v.volume_vote * w.volume;

  const votes = [v.ema_vote, v.rsi_vote, v.macd_vote, v.st_vote, v.bb_vote, v.vwap_vote, v.momentum_vote, v.volume_vote];
  const bull = votes.filter(x => x > 0.1).length, bear = votes.filter(x => x < -0.1).length;
  const bonus = (bull >= 7 || bear >= 7) ? 0.12 : (bull >= 6 || bear >= 6) ? 0.08 : (bull >= 5 || bear >= 5) ? 0.04 : 0;
  comp = comp > 0 ? comp + bonus : comp < 0 ? comp - bonus : comp;

  const volPct = v.atr > 0 && v.close > 0 ? v.atr / v.close : 0;
  const volF = volPct > 0.03 ? -0.05 : volPct < 0.01 ? 0.03 : 0;
  const liqF = v.volR > 2 ? 0.05 : v.volR < 0.5 ? -0.05 : 0;
  return comp + v.brk * 0.08 + volF + liqF;
}

// ════════════════════════ statistics ════════════════════════
function rank(a) {                       // average ranks, ties shared
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(x, y) {
  const n = x.length; if (n < 3) return NaN;
  const rx = rank(x), ry = rank(y);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx === 0 || dy === 0) ? NaN : num / Math.sqrt(dx * dy);
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const std = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

// ════════════════════════ data ════════════════════════
async function fetchDaily(sym, years) {
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - Math.round(years * 365.25 * 86400);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&period1=${p1}&period2=${p2}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const j = await res.json();
    const r = j?.chart?.result?.[0]; if (!r?.timestamp) return null;
    const q = r.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
      if ([o, h, l, c].some(x => x == null) || !(c > 0)) continue;
      bars.push({ t: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), o, h, l, c, v: v ?? 0 });
    }
    return bars.length > 120 ? bars : null;
  } catch { return null; }
}

// ════════════════════════ data source ════════════════════════
let _barsCache = null;
async function loadBars() {
  if (_barsCache) return _barsCache;           // both modes measure the SAME bars

  if (SOURCE === 'breeze') {
    const f = new URL(`./.cache/breeze-${BREEZE_INTERVAL}.json`, import.meta.url);
    let raw;
    try { raw = JSON.parse(await (await import('fs/promises')).readFile(f, 'utf8')); }
    catch {
      console.error(`
  No Breeze cache at .cache/breeze-${BREEZE_INTERVAL}.json`);
      console.error('  Fetch it first:');
      console.error(`    node scripts/fetch-breeze-history.mjs --interval ${BREEZE_INTERVAL} --days 180
`);
      process.exit(1);
    }
    const kept = Object.fromEntries(Object.entries(raw).filter(([, b]) => b.length > 120));
    console.log(`loaded Breeze ${BREEZE_INTERVAL}: ${Object.keys(kept).length} symbols`);
    _barsCache = kept;
    return kept;
  }

  const { default: universe } = await import('../../engine/data/nse_universe.json', { with: { type: 'json' } });
  const syms = universe.filter(u => u.cap === 'large').slice(0, MAX_SYMBOLS).map(u => u.symbol);
  process.stdout.write(`fetching ${syms.length} symbols (${YEARS}y daily from Yahoo)`);
  const data = {};
  for (let i = 0; i < syms.length; i += 8) {
    const batch = await Promise.all(syms.slice(i, i + 8).map(async x => [x, await fetchDaily(x, YEARS)]));
    for (const [x, b] of batch) if (b) data[x] = b;
    process.stdout.write('.');
  }
  console.log(` got ${Object.keys(data).length}`);
  _barsCache = data;
  return data;
}

// ════════════════════════ main ════════════════════════
async function run(mode) {
  const data = await loadBars();

  const stFn = mode === 'fixed' ? supertrendFixed : supertrendBuggy;
  const vwFn = mode === 'fixed' ? vwapFixed : vwapBuggy;

  // per-date cross-section: date -> [{score, votes, fwd:{h:ret}}]
  const byDate = new Map();
  let obs = 0;
  for (const [sym, bars] of Object.entries(data)) {
    const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l);
    const ind = { e9: ema(c, 9), e21: ema(c, 21), rsi: rsi(c, 14), macd: macd(c),
                  bb: boll(c, 20), atr: atr(h, l, c, 14), st: stFn(h, l, c, 10, 3.0), vwap: vwFn(bars) };
    const maxH = Math.max(...HORIZONS);
    for (let i = 30; i < bars.length - maxH; i++) {
      const v = computeVotes(bars, ind, i); if (!v) continue;
      const score = composite(v);
      const fwd = {}; for (const hz of HORIZONS) fwd[hz] = bars[i + hz].c / bars[i].c - 1;
      if (!byDate.has(bars[i].t)) byDate.set(bars[i].t, []);
      byDate.get(bars[i].t).push({ score, v, fwd });
      obs++;
    }
  }

  // cross-sectional IC per date
  const out = {};
  const voteKeys = ['ema_vote', 'rsi_vote', 'macd_vote', 'st_vote', 'bb_vote', 'vwap_vote', 'momentum_vote', 'volume_vote'];
  for (const hz of HORIZONS) {
    const ics = [], voteIcs = Object.fromEntries(voteKeys.map(k => [k, []]));
    for (const [, rows] of byDate) {
      if (rows.length < 10) continue;                       // need a real cross-section
      const y = rows.map(r => r.fwd[hz]);
      const ic = spearman(rows.map(r => r.score), y);
      if (isFinite(ic)) ics.push(ic);
      for (const k of voteKeys) {
        const vi = spearman(rows.map(r => r.v[k]), y);
        if (isFinite(vi)) voteIcs[k].push(vi);
      }
    }
    out[hz] = { ics, voteIcs };
  }
  return { out, obs, dates: byDate.size, symbols: Object.keys(data).length };
}

function report(label, res) {
  const { out, obs, dates, symbols } = res;
  console.log(`\n${'═'.repeat(72)}\n  ${label}`);
  console.log(`  source: ${SOURCE === 'breeze' ? 'Breeze ' + BREEZE_INTERVAL : 'Yahoo daily'} · ${symbols} symbols · ${dates} cross-sections · ${obs.toLocaleString()} observations\n${'═'.repeat(72)}`);
  console.log(`  COMPOSITE  (cross-sectional Spearman IC vs forward return, horizons in BARS)`);
  console.log('  horizon    mean IC    std     t-stat   days   verdict');
  for (const hz of HORIZONS) {
    const a = out[hz].ics; if (a.length < 2) continue;
    const m = mean(a), s = std(a), t = m / (s / Math.sqrt(a.length));
    const verdict = Math.abs(t) < 2 ? 'indistinguishable from noise'
      : Math.abs(m) < 0.02 ? 'statistically real, economically tiny'
      : 'worth investigating';
    console.log(`  ${String(hz + 'd').padEnd(10)} ${m.toFixed(4).padStart(8)} ${s.toFixed(4).padStart(7)} ${t.toFixed(2).padStart(8)} ${String(a.length).padStart(6)}   ${verdict}`);
  }
  const hz = 5, vk = out[hz].voteIcs;
  console.log(`\n  PER-VOTE IC at ${hz}d  (which inputs carry any signal at all)`);
  const rows = Object.entries(vk).map(([k, a]) => { const m = mean(a), s = std(a); return { k, m, t: m / (s / Math.sqrt(a.length)) }; })
    .sort((x, y) => Math.abs(y.m) - Math.abs(x.m));
  for (const r of rows) console.log(`    ${r.k.replace('_vote', '').padEnd(12)} IC ${r.m.toFixed(4).padStart(8)}   t ${r.t.toFixed(2).padStart(7)}`);
}

const results = {};
if (MODE === 'buggy' || MODE === 'both') { results.buggy = await run('buggy'); report('AS SHIPPED  (broken supertrend, cumulative VWAP)', results.buggy); }
if (MODE === 'fixed' || MODE === 'both') { results.fixed = await run('fixed'); report('WITH FIXES  (ratcheted supertrend, session VWAP)', results.fixed); }

if (results.buggy && results.fixed) {
  console.log(`\n${'═'.repeat(72)}\n  DID THE FIXES HELP?\n${'═'.repeat(72)}`);
  for (const hz of HORIZONS) {
    const b = mean(results.buggy.out[hz].ics), f = mean(results.fixed.out[hz].ics);
    console.log(`  ${String(hz + 'd').padEnd(5)} IC ${b.toFixed(4)} → ${f.toFixed(4)}   (${f - b >= 0 ? '+' : ''}${(f - b).toFixed(4)})`);
  }
}
