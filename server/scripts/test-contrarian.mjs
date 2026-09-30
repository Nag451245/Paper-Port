/**
 * Out-of-sample test of the contrarian hypothesis.
 *
 * ═══════════════════════ PRE-REGISTRATION ═══════════════════════
 * Written BEFORE any out-of-sample result was seen. Nothing below may be tuned
 * after looking at results; if the rules change, the test must be re-run on
 * fresh data, not on these samples.
 *
 * Where the hypothesis came from: on NSE large caps, 2023-09-29 → 2026-09-29,
 * the live composite (a momentum-weighted vote) had cross-sectional IC of about
 * -0.018 at 5 days, and RSI — its only contrarian input — was its only vote
 * with positive IC. That sample is therefore CONTAMINATED: it produced the idea,
 * so it cannot be evidence for it. It is reported for reference only.
 *
 * Hypotheses (all parameters fixed):
 *   H1 rsi_contrarian      score = -RSI(14)                     buy the most oversold
 *   H2 short_reversal      score = -(close[t] / close[t-5] - 1) buy last week's losers
 *   H3 composite_inverted  score = -composite (production 50-bar window, fixed indicators)
 *   H4 mean_reversion_rule the scan.rs "mean_reversion" BUY rule, exactly as it ships
 *                          (RSI<30, close < lower Bollinger band, volume ratio > 0.8)
 *   vwap_reversion is deliberately EXCLUDED: on daily bars a session VWAP is just
 *   that day's typical price, so the rule is degenerate. It can only be tested on
 *   intraday data (Breeze 5m).
 *
 * Samples (today's index constituents — see SURVIVORSHIP below):
 *   S0  IN-SAMPLE       large caps  2023-09-29 → 2026-09-29   reference only
 *   S1  OOS-TIME        large caps  2020-09-29 → 2023-09-29   earlier period, never examined
 *   S2  OOS-UNIVERSE    mid caps    2023-09-29 → 2026-09-29   different stocks
 *   S3  OOS-BOTH        mid caps    2020-09-29 → 2023-09-29   different stocks AND period
 *
 * Portfolio test (H1–H3): each 5 trading days, buy the top quintile by score,
 * equal weight, hold 5 days. LONG-ONLY, because Indian retail cannot hold short
 * cash-equity positions overnight; a long-short result would not be tradeable.
 * Benchmark: equal-weight all scored stocks over the same 5 days, so excess
 * return measures selection skill rather than market direction.
 * Costs: round trip 0.30% large caps, 0.40% mid caps (STT 0.1% sell, stamp
 * 0.015% buy, exchange/GST/SEBI, brokerage, ~5 bps slippage each side), charged
 * on turnover. Break-even cost is reported so the conclusion does not hinge on
 * that estimate.
 *
 * Significance: 4 hypotheses × 3 out-of-sample tests = 12 tests. Bonferroni at
 * 5% two-sided needs |t| > 2.87. Anything weaker is not evidence.
 *
 * DECISION RULE — a hypothesis is SUPPORTED only if ALL hold:
 *   (a) S2 net excess return is positive with t > 2.87   (primary: least biased sample)
 *   (b) S1 and S3 net excess are both positive            (holds across period and universe)
 *   (c) S2 5-day IC is positive                           (the ranking itself carries information)
 * Otherwise: NOT SUPPORTED, however good S0 looks.
 *
 * CORRECTION (made after the first run, disclosed here): H4 is specified as
 * the rule "exactly as it ships". The first run evaluated the rule on its own,
 * but in scan.rs the composite's min_confidence check 'continue's the symbol
 * loop BEFORE the strategy-specific block, so mean_reversion can only fire when
 * the composite also clears the threshold. The implementation now applies that
 * gating. This fixes the code to match the pre-registered spec; the spec, the
 * samples and the decision rule are unchanged. First-run H4 (ungated) verdict
 * was NOT SUPPORTED: S2 net +17.44% t=0.87, S1 -19.95%, S3 -41.16%.
 *
 * SURVIVORSHIP — read before believing any positive number:
 *   The universe is today's constituents. Stocks that fell and kept falling —
 *   delisted, or dropped out of the cap bucket — are absent from the past. For a
 *   strategy that BUYS LOSERS this bias is directly in its favour: it only ever
 *   "bought the dip" in companies we already know survived. The older samples
 *   (S1, S3) are the most exposed. A positive result here is an UPPER BOUND on
 *   the real edge, not an estimate of it. S2 is primary because it is both out of
 *   sample and recent enough that membership has drifted least.
 * ════════════════════════════════════════════════════════════════
 */
import * as L from './lib/signal-research.mjs';

const COST = { large: 0.0030, mid: 0.0040 };
const REBAL = 5;                  // trading days between rebalances
const PERIODS_PER_YEAR = 250 / REBAL;
const T_CRIT = 2.87;
const WARMUP_DAYS = 120;          // calendar days fetched before a sample starts
const FWD_PAD_DAYS = 45;          // calendar days fetched after it ends (forward returns)

