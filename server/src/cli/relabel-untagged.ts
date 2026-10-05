/**
 * One-time repair: open positions with no owner label.
 *
 * Until October 2026 a bot's limit order that filled a moment later opened its
 * position without the bot's label, so the app treats it as the user's own
 * (no stop-loss, outside the bots' rules). This lists those positions and, with
 * --apply, labels them as the bots'.
 *
 * It cannot tell a bot's unlabelled position from one placed by hand in the
 * Trading Terminal (those have no label either). So it shows which account each
 * position belongs to, changes one account at a time (--email is required with
 * --apply), and takes position numbers from the list (--only) so that two
 * positions in the same share can be told apart.
 *
 *   node server/dist/cli/relabel-untagged.js                              list every account, change nothing
 *   node server/dist/cli/relabel-untagged.js --email you@example.com      list one account
 *   node server/dist/cli/relabel-untagged.js --email you@example.com --apply
 *   node server/dist/cli/relabel-untagged.js --email you@example.com --apply --only 1,2,5
 */
import { getPrisma } from '../lib/prisma.js';

const has = (name: string) => process.argv.includes(name);
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const email = arg('--email')?.trim().toLowerCase();
const only = arg('--only')?.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

const prisma = getPrisma();
// Shares only: an unlabelled option or future is far more likely a strategy the user built.
const all = await prisma.position.findMany({
  where: { status: 'OPEN', strategyTag: null, exchange: { in: ['NSE', 'BSE'] } },
  include: { portfolio: { select: { user: { select: { email: true } } } } },
  orderBy: { openedAt: 'asc' },
});
const rows = all.filter((p) => !email || p.portfolio.user.email.toLowerCase() === email);

if (rows.length === 0) {
  console.log(email ? `No open share positions without an owner label for ${email}.` : 'No open share positions without an owner label.');
} else {
  console.log(`${rows.length} open share position(s) without an owner label${email ? ` for ${email}` : ''}:`);
  rows.forEach((p, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${p.symbol.padEnd(14)} ${p.side.padEnd(5)} qty ${String(p.qty).padStart(6)}  entry ${Number(p.avgEntryPrice).toFixed(2).padStart(10)}  opened ${p.openedAt.toISOString()}  ${p.portfolio.user.email}`);
  });
  if (!has('--apply')) {
    console.log('Nothing was changed. To label an account\'s positions as the bots\': --email <account> --apply (add --only 1,2 to pick by number).');
  } else if (!email) {
    console.log('Nothing was changed. --apply needs --email <account>, so one account\'s positions are never relabelled by accident with another\'s.');
  } else {
    const chosen = only ? rows.filter((_, i) => only.includes(i + 1)) : rows;
    const done = await prisma.position.updateMany({ where: { id: { in: chosen.map((p) => p.id) }, status: 'OPEN', strategyTag: null }, data: { strategyTag: 'AI_BOT' } });
    console.log(`Labelled ${done.count} position(s) as AI_BOT: ${chosen.map((p) => `${p.symbol} x${p.qty}`).join(', ')}.`);
    console.log('The bots\' stop-loss monitor picks them up within 30 seconds.');
  }
}
await prisma.$disconnect();
