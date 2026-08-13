import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fingerprintFailure, normalizeCause, classifyFailure, shouldBlock,
  FAILURE_POLICY, REPEAT_BLOCK_THRESHOLD,
} from '../../src/lib/failure-fingerprint.js';
import { FailureRegistryService } from '../../src/services/failure-registry.service.js';

const FO = { segment: 'FO', instrumentType: 'OPTIONS', underlying: 'NIFTY' };

/**
 * The deterministic half of "learn from failure".
 *
 * Two ways this design can fail, both covered below:
 *   - too STABLE-blind: a fingerprint containing the expiry never matches itself,
 *     so nothing is ever recognised as a repeat and the registry does nothing.
 *   - too BLOCK-happy: blocking on the first broker timeout turns a five-minute
 *     outage into a permanent trading halt, which is worse than the failure.
 */
describe('normalizeCause', () => {
  it('collapses messages that differ only in amounts', () => {
    const a = normalizeCause('Insufficient margin: need 216000, have 184000');
    const b = normalizeCause('Insufficient margin: need 431500, have 12000');
    expect(a).toBe(b);
  });

  it('collapses messages that differ only in order id or timestamp', () => {
    expect(normalizeCause('Order a1b2c3d4e5f6 rejected at 2026-08-13T10:00:00Z'))
      .toBe(normalizeCause('Order f6e5d4c3b2a1 rejected at 2026-08-14T11:30:00Z'));
  });

  it('keeps genuinely different causes distinct', () => {
    expect(normalizeCause('Insufficient margin')).not.toBe(normalizeCause('Invalid strike price'));
  });
});

describe('fingerprintFailure', () => {
  it('is stable across occurrences of the same defect', () => {
    const f1 = fingerprintFailure({ ...FO, failureClass: 'MARGIN_SHORTFALL', cause: 'need 216000, have 184000' });
    const f2 = fingerprintFailure({ ...FO, failureClass: 'MARGIN_SHORTFALL', cause: 'need 990000, have 5' });
    expect(f1).toBe(f2);
  });

  it('does not vary with strike or expiry, so next week\'s contract still matches', () => {
    // The registry is useless if a new expiry produces a new fingerprint.
    const f1 = fingerprintFailure({ ...FO, failureClass: 'MALFORMED_ORDER', cause: 'bad NIFTY2026082824000CE' });
    const f2 = fingerprintFailure({ ...FO, failureClass: 'MALFORMED_ORDER', cause: 'bad NIFTY2026090424500CE' });
    expect(f1).toBe(f2);
  });

  it('separates different failure classes', () => {
    expect(fingerprintFailure({ ...FO, failureClass: 'MARGIN_SHORTFALL', cause: 'x' }))
      .not.toBe(fingerprintFailure({ ...FO, failureClass: 'MALFORMED_ORDER', cause: 'x' }));
  });

  it('separates different underlyings, so one bad name does not block others', () => {
    expect(fingerprintFailure({ ...FO, failureClass: 'MALFORMED_ORDER', cause: 'x' }))
      .not.toBe(fingerprintFailure({ ...FO, underlying: 'BANKNIFTY', failureClass: 'MALFORMED_ORDER', cause: 'x' }));
  });
});

