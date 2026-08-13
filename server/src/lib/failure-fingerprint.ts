/**
 * Stable identity for an execution failure, so the same defect is recognised the
 * next time it is about to happen.
 *
 * This is the deterministic half of "learn from failure". Strategy losses are
 * mostly noise and must be handled statistically — a profitable system loses
 * 40-50% of the time, and suppressing those setups would destroy the edge.
 * EXECUTION failures are the opposite: a malformed payload, a missing expiry, an
 * unbalanced spread. Those have one identifiable cause, they will recur
 * identically, and "never do this again" is literally correct.
 *
 * Two design constraints pull against each other:
 *
 *   - The fingerprint must be STABLE, or the same defect never matches itself and
 *     the registry is useless. So it deliberately EXCLUDES strike, expiry, order
 *     id, quantity and amounts — a fingerprint containing next week's expiry
 *     would never match again.
 *   - It must be SPECIFIC, or one failure blocks unrelated trading. So it
 *     includes the failure class, the segment, the instrument type and the
 *     underlying.
 */
import { createHash } from 'crypto';

export type FailureClass =
  // Structural: the request itself is wrong and will fail identically forever.
  | 'MALFORMED_ORDER'
  | 'MISSING_CONTRACT_FIELD'
  | 'UNSUPPORTED_INSTRUMENT'
  | 'UNBALANCED_MULTILEG'
  // Account/state: will recur until something changes, but not inherently wrong.
  | 'MARGIN_SHORTFALL'
  | 'RISK_BLOCKED'
  | 'PROTECTIVE_STOP_NOT_PLACED'
  | 'EXPIRY_NOT_SQUARED_OFF'
  // Infrastructure: transient by nature. Must never auto-block.
  | 'BROKER_TIMEOUT'
  | 'BROKER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'UNKNOWN';

/**
 * What to do when a class of failure is seen.
 *
 * Deliberately a per-class policy rather than an occurrence threshold. "Block
 * after N failures" sounds prudent but is wrong in both directions: a malformed
 * payload should be blocked on the FIRST occurrence because it cannot ever
 * succeed, and a broker timeout should never block at all however often it
 * happens. A count cannot distinguish those; the class can.
 */
export type FailurePolicy = 'BLOCK_IMMEDIATELY' | 'BLOCK_AFTER_REPEAT' | 'RECORD_ONLY';

export const FAILURE_POLICY: Record<FailureClass, FailurePolicy> = {
  // Cannot ever succeed as sent. Block at once.
  MALFORMED_ORDER: 'BLOCK_IMMEDIATELY',
  MISSING_CONTRACT_FIELD: 'BLOCK_IMMEDIATELY',
  UNSUPPORTED_INSTRUMENT: 'BLOCK_IMMEDIATELY',
  // A partially filled defined-risk structure is an open naked position. Never
  // retry the same shape blind.
  UNBALANCED_MULTILEG: 'BLOCK_IMMEDIATELY',

  // Depends on account state, which can legitimately change. Blocking on the
  // first occurrence would freeze trading after one tight-margin morning.
  MARGIN_SHORTFALL: 'BLOCK_AFTER_REPEAT',
  RISK_BLOCKED: 'RECORD_ONLY',
  PROTECTIVE_STOP_NOT_PLACED: 'BLOCK_AFTER_REPEAT',
  EXPIRY_NOT_SQUARED_OFF: 'BLOCK_AFTER_REPEAT',

  // Transient. Blocking on infrastructure would turn a five-minute outage into a
  // permanent halt, which is a worse failure than the one being recorded.
  BROKER_TIMEOUT: 'RECORD_ONLY',
  BROKER_UNAVAILABLE: 'RECORD_ONLY',
  RATE_LIMITED: 'RECORD_ONLY',
  UNKNOWN: 'RECORD_ONLY',
};

/** Occurrences before a BLOCK_AFTER_REPEAT class starts blocking. */
export const REPEAT_BLOCK_THRESHOLD = 3;

