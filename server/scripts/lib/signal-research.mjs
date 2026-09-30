/**
 * Shared research library for signal measurement.
 *
 * ONE port of engine/src/scan.rs lives here, used by every research script, so
 * the measurement, the contrarian test and the engine-comparison all evaluate
 * exactly the same code. If scan.rs changes, change it here and re-run
 * replay-scan-engine.mjs --compare-port to prove the port still agrees.
 *
 * PRODUCTION FIDELITY: the live bot hands scan.rs only the last 50 completed
 * bars (bot-engine.ts: completedBars(bars).slice(-50)). Indicators seeded on 50
 * bars differ from indicators seeded on years of history, and the broken
 * VWAP/Supertrend depend entirely on where the window starts. scoreAt() takes a
 * `window` for that reason; 50 reproduces production, 0 means full history.
 */

// ════════════════════ thresholds / weights (scan.rs) ════════════════════
export const THRESHOLDS = {
  high:   { min_confidence: 0.30, rsi_oversold: 40, rsi_overbought: 60, rsi_strong_oversold: 35, rsi_strong_overbought: 65, momentum_candles: 2, volume_surge_ratio: 1.2 },
  medium: { min_confidence: 0.40, rsi_oversold: 30, rsi_overbought: 70, rsi_strong_oversold: 25, rsi_strong_overbought: 75, momentum_candles: 3, volume_surge_ratio: 1.5 },
};
const RAW_W = { ema: 0.15, rsi: 0.10, macd: 0.10, supertrend: 0.10, bollinger: 0.05, vwap: 0.05, momentum: 0.25, volume: 0.20 };
const WSUM = Object.values(RAW_W).reduce((a, b) => a + b, 0);
export const WEIGHTS = Object.fromEntries(Object.entries(RAW_W).map(([k, v]) => [k, v / WSUM]));
export const PRODUCTION_WINDOW = 50;

// ════════════════════ indicators (utils.rs / signals.rs) ════════════════════
export const ema = (d, p) => { const r = new Array(d.length).fill(NaN); if (d.length < p) return r;
  const m = 2 / (p + 1); r[p - 1] = d.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < d.length; i++) r[i] = (d[i] - r[i - 1]) * m + r[i - 1]; return r; };

export const rsi = (d, p) => { const n = d.length, r = new Array(n).fill(NaN); if (n < p + 1) return r;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const ch = d[i] - d[i - 1]; if (ch > 0) g += ch; else l -= ch; }
  g /= p; l /= p; r[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < n; i++) { const ch = d[i] - d[i - 1];
    g = (g * (p - 1) + Math.max(ch, 0)) / p; l = (l * (p - 1) + Math.max(-ch, 0)) / p;
    r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return r; };

