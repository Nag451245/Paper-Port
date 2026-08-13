/**
 * Backfill derivative contract identity into the columns added by
 * 20260813110000_derivative_instrument_columns.
 *
 * Before those columns, a contract's strike and expiry could only live inside
 * `strategyTag` as "OPT:CE:24000:2026-08-28". This script moves that into real
 * columns, and — more importantly — recovers identity from the SYMBOL for the
 * many positions that never had an OPT: tag at all.
 *
 * Rules this script holds to:
 *
 *   - It NEVER guesses. A strike or expiry that cannot be read is flagged via
 *     `metaNeedsReview`, not inferred. The bug being cleaned up here is exactly
 *     an inference: the old reader fell back to `Number(avgEntryPrice)` for the
 *     strike, turning a ₹120 premium into a 120 strike.
 *   - It is idempotent. Rows already carrying `instrumentType` are skipped, so
 *     re-running is safe.
 *   - It is DRY-RUN by default. Pass --apply to write.
 *   - It leaves `strategyTag` untouched. Readers prefer the columns now, and
 *     deleting the legacy tag would destroy the only audit trail of where the
 *     values came from.
 *
 * Usage:
 *   npx tsx scripts/backfill-derivative-columns.ts            # dry run
 *   npx tsx scripts/backfill-derivative-columns.ts --apply    # write
 */
import { PrismaClient } from '@prisma/client';
import { parseInstrumentSymbol, segmentForExchange, expiryToDate } from '../src/lib/instrument.js';

const APPLY = process.argv.includes('--apply');
const BATCH = 500;

type Bucket = 'alreadyPopulated' | 'fromLegacyTag' | 'fromSymbol' | 'equity' | 'flagged';

interface Resolution {
  bucket: Bucket;
  reason?: string;
  data?: {
    segment: string;
    instrumentType: string;
    underlying: string;
    expiry: Date | null;
    strike: number | null;
    optionType: string | null;
  };
}

/** Legacy encoding: OPT:<CE|PE>:<strike>:<expiry> */
function fromLegacyTag(tag: string | null, exchange: string): Resolution | null {
  if (!tag || !tag.startsWith('OPT:')) return null;

  const parts = tag.split(':');
  const optionType = (parts[1] ?? '').toUpperCase();
  const strikeRaw = parts[2] ?? '';
  const expiryRaw = parts[3] ?? '';

  if (optionType !== 'CE' && optionType !== 'PE') {
    return { bucket: 'flagged', reason: `legacy tag has unusable option type "${parts[1]}"` };
  }

  const strike = Number(strikeRaw);
  if (!Number.isFinite(strike) || strike <= 0) {
    return { bucket: 'flagged', reason: `legacy tag has unusable strike "${strikeRaw}"` };
  }

  let expiry: Date;
  try {
    expiry = expiryToDate(expiryRaw);
  } catch {
    return { bucket: 'flagged', reason: `legacy tag has unusable expiry "${expiryRaw}"` };
  }

  return {
    bucket: 'fromLegacyTag',
    data: {
      segment: segmentForExchange(exchange),
      instrumentType: 'OPTIONS',
      underlying: '',           // filled in below from the symbol when possible
      expiry,
      strike,
      optionType,
    },
  };
}