const SAMPLES = [
  { id: 'S0', label: 'IN-SAMPLE (reference only)', cap: 'large', start: '2023-09-29', end: '2026-09-29', primary: false, oos: false },
  { id: 'S1', label: 'OOS-TIME',                   cap: 'large', start: '2020-09-29', end: '2023-09-29', primary: false, oos: true },
  { id: 'S2', label: 'OOS-UNIVERSE  [PRIMARY]',    cap: 'mid',   start: '2023-09-29', end: '2026-09-29', primary: true,  oos: true },
  { id: 'S3', label: 'OOS-BOTH',                   cap: 'mid',   start: '2020-09-29', end: '2023-09-29', primary: false, oos: true },
];

const HYP = ['rsi_contrarian', 'short_reversal', 'composite_inverted'];
const shift = (d, days) => L.ymd(new Date(new Date(d + 'T00:00:00Z').getTime() + days * 86400000));

// ── build the panel for one sample: date -> rows ──
async function buildPanel(sample) {
  const syms = await L.loadUniverse(sample.cap, 1000);
  process.stdout.write(`  ${sample.id} fetching ${syms.length} ${sample.cap} caps`);
  const data = await L.fetchUniverseDaily(syms, shift(sample.start, -WARMUP_DAYS), shift(sample.end, FWD_PAD_DAYS),
    { onProgress: () => process.stdout.write('.') });
  console.log(` ${Object.keys(data).length} usable`);

  const byDate = new Map();
  for (const [sym, bars] of Object.entries(data)) {
    const closes = bars.map(b => b.c);
    const rsiFull = L.rsi(closes, 14);
    for (let i = 5; i < bars.length - 20; i++) {
      const t = bars[i].t;
      if (t < sample.start || t >= sample.end) continue;
      const prod = L.scoreAt(bars, i, { window: L.PRODUCTION_WINDOW, fixed: true });
      if (!prod || !isFinite(rsiFull[i])) continue;
      const row = {
        sym,
        rsi_contrarian: -rsiFull[i],
        short_reversal: -(bars[i].c / bars[i - 5].c - 1),
        composite_inverted: -prod.score,
        // Production gating: mean_reversion only fires when the composite also
        // clears min_confidence (see CORRECTION in the header).
        mr: (() => { const e = L.emittedSignals(prod.votes, prod.score).find(x => x.strategy === 'mean_reversion');
                     return e ? (e.direction === 'BUY' ? e.confidence : -e.confidence) : 0; })(),
        f1: bars[i + 1].c / bars[i].c - 1,
        f5: bars[i + 5].c / bars[i].c - 1,
        f20: bars[i + 20].c / bars[i].c - 1,
      };
      if (!byDate.has(t)) byDate.set(t, []);
      byDate.get(t).push(row);
    }
  }
  return { byDate, symbols: Object.keys(data).length };
}

// ── long-only top-quintile portfolio vs equal weight, non-overlapping 5-day holds ──
function portfolio(byDate, key, cost) {
  const dates = [...byDate.keys()].sort();
  let prev = new Set();
  const periods = [];
  for (let k = 0; k < dates.length; k += REBAL) {
    const rows = byDate.get(dates[k]);
    if (rows.length < 10) continue;
    const bench = L.mean(rows.map(r => r.f5));
    const sorted = [...rows].sort((a, b) => b[key] - a[key]);
    const longs = sorted.slice(0, Math.ceil(rows.length / 5));
    const gross = L.mean(longs.map(r => r.f5)) - bench;
    const now = new Set(longs.map(r => r.sym));
    const turnover = prev.size === 0 ? 1 : [...now].filter(s => !prev.has(s)).length / now.size;
    prev = now;
    periods.push({ date: dates[k], gross, net: gross - turnover * cost, turnover });
  }
  return summarise(periods, cost);
}

// ── production mean-reversion rule: buy every active BUY signal, non-overlapping ──
function ruleEvents(byDate, cost) {
  const dates = [...byDate.keys()].sort();
  const periods = []; let events = 0;
  for (let k = 0; k < dates.length; k += REBAL) {
    const rows = byDate.get(dates[k]);
    if (rows.length < 10) continue;
    const buys = rows.filter(r => r.mr > 0);
    if (buys.length === 0) continue;                     // flat this period
    events += buys.length;
    const gross = L.mean(buys.map(r => r.f5)) - L.mean(rows.map(r => r.f5));
    periods.push({ date: dates[k], gross, net: gross - cost, turnover: 1 });
  }
  return { ...summarise(periods, cost), events };
}

