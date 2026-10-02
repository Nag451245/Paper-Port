import type { DailyBar } from '../../src/lib/alert-math.js';

/** Deterministic standard normals (LCG + Box–Muller), so tests never flake. */
export function normals(n: number, seed = 7): number[] {
  let s = seed;
  const u = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) + 1) / (2 ** 31 + 1);
  return Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()));
}

export const day = (i: number) => new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10);

/** 80 sessions: market σ 1%, stock = 0.02% + 1.2·market + noise σ 1.5%, around ₹500 on 10 lakh shares. */
export function history(n = 80) {
  const zm = normals(n, 11), ze = normals(n, 29);
  let m = 20000, p = 500;
  const market: DailyBar[] = [], stock: DailyBar[] = [];
  for (let i = 0; i < n; i++) {
    const rm = 0.01 * zm[i];
    m *= Math.exp(rm);
    p *= Math.exp(0.0002 + 1.2 * rm + 0.015 * ze[i]);
    market.push({ timestamp: day(i), high: m * 1.005, low: m * 0.995, close: m, volume: 0 });
    stock.push({ timestamp: day(i), high: p * 1.01, low: p * 0.99, close: p, volume: 1_000_000 });
  }
  return { market, stock };
}
