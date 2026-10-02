/**
 * Run the intraday pattern search over the candle lake and write:
 *   <MARKET_DATA_DIR>/patterns.json        promoted patterns (read by the live pattern scanner)
 *   <MARKET_DATA_DIR>/pattern-report.json  every pattern's train/test numbers
 *
 * On the server:  node server/dist/cli/mine-patterns.js
 * In development: npx tsx server/src/cli/mine-patterns.ts
 * Options: --train-end YYYY-MM-DD (default 2024-12-31)
 */
import fs from 'fs';
import path from 'path';
import { lakeDir, readBars } from '../lib/candle-lake.js';
import { minePatterns } from '../lib/pattern-miner.js';
import { loadUniverse } from '../services/candle-lake-sync.service.js';
import { istDateStr } from '../lib/ist.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const started = Date.now();
const symbols = loadUniverse();
const report = minePatterns({
  symbols,
  read: readBars,
  to: istDateStr(),
  trainEnd: arg('--train-end'),
  onProgress: (done, total) => { if (done % 50 === 0) console.log(`  stocks ${done}/${total}`); },
});

const dir = lakeDir();
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'pattern-report.json'), JSON.stringify(report));
const { results: _all, ...summary } = report;
fs.writeFileSync(path.join(dir, 'patterns.json'), JSON.stringify(summary, null, 2));

console.log(`\nStocks with data: ${report.stocks}   stock-day-checkpoints: ${report.events.toLocaleString()}`);
console.log(`Patterns tested: ${report.tested}   pass false-discovery control on ${report.period.from}…${report.period.trainEnd}: ${report.bhSurvivors}`);
console.log(`Confirmed after ${report.period.trainEnd} and promoted to the shadow book: ${report.promoted.length}`);
for (const p of report.promoted) {
  console.log(`  ${p.id}  train ${p.train.meanNetPct.toFixed(3)}%/trade-day t=${p.train.t.toFixed(1)} (${p.train.days}d)  test ${p.test.meanNetPct.toFixed(3)}% t=${p.test.t.toFixed(1)} (${p.test.days}d)`);
}
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)}s. Written to ${dir}`);
