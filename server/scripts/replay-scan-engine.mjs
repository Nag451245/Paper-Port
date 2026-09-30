/**
 * Replay the REAL Rust scanner over history and measure every signal family.
 *
 * Every earlier number came from a JavaScript port of scan.rs. This asks the
 * engine binary itself — the one production runs — via the `scan_replay`
 * command (engine/src/scan_replay.rs), then computes forward returns here.
 *
 * It also measures what the port cannot: scan.rs emits SEVEN families
 * (composite, orb, mean_reversion, gap_trading, vwap_reversion,
 * volatility_breakout, sector_rotation). The port covers three.
 *
 *   --compare-port   also run the JS port on the same windows and report how
 *                    closely it agrees with the engine. This is the test of
 *                    whether the port-based measurements were trustworthy.
 *   --port-fixed false   compare against the PRE-fix indicators, i.e. when
 *                    replaying an old published binary.
 *
 * The binary must run on this machine. The engine is released as a Linux
 * executable, so on Windows use WSL or Linux, or build it with
 * `cargo build --release` in engine/. CI (.github/workflows/ci.yml) also
 * uploads it as the `capital-guard-engine` artifact on every run.
 *
 * Usage:
 *   node scripts/replay-scan-engine.mjs --years 3 --cap large --compare-port
 *   node scripts/replay-scan-engine.mjs --source breeze --interval 5minute
 *   node scripts/replay-scan-engine.mjs --engine /path/to/capital-guard-engine
 *   --engine may also be a Node script speaking the same stdin/stdout protocol;
 *   that is how the driver itself is tested without a native binary.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as L from './lib/signal-research.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes(k);

const SOURCE = arg('--source', 'yahoo');
const INTERVAL = arg('--interval', '5minute');
const CAP = arg('--cap', 'large');
const YEARS = Number(arg('--years', 3));
const MAX_SYMBOLS = Number(arg('--symbols', 1000));
const WINDOW = Number(arg('--window', L.PRODUCTION_WINDOW));
const AGGR = arg('--aggressiveness', 'high');
const CHUNK = Number(arg('--chunk', 200));          // timestamps per engine call (bounds payload size)
const COMPARE = flag('--compare-port');
const PORT_FIXED = arg('--port-fixed', 'true') !== 'false';
const H = [1, 5, 20];
const ROOT = path.resolve(import.meta.dirname, '..', '..');

// ── locate and VERIFY the engine (presence is not health) ──
function candidates() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const list = [];
  if (arg('--engine')) list.push(path.resolve(arg('--engine')));
  for (const base of [path.join(ROOT, 'engine', 'target', 'release'), path.join(ROOT, 'server', 'bin')]) {
    list.push(path.join(base, 'capital-guard-engine' + exe));
    if (exe) list.push(path.join(base, 'capital-guard-engine'));
  }
  return [...new Set(list)].filter(p => fs.existsSync(p));
}

function call(bin, command, data, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    let proc;
    // A .mjs/.js engine is a protocol-compatible stand-in, used to test this driver itself.
    const isScript = /\.m?js$/i.test(bin);
    try { proc = isScript ? spawn(process.execPath, [bin], { stdio: ['pipe', 'pipe', 'pipe'] }) : spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { reject(e); return; }
    const out = [], err = [];
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`engine timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    proc.stdout.on('data', c => out.push(c));
    proc.stderr.on('data', c => err.push(c));
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8').trim();
      if (code !== 0) { reject(new Error(`engine exited ${code}: ${Buffer.concat(err).toString('utf8').slice(-400)}`)); return; }
      // stdout should be pure JSON; tolerate stray lines by taking the last JSON line
      const line = text.startsWith('{') && text.endsWith('}') ? text : text.split('\n').reverse().find(l => l.trim().startsWith('{'));
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`engine returned non-JSON: ${text.slice(0, 200)}`)); }
    });
    proc.stdin.on('error', () => {});                  // surfaced via 'error'/'close'
    proc.stdin.end(JSON.stringify({ id: 'replay', command, data }));
  });
}

async function findEngine() {
  const found = candidates();
  if (found.length === 0) return { error: 'no engine binary found (looked in engine/target/release and server/bin)' };
  const reasons = [];
  for (const bin of found) {
    try {
      const r = await call(bin, 'health', {}, 20000);
      if (r && typeof r === 'object' && 'success' in r) return { bin };
      reasons.push(`${bin}: unexpected reply`);
    } catch (e) {
      const hint = /ENOENT|EACCES|ENOEXEC|not a valid Win32/i.test(e.message)
        ? ' — this binary cannot run on this OS (the release build is a Linux executable)' : '';
      reasons.push(`${bin}: ${e.message}${hint}`);
    }
  }
  return { error: reasons.join('\n    ') };
}

// ── data ──
async function loadData() {
  if (SOURCE === 'breeze') {
    const d = L.loadBreeze(INTERVAL);
    if (!d) { console.error(`\n  No Breeze cache. Run: node scripts/fetch-breeze-history.mjs --interval ${INTERVAL}\n`); process.exit(1); }
    return { data: d, from: null, label: `Breeze ${INTERVAL}` };
  }
  const start = L.yearsAgo(YEARS), end = L.ymd(new Date());
  const warm = L.ymd(new Date(new Date(start + 'T00:00:00Z').getTime() - 120 * 86400000));
  const syms = await L.loadUniverse(CAP, MAX_SYMBOLS);
  process.stdout.write(`  fetching ${syms.length} ${CAP} caps`);
  const data = await L.fetchUniverseDaily(syms, warm, end, { onProgress: () => process.stdout.write('.') });
  console.log(` ${Object.keys(data).length} usable`);
  return { data, from: start, label: `Yahoo daily ${CAP} caps ${start} → ${end}` };
}

const lowerBound = (bars, t) => { let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; } return lo; };
const toEngine = b => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });

// ── chunked replay: every chunk carries enough history for full windows ──
async function replay(bin, data, from) {
  const all = [...new Set(Object.values(data).flatMap(b => b.map(x => x.t)))].sort().filter(t => !from || t >= from);
  const signals = new Map();        // "SYM|ts" -> [{strategy, direction, confidence, votes}]
  let evaluated = 0, calls = 0, errorCount = 0; const errors = [];
  process.stdout.write(`  replaying ${all.length} timestamps in chunks of ${CHUNK}`);
  for (let k = 0; k < all.length; k += CHUNK) {
    const a = all[k], b = all[k + CHUNK];                     // [a, b); b undefined on the last chunk
    const symbols = [];
    for (const [symbol, bars] of Object.entries(data)) {
      const lo = lowerBound(bars, a), hi = b ? lowerBound(bars, b) : bars.length;
      if (hi <= lo) continue;
      symbols.push({ symbol, candles: bars.slice(Math.max(0, lo - WINDOW + 1), hi).map(toEngine) });
    }
    if (!symbols.length) continue;
    const payload = { symbols, window: WINDOW, aggressiveness: AGGR, from: a };
    if (b) payload.to = b;
    const res = await call(bin, 'scan_replay', payload);
    if (!res.success) throw new Error(`scan_replay failed on chunk starting ${a}: ${res.error}`);
    const d = res.data;
    evaluated += d.evaluated; calls += d.calls; errorCount += d.error_count ?? 0;
    for (const e of d.errors ?? []) if (errors.length < 10) errors.push(e);
    for (const s of d.signals) {
      const key = `${s.symbol}|${s.timestamp}`;
      (signals.get(key) || signals.set(key, []).get(key)).push(s);
    }
    process.stdout.write('.');
  }
  console.log('');
  return { signals, evaluated, calls, errorCount, errors };
}

// ── rebuild the evaluated grid with the SAME rule scan_replay.rs uses ──
function grid(data, from) {
  const rows = [];
  for (const [sym, bars] of Object.entries(data)) {
    for (let i = WINDOW - 1; i < bars.length; i++) {
      if (from && bars[i].t < from) continue;
      rows.push({ sym, i, t: bars[i].t,
        fwd: Object.fromEntries(H.map(h => [h, i + h < bars.length ? bars[i + h].c / bars[i].c - 1 : NaN])) });
    }
  }
  return rows;
}

// ── statistics ──
const pctS = x => isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(3)}%` : '    n/a';
const tS = x => isFinite(x) ? x.toFixed(2) : 'n/a';

function report(rows, signals) {
  const byTs = new Map();
  for (const r of rows) if (isFinite(r.fwd[5])) (byTs.get(r.t) || byTs.set(r.t, []).get(r.t)).push(r);
  const bench = new Map([...byTs].map(([t, rs]) => [t, L.mean(rs.map(r => r.fwd[5]))]));
  const rowAt = new Map(rows.map(r => [`${r.sym}|${r.t}`, r]));

  // abnormal 5-bar return of each signal, aggregated per timestamp (clusters same-time signals)
  const fam = new Map();
  for (const [key, list] of signals) {
    const r = rowAt.get(key); if (!r || !isFinite(r.fwd[5]) || !bench.has(r.t)) continue;
    const abn = r.fwd[5] - bench.get(r.t);
    for (const s of list) {
      const f = fam.get(s.strategy) || fam.set(s.strategy, { BUY: new Map(), SELL: new Map(), n: 0 }).get(s.strategy);
      f.n++;
      const m = f[s.direction]; if (!m) continue;
      (m.get(r.t) || m.set(r.t, []).get(r.t)).push(abn);
    }
  }
  console.log('\n  PER FAMILY — abnormal 5-bar return vs same-time equal weight (good BUY > 0, good SELL < 0)');
  console.log('  family                 signals    BUY: n   mean abn     t     SELL: n   mean abn     t');
  for (const [name, f] of [...fam].sort((a, b) => b[1].n - a[1].n)) {
    const side = m => { const per = [...m.values()].map(L.mean); const n = [...m.values()].reduce((a, v) => a + v.length, 0);
      return `${String(n).padStart(8)} ${pctS(L.mean(per)).padStart(10)} ${tS(L.tstat(per)).padStart(6)}`; };
    console.log(`  ${name.padEnd(22)} ${String(f.n).padStart(7)}  ${side(f.BUY)}    ${side(f.SELL)}`);
  }

  // composite as a cross-sectional score (0 where it did not clear the threshold)
  const cByTs = new Map();
  for (const [t, rs] of byTs) cByTs.set(t, rs.map(r => {
    const c = (signals.get(`${r.sym}|${r.t}`) || []).find(s => s.strategy === 'composite');
    return { s: c ? (c.direction === 'BUY' ? c.confidence : -c.confidence) : 0, f: r.fwd[5] };
  }));
  const ic = L.crossSectionalIC(cByTs, x => x.s, x => x.f);
  console.log(`\n  composite IC (5 bars, emitted signals only, others scored 0): ${ic.mean >= 0 ? '+' : ''}${ic.mean.toFixed(4)}  t ${tS(ic.t)}  over ${ic.n} cross-sections`);

  // same stock, same bar, opposite directions
  let withSig = 0, conflicts = 0; const pairs = new Map();
  for (const list of signals.values()) {
    withSig++;
    const buys = list.filter(s => s.direction === 'BUY'), sells = list.filter(s => s.direction === 'SELL');
    if (buys.length && sells.length) {
      conflicts++;
      for (const b of buys) for (const s of sells) { const k = `${b.strategy} BUY + ${s.strategy} SELL`; pairs.set(k, (pairs.get(k) || 0) + 1); }
    }
  }
  console.log(`\n  CONFLICTS — same stock, same bar, BUY and SELL at once: ${conflicts} of ${withSig} signal-bearing bars (${(conflicts / Math.max(withSig, 1) * 100).toFixed(1)}%)`);
  for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`    ${String(n).padStart(6)}  ${k}`);
}

// ── port fidelity: does the JS port reproduce the engine? ──
function comparePort(data, rows, signals) {
  const th = L.THRESHOLDS[AGGR] ?? L.THRESHOLDS.high;
  const FAM = ['composite', 'mean_reversion', 'vwap_reversion'];
  const st = Object.fromEntries(FAM.map(f => [f, { both: 0, engineOnly: 0, portOnly: 0, dirAgree: 0, dConf: [] }]));
  let exact = 0; const examples = [];
  process.stdout.write(`  running the port over ${rows.length} windows`);
  let n = 0;
  for (const r of rows) {
    if (++n % 20000 === 0) process.stdout.write('.');
    const p = L.scoreAt(data[r.sym], r.i, { window: WINDOW, fixed: PORT_FIXED, th });
    const port = p ? L.emittedSignals(p.votes, p.score, th) : [];
    const eng = (signals.get(`${r.sym}|${r.t}`) || []).filter(s => FAM.includes(s.strategy));
    let same = true;
    for (const f of FAM) {
      const e = eng.find(s => s.strategy === f), q = port.find(s => s.strategy === f);
      if (e && q) { st[f].both++; if (e.direction === q.direction) st[f].dirAgree++; else same = false; st[f].dConf.push(Math.abs(e.confidence - q.confidence)); if (Math.abs(e.confidence - q.confidence) > 0.0015) same = false; }
      else if (e) { st[f].engineOnly++; same = false; }
      else if (q) { st[f].portOnly++; same = false; }
    }
    if (same) exact++; else if (examples.length < 5) examples.push({ sym: r.sym, t: r.t, engine: eng, port, score: p?.score });
  }
  console.log('');
  console.log(`\n  PORT vs ENGINE (port indicators: ${PORT_FIXED ? 'FIXED' : 'as-shipped'}) — ${rows.length} windows, ${(exact / rows.length * 100).toFixed(2)}% identical`);
  console.log('  family              both   engine-only   port-only   direction agrees   mean |Δconf|');
  for (const f of FAM) {
    const s = st[f];
    console.log(`  ${f.padEnd(18)} ${String(s.both).padStart(6)} ${String(s.engineOnly).padStart(12)} ${String(s.portOnly).padStart(11)} ${(s.both ? s.dirAgree / s.both * 100 : 100).toFixed(2).padStart(17)}% ${(s.dConf.length ? L.mean(s.dConf) : 0).toFixed(4).padStart(13)}`);
  }
  for (const x of examples) console.log(`    mismatch ${x.sym} ${x.t}: engine=${JSON.stringify(x.engine.map(s => [s.strategy, s.direction, s.confidence]))} port=${JSON.stringify(x.port.map(s => [s.strategy, s.direction, s.confidence]))} score=${x.score?.toFixed(4)}`);
  const verdict = exact / rows.length >= 0.995 ? 'FAITHFUL — port-based measurements stand'
    : 'DIVERGES — port-based numbers must be re-checked against the engine';
  console.log(`\n  VERDICT: ${verdict}`);
}

// ── main ──
const eng = await findEngine();
if (eng.error) {
  console.error(`\n  Cannot run the engine here:\n    ${eng.error}\n`);
  console.error('  Options: run this on Linux/WSL; build it with `cargo build --release` in engine/;');
  console.error('  or download the `capital-guard-engine` artifact from a CI run and pass --engine <path>.\n');
  process.exit(2);
}
console.log(`\n  engine: ${eng.bin}`);
const { data, from, label } = await loadData();
const rp = await replay(eng.bin, data, from);
const rows = grid(data, from);
console.log(`  ${label} · window ${WINDOW} · ${AGGR} · ${rp.calls} scan calls · ${rp.evaluated} windows evaluated · ${rp.errorCount} engine errors`);
if (rows.length !== rp.evaluated) {
  console.error(`\n  CONSISTENCY FAILURE: engine evaluated ${rp.evaluated} windows, this script expects ${rows.length}.`);
  console.error('  The evaluation grids disagree, so forward returns would attach to the wrong bars. Not reporting.\n');
  process.exit(3);
}
for (const e of rp.errors) console.log(`    engine error: ${e}`);
report(rows, rp.signals);
if (COMPARE) comparePort(data, rows, rp.signals);
console.log('');