function summarise(periods, cost) {
  const g = periods.map(p => p.gross), n = periods.map(p => p.net);
  const avgTurnover = L.mean(periods.map(p => p.turnover));
  const byYear = {};
  for (const p of periods) (byYear[p.date.slice(0, 4)] ||= []).push(p.net);
  return {
    periods: periods.length,
    grossAnn: L.mean(g) * PERIODS_PER_YEAR,
    netAnn: L.mean(n) * PERIODS_PER_YEAR,
    tNet: L.tstat(n),
    hit: n.filter(x => x > 0).length / (n.length || 1),
    turnover: avgTurnover,
    // round-trip cost at which mean net excess would be exactly zero
    breakEven: avgTurnover > 0 ? L.mean(g) / avgTurnover : NaN,
    byYear: Object.fromEntries(Object.entries(byYear).sort().map(([y, a]) => [y, L.mean(a) * PERIODS_PER_YEAR])),
  };
}

// ── run ──
const pct = x => isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%` : '   n/a';
const f4 = x => isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(4)}` : '   n/a';
const f2 = x => isFinite(x) ? x.toFixed(2) : 'n/a';
const results = {};

console.log('\n  Contrarian hypothesis — pre-registered out-of-sample test\n');
for (const s of SAMPLES) {
  const { byDate, symbols } = await buildPanel(s);
  const cost = COST[s.cap];
  const r = { ic: {}, pf: {} };
  for (const h of HYP) {
    r.ic[h] = Object.fromEntries(['f1', 'f5', 'f20'].map(f => [f, L.crossSectionalIC(byDate, x => x[h], x => x[f])]));
    r.pf[h] = portfolio(byDate, h, cost);
  }
  r.pf.mean_reversion_rule = ruleEvents(byDate, cost);
  results[s.id] = r;

  console.log(`\n  ${'═'.repeat(94)}`);
  console.log(`  ${s.id}  ${s.label}   ${s.cap} caps · ${symbols} symbols · ${byDate.size} days · ${s.start} → ${s.end} · cost ${(cost * 100).toFixed(2)}% r/t`);
  console.log(`  ${'═'.repeat(94)}`);
  console.log('  CROSS-SECTIONAL IC            1d              5d              20d');
  for (const h of HYP) {
    const c = r.ic[h];
    console.log(`  ${h.padEnd(22)} ${['f1', 'f5', 'f20'].map(f => `${f4(c[f].mean)} (t ${f2(c[f].t).padStart(5)})`).join('  ')}`);
  }
  console.log('\n  LONG-ONLY vs EQUAL WEIGHT     gross/yr    net/yr    t(net)   hit    turnover   break-even r/t');
  for (const [h, p] of Object.entries(r.pf)) {
    const extra = p.events != null ? `   (${p.events} signals, ${p.periods} active periods)` : '';
    console.log(`  ${h.padEnd(26)} ${pct(p.grossAnn).padStart(9)} ${pct(p.netAnn).padStart(9)} ${f2(p.tNet).padStart(8)}  ${(p.hit * 100).toFixed(0).padStart(3)}%  ${(p.turnover * 100).toFixed(0).padStart(6)}%   ${pct(p.breakEven).padStart(9)}${extra}`);
  }
  if (s.primary) {
    console.log('\n  NET EXCESS BY YEAR (primary sample) — is it stable, or one lucky year?');
    for (const [h, p] of Object.entries(r.pf)) {
      console.log(`  ${h.padEnd(26)} ${Object.entries(p.byYear).map(([y, v]) => `${y} ${pct(v)}`).join('   ')}`);
    }
  }
}

// ── apply the pre-registered decision rule, mechanically ──
console.log(`\n  ${'═'.repeat(94)}\n  DECISION (pre-registered rule; |t| > ${T_CRIT} required)\n  ${'═'.repeat(94)}`);
for (const h of [...HYP, 'mean_reversion_rule']) {
  const s1 = results.S1.pf[h], s2 = results.S2.pf[h], s3 = results.S3.pf[h];
  const a = s2.netAnn > 0 && s2.tNet > T_CRIT;
  const b = s1.netAnn > 0 && s3.netAnn > 0;
  const c = h === 'mean_reversion_rule' ? true : results.S2.ic[h].f5.mean > 0;
  const verdict = a && b && c ? 'SUPPORTED' : 'NOT SUPPORTED';
  const why = [
    `(a) S2 net ${pct(s2.netAnn)} t=${f2(s2.tNet)} ${a ? 'pass' : 'FAIL'}`,
    `(b) S1 ${pct(s1.netAnn)} / S3 ${pct(s3.netAnn)} ${b ? 'pass' : 'FAIL'}`,
    h === 'mean_reversion_rule' ? '(c) n/a for an event rule' : `(c) S2 IC5 ${f4(results.S2.ic[h].f5.mean)} ${c ? 'pass' : 'FAIL'}`,
  ];
  console.log(`  ${h.padEnd(22)} ${verdict.padEnd(14)} ${why.join('  ')}`);
}
console.log('\n  Positive results are UPPER BOUNDS — today\'s constituents flatter any buy-the-loser strategy.\n');
