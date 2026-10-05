/**
 * One-time repair: open positions with no owner label.
 *
 * Until October 2026 a bot's limit order that filled a moment later opened its
 * position without the bot's label, so the app treats it as the user's own
 * (no stop-loss, outside the bots' rules). This lists those positions and, with
 * --apply, labels them as the bots'.
 *
 * It cannot tell a bot's unlabelled position from one the user placed by hand in
 * the Trading Terminal (those have no label either), so look at the list first
 * and use --only to leave your own out.
 *
 *   node server/dist/cli/relabel-untagged.js                      list only, changes nothing
 *   node server/dist/cli/relabel-untagged.js --apply              label every one listed as AI_BOT
 *   node server/dist/cli/relabel-untagged.js --apply --only SBIN,ITC
 */
import { getPrisma } from '../lib/prisma.js';

const has = (name: string) => process.argv.includes(name);
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const only = arg('--only')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const prisma = getPrisma();
// Shares only: an unlabelled option or future is far more likely a strategy the user built.
const rows = (await prisma.position.findMany({
  where: { status: 'OPEN', strategyTag: null, exchange: { in: ['NSE', 'BSE'] } },
  orderBy: { openedAt: 'asc' },
})).filter((p) => !only || only.includes(p.symbol.toUpperCase()));

if (rows.length === 0) {
  console.log('No open share positions without an owner label.');
} else {
  console.log(`${rows.length} open share position(s) without an owner label:`);
  for (const p of rows) {
    console.log(`  ${p.symbol.padEnd(14)} ${p.side.padEnd(5)} qty ${String(p.qty).padStart(5)}  entry ${Number(p.avgEntryPrice).toFixed(2).padStart(10)}  opened ${p.openedAt.toISOString()}`);
  }
  if (has('--apply')) {
    const done = await prisma.position.updateMany({ where: { id: { in: rows.map((p) => p.id) }, status: 'OPEN', strategyTag: null }, data: { strategyTag: 'AI_BOT' } });
    console.log(`Labelled ${done.count} position(s) as AI_BOT. The bots' stop-loss monitor picks them up within 30 seconds.`);
  } else {
    console.log('Nothing was changed. Run again with --apply to label them as the bots\' (add --only SYMBOL,SYMBOL to pick).');
  }
}
await prisma.$disconnect();
