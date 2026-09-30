/**
 * Pull real NSE intraday history from the ICICI Breeze bridge, in chunks.
 *
 * WHY CHUNKING IS NOT OPTIONAL
 * ----------------------------
 * breeze-bridge/app.py::get_historical_data issues ONE get_historical_data_v2
 * call for the whole from→to range and returns whatever comes back. Breeze caps
 * the number of records per call, so a request for months of 5-minute bars is
 * silently truncated — you get a short series and no error. This script asks in
 * small windows and stitches the results, so the truncation cannot hide.
 *
 * It also flags windows that return suspiciously few bars, because a partial
 * pull that looks successful is exactly how a backtest ends up fitted to three
 * weeks of data while believing it saw a year.
 *
 * PREREQUISITES (yours, not mine — I never handle your credentials)
 *   1. server/.env has BREEZE_API_KEY and BREEZE_SECRET_KEY set
 *   2. the Python bridge is running:  cd server/breeze-bridge && .venv/Scripts/python.exe app.py
 *   3. the bridge has a live session — Breeze sessions expire daily; generate one
 *      from the app (Settings → Breeze → Generate Session) or POST /init
 *
 * Usage:
 *   node scripts/fetch-breeze-history.mjs --interval 5minute --days 180 --symbols 60
 *   node scripts/fetch-breeze-history.mjs --interval 1day --days 1095
 *
 * Output: scripts/.cache/breeze-<interval>.json  (consumed by measure-signal-ic.mjs)
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BRIDGE = process.env.BREEZE_BRIDGE_URL || 'http://127.0.0.1:8001';
const INTERVAL = arg('--interval', '5minute');
const DAYS = Number(arg('--days', 180));
const MAX_SYMBOLS = Number(arg('--symbols', 60));
// Window size per request. Intraday packs ~75 bars/day at 5m, so keep windows
// small enough that a capped response is obvious rather than silently short.
const WINDOW_DAYS = Number(arg('--window', INTERVAL.includes('day') ? 365 : 7));
const PAUSE_MS = Number(arg('--pause', 350));   // Breeze rate limits; be polite

const CACHE_DIR = path.join(import.meta.dirname, '.cache');
const OUT = path.join(CACHE_DIR, `breeze-${INTERVAL}.json`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10);

async function bridgeUp() {
  try {
    const r = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { ok: false, why: `health returned HTTP ${r.status}` };
    const j = await r.json().catch(() => ({}));
    return { ok: true, session: j.session_active === true, detail: j };
  } catch (e) { return { ok: false, why: e.message }; }
}

async function fetchWindow(symbol, from, to) {
  const url = `${BRIDGE}/historical/${encodeURIComponent(symbol)}?interval=${INTERVAL}&from=${from}&to=${to}&exchange=NSE`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return { bars: [], error: `HTTP ${r.status}` };
    const j = await r.json();
    if (j.error) return { bars: [], error: j.error };
    return { bars: Array.isArray(j.bars) ? j.bars : [] };
  } catch (e) { return { bars: [], error: e.message }; }
}

async function fetchSymbol(symbol) {
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400000);
  const seen = new Map();            // timestamp -> bar (de-dupes overlapping windows)
  let windows = 0, empty = 0, errors = [];

  for (let cur = new Date(start); cur < end; cur = new Date(cur.getTime() + WINDOW_DAYS * 86400000)) {
    const wEnd = new Date(Math.min(cur.getTime() + WINDOW_DAYS * 86400000, end.getTime()));
    const { bars, error } = await fetchWindow(symbol, ymd(cur), ymd(wEnd));
    windows++;
    if (error) errors.push(error);
    if (bars.length === 0) empty++;
    for (const b of bars) {
      if (!(b.close > 0)) continue;
      seen.set(b.timestamp, { t: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0 });
    }
    await sleep(PAUSE_MS);
  }

  const out = [...seen.values()].sort((a, b) => a.t < b.t ? -1 : 1);
  return { bars: out, windows, empty, errors: [...new Set(errors)].slice(0, 3) };
}

// ── main ──
const health = await bridgeUp();
if (!health.ok) {
  console.error(`\n  Bridge not reachable at ${BRIDGE} — ${health.why}\n`);
  console.error('  Start it with:');
  console.error('    cd server/breeze-bridge && .venv/Scripts/python.exe app.py\n');
  process.exit(1);
}
if (!health.session) {
  console.error(`\n  Bridge is up but has NO ACTIVE BREEZE SESSION.`);
  console.error('  Breeze sessions expire daily. Generate one from the app');
  console.error('  (Settings → Breeze → Generate Session), then re-run.\n');
  console.error(`  Bridge reported: ${JSON.stringify(health.detail)}\n`);
  process.exit(1);
}

const { default: universe } = await import('../../engine/data/nse_universe.json', { with: { type: 'json' } });
const syms = universe.filter(u => u.cap === 'large').slice(0, MAX_SYMBOLS).map(u => u.symbol);

console.log(`\n  Breeze historical pull`);
console.log(`  interval ${INTERVAL} · ${DAYS}d · ${syms.length} symbols · ${WINDOW_DAYS}d windows\n`);

fs.mkdirSync(CACHE_DIR, { recursive: true });
const data = {}; const report = [];
for (const s of syms) {
  const r = await fetchSymbol(s);
  if (r.bars.length > 0) data[s] = r.bars;
  report.push({ s, n: r.bars.length, windows: r.windows, empty: r.empty, errors: r.errors });
  const flag = r.bars.length === 0 ? 'FAILED' : r.empty > r.windows / 2 ? 'MOSTLY EMPTY' : '';
  console.log(`  ${s.padEnd(14)} ${String(r.bars.length).padStart(7)} bars  ${String(r.empty)}/${r.windows} empty windows  ${flag}${r.errors.length ? ' :: ' + r.errors[0] : ''}`);
}

fs.writeFileSync(OUT, JSON.stringify(data));
const total = Object.values(data).reduce((a, b) => a + b.length, 0);
console.log(`\n  wrote ${OUT}`);
console.log(`  ${Object.keys(data).length} symbols · ${total.toLocaleString()} bars`);

const failed = report.filter(r => r.n === 0);
if (failed.length) {
  console.log(`\n  ${failed.length} symbol(s) returned nothing — likely an unmapped Breeze stock code.`);
  console.log(`  See BREEZE_STOCK_CODES in market-data.service.ts (RELIANCE→RELIND, BANKNIFTY→CNXBAN).`);
  console.log(`  ${failed.slice(0, 10).map(r => r.s).join(', ')}`);
}