function resolve(pos: {
  symbol: string;
  exchange: string;
  strategyTag: string | null;
  instrumentType: string | null;
}): Resolution {
  if (pos.instrumentType) return { bucket: 'alreadyPopulated' };

  // The symbol is tried first for its underlying, and is authoritative when it
  // parses as a contract — every writer builds it canonically now.
  let symbolSpec: ReturnType<typeof parseInstrumentSymbol> | null = null;
  try {
    symbolSpec = parseInstrumentSymbol(pos.symbol, pos.exchange);
  } catch {
    symbolSpec = null;
  }

  const legacy = fromLegacyTag(pos.strategyTag, pos.exchange);
  if (legacy) {
    if (legacy.bucket === 'flagged') return legacy;
    legacy.data!.underlying = symbolSpec?.underlying ?? pos.symbol.toUpperCase();
    return legacy;
  }

  if (symbolSpec && symbolSpec.instrumentType !== 'EQUITY') {
    return {
      bucket: 'fromSymbol',
      data: {
        segment: symbolSpec.segment,
        instrumentType: symbolSpec.instrumentType,
        underlying: symbolSpec.underlying,
        expiry: symbolSpec.expiry,
        strike: symbolSpec.strike,
        optionType: symbolSpec.optionType,
      },
    };
  }

  // Looks like an option by name but nothing could identify it — e.g. the old
  // expiry-less `NIFTY24000CE` format, which names no real contract.
  //
  // The leading \d matters: a bare /(CE|PE)$/ matches RELIANCE, which would
  // flag the most heavily traded equity in the market as a broken option.
  if (/\d(CE|PE)$/i.test(pos.symbol.trim())) {
    return {
      bucket: 'flagged',
      reason: `symbol "${pos.symbol}" looks like an option but carries no expiry`,
    };
  }

  return {
    bucket: 'equity',
    data: {
      segment: segmentForExchange(pos.exchange),
      instrumentType: 'EQUITY',
      underlying: pos.symbol.trim().toUpperCase(),
      expiry: null,
      strike: null,
      optionType: null,
    },
  };
}

async function main() {
  const prisma = new PrismaClient();
  const counts: Record<Bucket, number> = {
    alreadyPopulated: 0, fromLegacyTag: 0, fromSymbol: 0, equity: 0, flagged: 0,
  };
  const flagged: Array<{ id: string; symbol: string; reason: string }> = [];
  let tradesUpdated = 0;

  console.log(`\n  Derivative column backfill — ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

  try {
    let cursor: string | undefined;
    let scanned = 0;

    for (;;) {
      const batch = await prisma.position.findMany({
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true, symbol: true, exchange: true, strategyTag: true,
          instrumentType: true,
        },
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;
      scanned += batch.length;

      for (const pos of batch) {
        const res = resolve(pos);
        counts[res.bucket]++;

        if (res.bucket === 'alreadyPopulated') continue;

        if (res.bucket === 'flagged') {
          flagged.push({ id: pos.id, symbol: pos.symbol, reason: res.reason! });
          if (APPLY) {
            await prisma.position.update({
              where: { id: pos.id },
              data: { metaNeedsReview: true },
            });
          }
          continue;
        }

        if (APPLY) {
          await prisma.position.update({
            where: { id: pos.id },
            data: { ...res.data!, metaNeedsReview: false },
          });
          // Closed trades inherit identity from their position so realised F&O
          // P&L stays attributable after the position row is gone.
          const r = await prisma.trade.updateMany({
            where: { positionId: pos.id, instrumentType: null },
            data: res.data!,
          });
          tradesUpdated += r.count;
        }
      }
    }

    console.log(`  scanned ${scanned} position(s)\n`);
    console.log(`    already populated : ${counts.alreadyPopulated}`);
    console.log(`    from legacy tag   : ${counts.fromLegacyTag}`);
    console.log(`    from symbol       : ${counts.fromSymbol}`);
    console.log(`    equity            : ${counts.equity}`);
    console.log(`    FLAGGED for review: ${counts.flagged}`);
    if (APPLY) console.log(`    trade rows updated: ${tradesUpdated}`);

    if (flagged.length) {
      console.log(`\n  Flagged rows (metaNeedsReview${APPLY ? ' set' : ' would be set'}) — nothing was guessed:`);
      for (const f of flagged.slice(0, 50)) {
        console.log(`    ${f.id}  ${f.symbol.padEnd(28)} ${f.reason}`);
      }
      if (flagged.length > 50) console.log(`    ... and ${flagged.length - 50} more`);
      console.log(
        `\n  These positions cannot be priced or greeked until identified. Query them with:` +
        `\n    SELECT id, symbol, strategy_tag FROM positions WHERE meta_needs_review = true;`,
      );
    }

    if (!APPLY) {
      console.log(`\n  Dry run only — nothing was written. Re-run with --apply to commit.\n`);
    } else {
      console.log(`\n  Done.\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error(`\n  Backfill failed: ${err.message}\n`);
  process.exitCode = 1;
});
