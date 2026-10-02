import { describe, it, expect } from 'vitest';
import { aggregate, applyTick, bucketTime, type RawBar } from '@/lib/candles';

const bar = (timestamp: string, open: number, high: number, low: number, close: number, volume = 10): RawBar =>
  ({ timestamp, open, high, low, close, volume });
const istMs = (s: string) => Date.parse(`${s.replace(' ', 'T')}+05:30`);
const clock = (t: number | string) => new Date((t as number) * 1000).toISOString().slice(11, 16);

describe('timeframe buckets', () => {
  it('builds 15-minute candles from 5-minute ones', () => {
    const five = ['09:15', '09:20', '09:25', '09:30'].map((t, i) => bar(`2025-02-03 ${t}:00`, 100 + i, 105 + i, 99 - i, 101 + i));
    const out = aggregate(five, '15m');
    expect(out.map((b) => clock(b.time))).toEqual(['09:15', '09:30']);
    expect(out[0]).toMatchObject({ open: 100, high: 107, low: 97, close: 103, volume: 30 });
  });

  it('starts hourly NSE candles at the 09:15 open, not on the clock hour', () => {
    const thirty = ['09:15', '09:45', '10:15', '10:45', '15:15'].map((t) => bar(`2025-02-03 ${t}:00`, 1, 1, 1, 1));
    expect(aggregate(thirty, '1h').map((b) => clock(b.time))).toEqual(['09:15', '10:15', '15:15']);
  });

  it('groups days into weeks starting Monday and into months', () => {
    const days = ['2025-02-06', '2025-02-07', '2025-02-10', '2025-03-03'].map((d, i) => bar(d, 10 + i, 20, 5, 11 + i));
    expect(aggregate(days, '1W').map((b) => b.time)).toEqual(['2025-02-03', '2025-02-10', '2025-03-03']);
    const months = aggregate(days, '1M');
    expect(months.map((b) => b.time)).toEqual(['2025-02-01', '2025-03-01']);
    expect(months[0]).toMatchObject({ open: 10, close: 13 });
  });

  it('accepts the server\'s UTC and date-only formats alike', () => {
    expect(bucketTime(istMs('2025-02-03 09:16'), '1m')).toBe(bucketTime(Date.parse('2025-02-03T03:46:00Z'), '1m'));
    expect(aggregate([bar('2025-02-03', 1, 2, 0.5, 1.5)], '1D')[0].time).toBe('2025-02-03');
  });
});

describe('live ticks', () => {
  const last = { time: bucketTime(istMs('2025-02-03 10:00'), '5m') as number, open: 100, high: 101, low: 99, close: 100, volume: 5 };

  it('updates the candle the tick falls in', () => {
    expect(applyTick(last, 102, istMs('2025-02-03 10:03'), '5m')).toMatchObject({ high: 102, low: 99, close: 102 });
  });

  it('starts the next candle within the same day', () => {
    const next = applyTick(last, 98, istMs('2025-02-03 10:05'), '5m')!;
    expect(clock(next.time)).toBe('10:05');
    expect(next).toMatchObject({ open: 98, close: 98 });
  });

  it('ignores ticks outside market hours and on a day the history has not reached', () => {
    expect(applyTick(last, 102, istMs('2025-02-03 16:00'), '5m')).toBeNull();
    expect(applyTick(last, 102, istMs('2025-02-04 09:20'), '5m')).toBeNull();
    const daily = { time: '2025-02-03', open: 1, high: 1, low: 1, close: 1, volume: 0 };
    expect(applyTick(daily, 2, istMs('2025-02-04 10:00'), '1D')).toBeNull();
    expect(applyTick(daily, 2, istMs('2025-02-03 10:00'), '1D')).toMatchObject({ high: 2, close: 2 });
  });
});