export interface FailureShape {
  failureClass: FailureClass;
  /** EQ | FO | CD | COM */
  segment: string;
  /** EQUITY | FUTURES | OPTIONS */
  instrumentType: string;
  underlying: string;
  /** Raw message from the broker or from internal validation. */
  cause: string;
}

/**
 * Strip the varying parts of a failure message so repeats collapse together.
 *
 * "Insufficient margin: need 216000, have 184000" and the same message with
 * different amounts describe ONE defect. Without normalisation every occurrence
 * would fingerprint differently and nothing would ever be recognised as a repeat.
 */
export function normalizeCause(cause: string): string {
  return String(cause ?? '')
    .toLowerCase()
    // Order ids, tokens and other long alphanumerics.
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    // ISO timestamps and dates.
    .replace(/\d{4}-\d{2}-\d{2}t?[\d:.]*z?/g, '<ts>')
    // Currency amounts and bare numbers, including decimals and separators.
    .replace(/[₹$]\s?[\d,]+(\.\d+)?/g, '<amt>')
    // Deliberately NOT \b-anchored. A contract symbol embedded in a message —
    // "rejected NIFTY2026082824000CE" — has no word boundary between the letters
    // and the digits, so an anchored rule leaves the expiry and strike in place
    // and the fingerprint changes every week. That defeats the whole registry:
    // the same defect would never be recognised as a repeat.
    .replace(/\d[\d,]*(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Stable fingerprint. Same defect, same value — across restarts and across weeks,
 * because nothing contract-specific-but-transient goes into it.
 */
export function fingerprintFailure(shape: FailureShape): string {
  const parts = [
    shape.failureClass,
    String(shape.segment ?? '').toUpperCase(),
    String(shape.instrumentType ?? '').toUpperCase(),
    String(shape.underlying ?? '').toUpperCase(),
    normalizeCause(shape.cause),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** Whether a recorded failure should refuse matching orders, given its count. */
export function shouldBlock(failureClass: FailureClass, occurrences: number): boolean {
  switch (FAILURE_POLICY[failureClass] ?? 'RECORD_ONLY') {
    case 'BLOCK_IMMEDIATELY': return occurrences >= 1;
    case 'BLOCK_AFTER_REPEAT': return occurrences >= REPEAT_BLOCK_THRESHOLD;
    default: return false;
  }
}

/**
 * Best-effort classification of a raw error into a failure class.
 *
 * Falls through to UNKNOWN, which is RECORD_ONLY — an unrecognised error is
 * observed, never used to block. Guessing a class and blocking on it would be
 * worse than not blocking.
 */
export function classifyFailure(message: string): FailureClass {
  const m = String(message ?? '').toLowerCase();

  if (/timed? ?out|timeout|etimedout/.test(m)) return 'BROKER_TIMEOUT';
  if (/rate ?limit|too many requests|429/.test(m)) return 'RATE_LIMITED';
  if (/unavailable|not active|session|econnrefused|503|502/.test(m)) return 'BROKER_UNAVAILABLE';

  if (/unbalanced/.test(m)) return 'UNBALANCED_MULTILEG';
  if (/no expiry|missing (expiry|option type|strike)|requires? .*(expiry|strike)/.test(m)) {
    return 'MISSING_CONTRACT_FIELD';
  }
  if (/margin not modelled|blocked.*(short option|futures)|not supported/.test(m)) {
    return 'UNSUPPORTED_INSTRUMENT';
  }
  if (/insufficient (margin|capital|funds)|shortfall/.test(m)) return 'MARGIN_SHORTFALL';
  if (/risk|violation|limit exceeded/.test(m)) return 'RISK_BLOCKED';
  if (/invalid|malformed|bad request|400|cannot map|must be/.test(m)) return 'MALFORMED_ORDER';

  return 'UNKNOWN';
}
