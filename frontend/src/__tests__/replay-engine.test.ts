import { describe, it, expect } from 'vitest';
import {
  barTime, indexAsOf, barsBetween, checkExit, validateLevels, closePosition, equity, summarize,
  buildContractSymbol, netPnl, type Bar, type Position,
} from '@/lib/replay-engine';

const bar = (timestamp: string, open: number, high: number, low: number, close: number): Bar =>
  ({ timestamp, open, high, low, close, volume: 1 });

const long = (over: Partial<Position> = {}): Position => ({
  id: '1', symbol: 'TCS', label: 'TCS', side: 'LONG', qty: 10, entryPrice: 100,
  entryTime: '2025-02-03 09:20:00', entryCharges: 5, stopLoss: 95, target: 110, ...over,
});

describe('time', () => {
  it('reads zone-less times as Indian time', () => {
    expect(new Date(barTime('2025-02-03 09:15:00')).toISOString()).toBe('2025-02-03T03:45:00.000Z');
    expect(barTime('2025-02-03T03:45:00.000Z')).toBe(barTime('2025-02-03 09:15:00'));
  });

  it('finds the candle in force at a moment, and the candles printed during a step', () => {
    const bars = ['09:15', '09:20', '09:25', '09:30'].map((t) => bar(`2025-02-03 ${t}:00`, 1, 1, 1, 1));
    expect(indexAsOf(bars, barTime('2025-02-03 09:22:00'))).toBe(1);
    expect(indexAsOf(bars, barTime('2025-02-03 09:10:00'))).toBe(-1);
    const step = barsBetween(bars, barTime('2025-02-03 09:15:00'), barTime('2025-02-03 09:25:00'));
    expect(step.map((b) => b.timestamp.slice(11, 16))).toEqual(['09:20', '09:25']);
  });
});

describe('stops and targets', () => {
  it('fills at the level when a candle trades through it', () => {
    expect(checkExit(long(), bar('t', 100, 111, 99, 108))).toEqual({ price: 110, reason: 'TARGET' });
    expect(checkExit(long(), bar('t', 100, 101, 94, 96))).toEqual({ price: 95, reason: 'STOP' });
  });

  it('fills at the open when the candle gaps past the level', () => {
    expect(checkExit(long(), bar('t', 90, 92, 88, 91))).toEqual({ price: 90, reason: 'STOP' });
    expect(checkExit(long(), bar('t', 115, 116, 112, 113))).toEqual({ price: 115, reason: 'TARGET' });
  });

  it('assumes the stop came first when one candle reaches both', () => {
    expect(checkExit(long(), bar('t', 100, 112, 94, 105))).toEqual({ price: 95, reason: 'STOP' });
  });

  it('mirrors every rule for a short', () => {
    const short = long({ side: 'SHORT', stopLoss: 105, target: 90 });
    expect(checkExit(short, bar('t', 100, 106, 99, 104))).toEqual({ price: 105, reason: 'STOP' });
    expect(checkExit(short, bar('t', 100, 101, 89, 95))).toEqual({ price: 90, reason: 'TARGET' });
    expect(checkExit(short, bar('t', 108, 109, 107, 108))).toEqual({ price: 108, reason: 'STOP' });
    expect(checkExit(short, bar('t', 100, 106, 89, 95))).toEqual({ price: 105, reason: 'STOP' });
  });

  it('leaves a position alone when neither level is touched', () => {
    expect(checkExit(long(), bar('t', 100, 109, 96, 104))).toBeNull();
    expect(checkExit(long({ stopLoss: undefined, target: undefined }), bar('t', 50, 200, 1, 100))).toBeNull();
  });

  it('refuses levels on the wrong side of the price', () => {
    expect(validateLevels('LONG', 100, 101)).toMatch(/below/);
    expect(validateLevels('SHORT', 100, undefined, 101)).toMatch(/below/);
    expect(validateLevels('LONG', 100, 95, 110)).toBeNull();
  });
});

describe('P&L', () => {
  it('counts charges on both sides and marks open positions to market', () => {
    const t = { ...closePosition(long(), 110, '2025-02-03 10:00:00', 'TARGET'), exitCharges: 7 };
    expect(t.grossPnl).toBe(100);
    expect(netPnl(t)).toBe(88);

    const open = long({ id: '2', entryPrice: 200, entryCharges: 3 });
    // 1000 + 88 closed + (210-200)*10 open - 3 already paid to open
    expect(equity(1000, [t], [open], () => 210)).toBe(1185);
  });

  it('summarises wins, losses and the worst drawdown', () => {
    const win = { ...closePosition(long(), 110, 'x', 'TARGET'), exitCharges: 5 };             // +90
    const loss = { ...closePosition(long({ id: '2' }), 95, 'y', 'STOP'), exitCharges: 5 };     // -60
    const s = summarize([win, loss], [
      { time: 'a', value: 1000 }, { time: 'b', value: 1100 }, { time: 'c', value: 990 }, { time: 'd', value: 1030 },
    ], 1000);
    expect(s).toMatchObject({ trades: 2, wins: 1, losses: 1, winRate: 50, netPnl: 30, charges: 20 });
    expect(s.profitFactor).toBeCloseTo(1.5);
    expect(s.maxDrawdown).toBe(110);
    expect(s.maxDrawdownPct).toBeCloseTo(10);
  });
});

describe('contract symbols', () => {
  it('builds the grammar the server parses', () => {
    expect(buildContractSymbol('nifty', 'CE', '2025-02-27', '24000')).toBe('NIFTY2025022724000CE');
    expect(buildContractSymbol('NIFTY', 'FUT', '2025-02-27', '')).toBe('NIFTY20250227FUT');
    expect(buildContractSymbol('NIFTY', 'PE', '2025-02-27', '24000.5')).toBeNull();
  });
});