describe('block policy', () => {
  it('blocks a structurally impossible order on the first occurrence', () => {
    for (const c of ['MALFORMED_ORDER', 'MISSING_CONTRACT_FIELD', 'UNSUPPORTED_INSTRUMENT', 'UNBALANCED_MULTILEG'] as const) {
      expect(FAILURE_POLICY[c]).toBe('BLOCK_IMMEDIATELY');
      expect(shouldBlock(c, 1)).toBe(true);
    }
  });

  it('NEVER blocks on infrastructure, however often it happens', () => {
    for (const c of ['BROKER_TIMEOUT', 'BROKER_UNAVAILABLE', 'RATE_LIMITED', 'UNKNOWN'] as const) {
      expect(shouldBlock(c, 1)).toBe(false);
      expect(shouldBlock(c, 1000)).toBe(false);
    }
  });

  it('blocks state-dependent failures only once they repeat', () => {
    expect(shouldBlock('MARGIN_SHORTFALL', 1)).toBe(false);
    expect(shouldBlock('MARGIN_SHORTFALL', REPEAT_BLOCK_THRESHOLD - 1)).toBe(false);
    expect(shouldBlock('MARGIN_SHORTFALL', REPEAT_BLOCK_THRESHOLD)).toBe(true);
  });

  it('treats an unrecognised error as observe-only, never as grounds to block', () => {
    expect(classifyFailure('something nobody has seen before')).toBe('UNKNOWN');
    expect(shouldBlock('UNKNOWN', 50)).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('recognises the failures this codebase actually produces', () => {
    expect(classifyFailure('multi-leg option orders require an explicit expiry')).toBe('MISSING_CONTRACT_FIELD');
    expect(classifyFailure('bear-call-spread: UNBALANCED — 1 of 2 legs filled')).toBe('UNBALANCED_MULTILEG');
    expect(classifyFailure('MARGIN NOT MODELLED: short options are blocked')).toBe('UNSUPPORTED_INSTRUMENT');
    expect(classifyFailure('Insufficient margin for short. Need 216000')).toBe('MARGIN_SHORTFALL');
    expect(classifyFailure('Bridge POST failed: ETIMEDOUT')).toBe('BROKER_TIMEOUT');
    expect(classifyFailure('Breeze session not active')).toBe('BROKER_UNAVAILABLE');
  });
});

describe('FailureRegistryService', () => {
  let prisma: any;
  let registry: FailureRegistryService;

  beforeEach(() => {
    prisma = {
      failureMode: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    registry = new FailureRegistryService(prisma);
  });

  it('arms a block immediately for a structural failure', async () => {
    const res = await registry.record({ cause: 'invalid strike price', order: FO });
    expect(res.blocked).toBe(true);
    expect(res.occurrences).toBe(1);
  });

  it('records a timeout without arming a block', async () => {
    const res = await registry.record({ cause: 'Bridge POST failed: ETIMEDOUT', order: FO });
    expect(res.blocked).toBe(false);
  });

  it('arms a repeat-class block only on the third occurrence', async () => {
    prisma.failureMode.findUnique.mockResolvedValue({ occurrences: REPEAT_BLOCK_THRESHOLD - 1 });
    const res = await registry.record({ cause: 'Insufficient margin: need 5', order: FO });
    expect(res.occurrences).toBe(REPEAT_BLOCK_THRESHOLD);
    expect(res.blocked).toBe(true);
  });

  it('increments rather than duplicating on a repeat', async () => {
    prisma.failureMode.findUnique.mockResolvedValue({ occurrences: 4 });
    await registry.record({ cause: 'Insufficient margin: need 5', order: FO });
    expect(prisma.failureMode.upsert.mock.calls[0][0].update.occurrences).toEqual({ increment: 1 });
  });

  it('passes an order with no matching blocked failure', async () => {
    expect((await registry.checkBlocked(FO)).blocked).toBe(false);
  });

  it('refuses an order matching a blocked failure, and says how to clear it', async () => {
    prisma.failureMode.findMany.mockResolvedValue([{
      fingerprint: 'abc123', failureClass: 'UNBALANCED_MULTILEG', occurrences: 2,
      sampleCause: '1 of 2 legs filled', lastSeenAt: new Date(),
    }]);

    const v = await registry.checkBlocked(FO);
    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/KNOWN FAILURE \(UNBALANCED_MULTILEG\)/);
    expect(v.reason).toMatch(/unblock\('abc123'\)/);
  });

  it('only consults rows already marked blocked, so recording never halts trading', async () => {
    await registry.checkBlocked(FO);
    expect(prisma.failureMode.findMany.mock.calls[0][0].where.blocked).toBe(true);
  });

  it('scopes the check to the same segment, instrument type and underlying', async () => {
    await registry.checkBlocked(FO);
    const where = prisma.failureMode.findMany.mock.calls[0][0].where;
    expect(where.segment).toBe('FO');
    expect(where.instrumentType).toBe('OPTIONS');
    expect(where.underlying).toBe('NIFTY');
  });

  it('lifts a block only on an explicit operator action', async () => {
    expect(await registry.unblock('abc123', 'payload fixed')).toBe(true);
    expect(prisma.failureMode.update.mock.calls[0][0].data)
      .toEqual({ blocked: false, notes: 'payload fixed' });
  });
});
