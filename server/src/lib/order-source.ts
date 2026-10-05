/**
 * Who placed an order: the user (trading terminal, Strategy Builder) or the
 * app (bots, AI agent, Rust engine signals).
 *
 * The two are kept apart. The bots' discipline rules (loss pauses, position
 * and sector limits, daily targets) count only the bots' own trades and apply
 * only to the bots' orders; the user's orders are limited by funds and the
 * kill switch alone, as at a broker.
 */
export const isUserPlaced = (tag?: string | null): boolean => !tag || /^(STRAT:|STRATEGY$|MANUAL)/.test(tag);

/** Prisma filter: trades or positions opened by the app, not by the user. */
export const ALGO_ONLY = {
  AND: [
    { strategyTag: { not: null } },
    { NOT: { strategyTag: { startsWith: 'STRAT:' } } },
    { NOT: { strategyTag: { startsWith: 'MANUAL' } } },
    { NOT: { strategyTag: 'STRATEGY' } },
  ],
};
