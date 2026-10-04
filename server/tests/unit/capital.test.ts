import { describe, it, expect } from 'vitest';
import { autoTopUpAmount, AUTO_TOPUP_LIMIT } from '../../src/lib/capital.js';

describe('automatic capital top-up', () => {
  it('adds the shortfall rounded up to ₹50,000', () => {
    expect(autoTopUpAmount(10_00_000, 1)).toBe(50_000);
    expect(autoTopUpAmount(10_00_000, 1_20_000)).toBe(1_50_000);
    expect(autoTopUpAmount(10_00_000, 0)).toBe(0);
  });

  it('never takes the capital past ₹50 lakh', () => {
    expect(AUTO_TOPUP_LIMIT).toBe(50_00_000);
    // ₹49.8 lakh + ₹20,000 needed: only ₹20,000 of room is left, and it is enough.
    expect(autoTopUpAmount(49_80_000, 20_000)).toBe(20_000);
    // Needs more than the room left: nothing is added (the order is refused instead).
    expect(autoTopUpAmount(49_80_000, 30_000)).toBe(0);
    expect(autoTopUpAmount(50_00_000, 10_000)).toBe(0);
    expect(autoTopUpAmount(10_00_000, 45_00_000)).toBe(0);
  });
});
