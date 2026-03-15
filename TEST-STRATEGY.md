# Capital Guard — Test Strategy

## Overview

Layered test strategy for the Capital Guard trading platform targeting correctness
of financial calculations, risk enforcement, order lifecycle integrity, and system
resilience. Priority order reflects blast radius of failure.

---

## Test Pyramid

```
                    ┌────────────┐
                    │  E2E / UAT │  Playwright (frontend), Vitest (server)
                   ─┤            ├─
                  / └────────────┘ \
                 /   Integration    \  Route-level tests via app.inject()
                /  ┌──────────────┐  \
               ─┤  │  Service      │  ├─
              /  └──────────────┘  \
             /       Unit           \  Pure logic, mocked DB
            /  ┌──────────────────┐  \
           ─┤  │  Financial Math   │  ├─  P&L, margin, VaR, position sizing
            \  └──────────────────┘  /
             ────────────────────────
```

## Priority Matrix

| # | Area                  | Risk Level | Test Type              | File(s)                                    |
|---|-----------------------|------------|------------------------|--------------------------------------------|
| 1 | P&L correctness       | CRITICAL   | Unit                   | `pnl-correctness.test.ts`                  |
| 2 | Risk engine           | CRITICAL   | Unit                   | `risk.service.test.ts`                     |
| 3 | OMS state machine     | CRITICAL   | Unit                   | `oms.service.test.ts`                      |
| 4 | Trade execution       | HIGH       | Integration            | `trade-execution.test.ts`                  |
| 5 | Data integrity        | HIGH       | Unit                   | `data-integrity.test.ts`                   |
| 6 | Service resilience    | MEDIUM     | Integration            | `service-resilience.test.ts`               |
| 7 | Frontend consistency  | MEDIUM     | Unit (React)           | `portfolio-consistency.test.tsx`           |
| 8 | Security              | HIGH       | Integration            | `security.test.ts`                         |

## Key Bug Fixes Validated

- **Timezone inconsistency**: 6 different "today" boundaries unified to IST
- **Holiday P&L**: stale/missing DailyPnlRecord on market holidays
- **UTC date bucketing**: `getPnlHistory()` grouping trades by UTC date not IST
- **Cross-view drift**: Dashboard vs Portfolio vs Risk Dashboard showing different P&L

## Running Tests

```bash
# All server tests
cd server && npm test

# Specific suite
npx vitest run tests/unit/pnl-correctness.test.ts
npx vitest run tests/unit/risk.service.test.ts
npx vitest run tests/unit/oms.service.test.ts

# Coverage
npm run test:coverage
```

## Test Data Strategy

Shared factories in `tests/helpers/factories.ts` generate consistent test entities
(users, portfolios, positions, orders, trades) with sensible Indian market defaults.
All monetary values use INR. All timestamps default to IST-aware boundaries.
