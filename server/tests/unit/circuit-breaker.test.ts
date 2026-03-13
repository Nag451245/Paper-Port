import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/prisma.js', () => ({
  getPrisma: vi.fn(() => ({ $disconnect: vi.fn() })),
  disconnectPrisma: vi.fn(),
}));

describe('Rust Engine Circuit Breaker', () => {
  let mod: typeof import('../../src/lib/rust-engine.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/lib/rust-engine.js');
    mod._resetCircuitBreakerForTesting();
  });

  it('should expose circuit breaker state via _getCircuitBreakerState', () => {
    const state = mod._getCircuitBreakerState();
    expect(state).toHaveProperty('crashCount');
    expect(state).toHaveProperty('lastCrashTime');
    expect(state).toHaveProperty('circuitOpenSince');
    expect(state).toHaveProperty('MAX_CRASHES');
    expect(state).toHaveProperty('CRASH_WINDOW_MS');
    expect(state).toHaveProperty('CIRCUIT_COOLDOWN_MS');
  });

  it('should start with clean state after reset', () => {
    mod._resetCircuitBreakerForTesting();
    const state = mod._getCircuitBreakerState();
    expect(state.crashCount).toBe(0);
    expect(state.lastCrashTime).toBe(0);
    expect(state.circuitOpenSince).toBe(0);
  });

  it('MAX_CRASHES should be 5', () => {
    const state = mod._getCircuitBreakerState();
    expect(state.MAX_CRASHES).toBe(5);
  });

  it('CRASH_WINDOW_MS should be 60 seconds', () => {
    const state = mod._getCircuitBreakerState();
    expect(state.CRASH_WINDOW_MS).toBe(60_000);
  });

  it('CIRCUIT_COOLDOWN_MS should be 5 minutes', () => {
    const state = mod._getCircuitBreakerState();
    expect(state.CIRCUIT_COOLDOWN_MS).toBe(5 * 60_000);
  });

  it('should reset to clean state via _resetCircuitBreakerForTesting', () => {
    const stateBefore = mod._getCircuitBreakerState();
    expect(stateBefore.crashCount).toBe(0);
    mod._resetCircuitBreakerForTesting();
    const stateAfter = mod._getCircuitBreakerState();
    expect(stateAfter.crashCount).toBe(0);
    expect(stateAfter.circuitOpenSince).toBe(0);
  });

  it('should export isEngineAvailable function', () => {
    expect(typeof mod.isEngineAvailable).toBe('function');
  });

  it('should export engineScan function', () => {
    expect(typeof mod.engineScan).toBe('function');
  });
});