export const atr = (h, l, c, p) => { const n = c.length, tr = new Array(n).fill(0), a = new Array(n).fill(0);
  if (n === 0) return a; tr[0] = h[0] - l[0];
  for (let i = 1; i < n; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  if (n >= p) { a[p - 1] = tr.slice(0, p).reduce((x, y) => x + y, 0) / p;
    for (let i = p; i < n; i++) a[i] = (a[i - 1] * (p - 1) + tr[i]) / p; } return a; };

export const macd = (d) => { const e12 = ema(d, 12), e26 = ema(d, 26);
  const line = d.map((_, i) => (isNaN(e12[i]) || isNaN(e26[i])) ? NaN : e12[i] - e26[i]);
  const sig = ema(line.map(v => isNaN(v) ? 0 : v), 9);
  const hist = d.map((_, i) => (isNaN(line[i]) || isNaN(sig[i])) ? NaN : line[i] - sig[i]);
  return { line, sig, hist }; };

export const boll = (d, p) => { const n = d.length, u = new Array(n).fill(0), lo = new Array(n).fill(0);
  for (let i = p - 1; i < n; i++) { const w = d.slice(i - p + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / p;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / p);
    u[i] = m + 2 * sd; lo[i] = m - 2 * sd; } return { u, lo }; };

/** AS SHIPPED — compares close to the same bar's basic bands; never flips. */
export const supertrendBuggy = (h, l, c, p, m) => { const n = c.length, r = new Array(n).fill(0);
  if (n < p) return r; const a = atr(h, l, c, p);
  for (let i = p; i < n; i++) { const hl2 = (h[i] + l[i]) / 2, up = hl2 + m * a[i], low = hl2 - m * a[i];
    r[i] = c[i] > up ? low : (c[i] < low ? up : r[i - 1]); if (r[i] === 0) r[i] = low; } return r; };

/** FIXED — ratcheted final bands + persistent trend state (patched signals.rs). */
export const supertrendFixed = (h, l, c, p, m) => { const n = c.length, r = new Array(n).fill(0);
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

/** AS SHIPPED — cumulative from the first bar of whatever window it is given. */
export const vwapBuggy = (bars) => { let pv = 0, v = 0;
  return bars.map(b => { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; v += b.v; return v > 0 ? pv / v : b.c; }); };

/** FIXED — resets on each session (date prefix of the timestamp). */
export const vwapFixed = (bars) => { let pv = 0, v = 0, key = null;
  return bars.map(b => { const k = (b.t || '').slice(0, 10);
    if (k !== key) { key = k; pv = 0; v = 0; }
    const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; v += b.v; return v > 0 ? pv / v : b.c; }); };

// ════════════════════ per-bar helpers (scan.rs) ════════════════════
/** calc_atr_candles: a PLAIN mean of the last `p` true ranges — not Wilder ATR. */
export function atrCandlesAt(bars, i, p) {
  if (i + 1 < p + 1) return 0;
  let s = 0;
  for (let k = i + 1 - p; k <= i; k++) {
    s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  }
  return s / p;
}
export function momentumAt(bars, i, lookback) {
  if (i + 1 < lookback + 1) return 0;
  const start = i + 1 - lookback;
  let green = 0, total = 0;
  const avg = bars.slice(start, i + 1).reduce((a, b) => a + b.c, 0) / lookback;
  for (let k = start; k <= i; k++) {
    const p = k > 0 ? k - 1 : 0;
    if (bars[k].c > bars[p].c) green++; else green--;
    if (avg > 0) total += (bars[k].c - bars[p].c) / avg * 100;
  }
  return Math.max(-1, Math.min(1, (green / lookback) * 0.6 + (Math.max(-2, Math.min(2, total / lookback)) / 2) * 0.4));
}
export function volumeRatioAt(bars, i, lookback) {
  if (i + 1 < lookback + 1) return 1;
  const avg = bars.slice(i - lookback, i).reduce((a, b) => a + b.v, 0) / lookback;
  return avg > 0 ? bars[i].v / avg : 1;
}
export function breakoutAt(bars, i, lookback) {
  if (i + 1 < lookback + 1) return 0;
  const w = bars.slice(i - lookback, i);
  const hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
  const c = bars[i].c;
  if (bars[i].h > hi) return Math.min((c - hi) / hi * 100 * 2, 1);
  if (bars[i].l < lo) return -Math.min((lo - c) / lo * 100 * 2, 1);
  return 0;
}

// ════════════════════ indicator bundle ════════════════════
export function indicatorsFor(bars, fixed) {
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l);
  return {
    e9: ema(c, 9), e21: ema(c, 21), rsi: rsi(c, 14), macd: macd(c), bb: boll(c, 20),
    st: (fixed ? supertrendFixed : supertrendBuggy)(h, l, c, 10, 3.0),
    vwap: (fixed ? vwapFixed : vwapBuggy)(bars),
  };
}

/** Evaluate scan.rs at bar i of `bars` using a precomputed bundle. null = scan would `continue`. */
export function evalAt(bars, ind, i, th = THRESHOLDS.high) {
  if (i < 1) return null;
  const c = bars[i].c;
  const ema9 = ind.e9[i], ema21 = ind.e21[i], ema9p = ind.e9[i - 1], ema21p = ind.e21[i - 1];
  const r = ind.rsi[i];
  const m = ind.macd.line[i], ms = ind.macd.sig[i], mp = ind.macd.line[i - 1], msp = ind.macd.sig[i - 1];
  const mh = ind.macd.hist[i], mhp = ind.macd.hist[i - 1];
  const st = ind.st[i], bu = ind.bb.u[i], bl = ind.bb.lo[i], vw = ind.vwap[i];
  if (!isFinite(ema21) || ema21 === 0 || st === 0 || bu === 0) return null;
  if ([ema9, ema21, ema9p, ema21p, r, m, ms, mp, msp, mh].some(v => !isFinite(v))) return null;

  const mom = momentumAt(bars, i, th.momentum_candles);
  const volR = volumeRatioAt(bars, i, 5);
  const brk = breakoutAt(bars, i, 10);
  const a = atrCandlesAt(bars, i, 14);

  let ema_vote;
  if (ema9 > ema21 && ema9p <= ema21p) ema_vote = 1;
  else if (ema9 < ema21 && ema9p >= ema21p) ema_vote = -1;
  else if (ema9 > ema21) ema_vote = Math.min(0.5 + Math.min((ema9 - ema21) / ema21 * 100 * 0.3, 0.5), 1);
  else if (ema9 < ema21) ema_vote = -Math.min(0.5 + Math.min((ema21 - ema9) / ema21 * 100 * 0.3, 0.5), 1);
  else ema_vote = 0;

  let rsi_vote;
  if (r < th.rsi_strong_oversold) rsi_vote = 0.8;
  else if (r < th.rsi_oversold) rsi_vote = 0.5;
  else if (r > th.rsi_strong_overbought) rsi_vote = -0.8;
  else if (r > th.rsi_overbought) rsi_vote = -0.5;
  else { const mid = (th.rsi_oversold + th.rsi_overbought) / 2, half = (th.rsi_overbought - th.rsi_oversold) / 2;
    rsi_vote = half > 0 ? Math.max(-0.4, Math.min(0.4, (r - mid) / half * 0.4)) : 0; }

  let macd_vote;
  if (m > ms && mp <= msp) macd_vote = 1;
  else if (m < ms && mp >= msp) macd_vote = -1;
  else if (mh > 0) macd_vote = mh > mhp ? 0.7 : 0.3;
  else if (mh < 0) macd_vote = mh < mhp ? -0.7 : -0.3;
  else macd_vote = 0;

  const st_vote = c > st ? 1 : -1;

  let bb_vote = 0; const range = bu - bl, bbMid = (bu + bl) / 2;
  if (range > 0) { const pos = (c - bl) / range;
    if (pos > 0.9 && mom > 0.5) bb_vote = 0.9;
    else if (pos > 0.8) bb_vote = 0.5;
    else if (pos < 0.1 && mom < -0.5) bb_vote = -0.9;
    else if (pos < 0.2) bb_vote = -0.5;
    else bb_vote = c > bbMid ? 0.3 : -0.3; }

  const vp = vw > 0 ? (c - vw) / vw * 100 : 0;
  const vwap_vote = vp > 1 ? 1 : vp > 0.5 ? 0.7 : vp > 0 ? 0.4 : vp < -1 ? -1 : vp < -0.5 ? -0.7 : -0.4;

  let volume_vote;
  if (volR > th.volume_surge_ratio * 1.5) volume_vote = mom > 0 ? 1 : -1;
  else if (volR > th.volume_surge_ratio) volume_vote = mom > 0 ? 0.7 : -0.7;
  else if (volR > 1) volume_vote = mom > 0 ? 0.3 : -0.3;
  else volume_vote = 0;

  return { ema_vote, rsi_vote, macd_vote, st_vote, bb_vote, vwap_vote, momentum_vote: mom, volume_vote,
           brk, atr: a, close: c, volR, rsi: r, bbLower: bl, bbUpper: bu, bbMid, vwap: vw };
}

/** scan.rs composite, including the volume-weight redistribution and all bonus terms. */
export function composite(v, W = WEIGHTS) {
  let w = { ...W };
  if (Math.abs(v.volume_vote) < 0.001) {
    const nonVol = w.ema + w.rsi + w.macd + w.supertrend + w.bollinger + w.vwap + w.momentum;
    if (nonVol > 0) { const s = (nonVol + w.volume) / nonVol;
      w = { ema: w.ema * s, rsi: w.rsi * s, macd: w.macd * s, supertrend: w.supertrend * s,
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

/**
 * The live scanner's view at bar i: indicators rebuilt on the trailing `window`
 * bars exactly as production feeds them (window = 0 → full history).
 * Returns { votes, score } or null when scan.rs would skip the symbol.
 */
export function scoreAt(bars, i, { window = PRODUCTION_WINDOW, fixed = true, th = THRESHOLDS.high, fullInd = null } = {}) {
  let slice = bars, idx = i, ind = fullInd;
  if (window > 0) {
    const start = Math.max(0, i - window + 1);
    slice = bars.slice(start, i + 1);
    if (slice.length < 15) return null;          // scan.rs: candles.len() < 15 → skip
    idx = slice.length - 1;
    ind = indicatorsFor(slice, fixed);
  } else if (!ind) {
    ind = indicatorsFor(bars, fixed);
  }
  const v = evalAt(slice, ind, idx, th);
  return v ? { votes: v, score: composite(v) } : null;
}

// ════════════════════ production contrarian rules (scan.rs) ════════════════════
/** scan.rs "mean_reversion": RSI<30 & close<BB lower & volR>0.8 → BUY (mirror for SELL). */
export function meanReversionSignal(v) {
  if (v.rsi < 30 && v.close < v.bbLower && v.volR > 0.8) return +Math.min(0.5 + (30 - v.rsi) / 30 * 0.4, 0.9);
  if (v.rsi > 70 && v.close > v.bbUpper && v.volR > 0.8) return -Math.min(0.5 + (v.rsi - 70) / 30 * 0.4, 0.9);
  return 0;
}
/** scan.rs "vwap_reversion": >1% below VWAP & RSI<45 & volR>0.8 → BUY (mirror for SELL). */
export function vwapReversionSignal(v) {
  if (!(v.vwap > 0)) return 0;
  const dev = (v.close - v.vwap) / v.vwap * 100;
  if (dev < -1 && v.rsi < 45 && v.volR > 0.8) return +Math.min(0.5 + Math.abs(dev) / 3 * 0.3, 0.85);
  if (dev > 1 && v.rsi > 55 && v.volR > 0.8) return -Math.min(0.5 + Math.abs(dev) / 3 * 0.3, 0.85);
  return 0;
}

// ════════════════════ statistics ════════════════════
export function rank(a) {                      // average ranks; ties share
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length); let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1;
  }
  return r;
}
export function spearman(x, y) {
  const n = x.length; if (n < 3) return NaN;
  const rx = rank(x), ry = rank(y);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx === 0 || dy === 0) ? NaN : num / Math.sqrt(dx * dy);
}
export const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
export const std = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
export const tstat = a => { const s = std(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : NaN; };

/** Mean cross-sectional IC across dates. rows: [{score, fwd}] per date. */
export function crossSectionalIC(byDate, getScore, getFwd, minN = 10) {
  const ics = [];
  for (const rows of byDate.values()) {
    if (rows.length < minN) continue;
    const s = rows.map(getScore);
    if (new Set(s).size < 3) continue;          // no cross-sectional variation → IC undefined
    const ic = spearman(s, rows.map(getFwd));
    if (isFinite(ic)) ics.push(ic);
  }
  return { ics, mean: mean(ics), t: tstat(ics), n: ics.length };
}

// ════════════════════ data ════════════════════
import fs from 'fs';
import path from 'path';
const CACHE = path.join(import.meta.dirname, '..', '.cache');

export async function loadUniverse(cap = 'large', n = 1000) {
  const { default: u } = await import('../../../engine/data/nse_universe.json', { with: { type: 'json' } });
  return u.filter(x => x.cap === cap).slice(0, n).map(x => x.symbol);
}

/**
 * Daily bars from Yahoo for [start, end). Cached on disk so repeated runs are
 * reproducible — a regression check is meaningless if the data moved under it.
 */
export async function fetchDaily(sym, start, end) {
  const dir = path.join(CACHE, 'yahoo');
  const file = path.join(dir, `${sym}_${start}_${end}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const p1 = Math.floor(new Date(start + 'T00:00:00Z') / 1000), p2 = Math.floor(new Date(end + 'T00:00:00Z') / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}.NS?interval=1d&period1=${p1}&period2=${p2}`;
  let bars = null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const q = (await res.json())?.chart?.result?.[0];
      if (q?.timestamp) {
        const o = q.indicators.quote[0]; bars = [];
        for (let i = 0; i < q.timestamp.length; i++) {
          const [op, h, l, c, v] = [o.open[i], o.high[i], o.low[i], o.close[i], o.volume[i]];
          if ([op, h, l, c].some(x => x == null) || !(c > 0)) continue;
          bars.push({ t: new Date(q.timestamp[i] * 1000).toISOString().slice(0, 10), o: op, h, l, c, v: v ?? 0 });
        }
      }
    }
  } catch { bars = null; }
  if (bars && bars.length > 0) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(bars)); }
  return bars && bars.length > 120 ? bars : null;
}

export async function fetchUniverseDaily(syms, start, end, { onProgress } = {}) {
  const out = {};
  for (let i = 0; i < syms.length; i += 8) {
    const batch = await Promise.all(syms.slice(i, i + 8).map(async s => [s, await fetchDaily(s, start, end)]));
    for (const [s, b] of batch) if (b) out[s] = b;
    onProgress?.();
  }
  return out;
}

/** Breeze intraday cache written by fetch-breeze-history.mjs. */
export function loadBreeze(interval = '5minute') {
  const file = path.join(CACHE, `breeze-${interval}.json`);
  if (!fs.existsSync(file)) return null;
  return Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).filter(([, b]) => b.length > 120));
}

export const ymd = d => d.toISOString().slice(0, 10);
export const yearsAgo = (y, from = new Date()) => ymd(new Date(from.getTime() - Math.round(y * 365.25 * 86400000)));

// ════════════════════ what scan.rs actually EMITS at a bar ════════════════════
const round3 = x => Math.round(x * 1000) / 1000;

/**
 * The signals scan.rs pushes for one symbol at one bar, in production order.
 *
 * GATING (easy to miss): scan.rs checks the composite's confidence against
 * min_confidence and `continue`s the symbol loop if it falls short — BEFORE the
 * strategy-specific block. So mean_reversion / vwap_reversion (and the other
 * families) can only fire when the momentum composite ALSO clears the
 * threshold. On an oversold stock the composite is usually strongly negative,
 * which means production can emit a composite SELL and a mean-reversion BUY on
 * the same stock at the same bar.
 *
 * Only the families this library ports are returned (composite,
 * mean_reversion, vwap_reversion). orb, gap_trading, volatility_breakout and
 * sector_rotation are NOT ported — measure those with scan_replay.
 */
export function emittedSignals(v, score, th = THRESHOLDS.high) {
  if (!(score !== 0)) return [];
  const confidence = Math.min(Math.abs(score), 1);
  if (confidence < th.min_confidence) return [];                 // scan.rs `continue`
  const out = [{ strategy: 'composite', direction: score > 0 ? 'BUY' : 'SELL', confidence: round3(confidence) }];
  const mr = meanReversionSignal(v);
  if (mr !== 0 && Math.abs(mr) >= th.min_confidence) out.push({ strategy: 'mean_reversion', direction: mr > 0 ? 'BUY' : 'SELL', confidence: round3(Math.abs(mr)) });
  const vr = vwapReversionSignal(v);
  if (vr !== 0 && Math.abs(vr) >= th.min_confidence) out.push({ strategy: 'vwap_reversion', direction: vr > 0 ? 'BUY' : 'SELL', confidence: round3(Math.abs(vr)) });
  return out;
}
