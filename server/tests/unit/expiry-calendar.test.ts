import { describe, it, expect, vi } from 'vitest';
import { ExpiryCalendar, ruleExpiries } from '../../src/services/expiry-calendar.service.js';

const at = (iso: string) => () => new Date(iso);
const noHolidays = () => false;

describe('rule fallback (used only when no broker or exchange list is reachable)', () => {
  it('NIFTY weekly on Tuesday, moved back over a holiday', () => {
    expect(ruleExpiries('NIFTY', '2026-10-03', noHolidays, 3)).toEqual(['2026-10-06', '2026-10-13', '2026-10-20']);
    expect(ruleExpiries('NIFTY', '2026-10-03', (d) => d === '2026-10-20', 3)).toEqual(['2026-10-06', '2026-10-13', '2026-10-19']);
  });

  it('SENSEX weekly on Thursday', () => {
    expect(ruleExpiries('SENSEX', '2026-10-03', noHolidays, 2)).toEqual(['2026-10-08', '2026-10-15']);
  });

  it('everything else monthly on the last Tuesday, skipping weekends and holidays', () => {
    expect(ruleExpiries('BANKNIFTY', '2026-10-03', noHolidays, 2)).toEqual(['2026-10-27', '2026-11-24']);
    expect(ruleExpiries('BANKNIFTY', '2026-10-03', (d) => d === '2026-10-27', 1)).toEqual(['2026-10-26']);
  });
});

describe('ExpiryCalendar', () => {
  it("uses the brokers' contract list first, holiday shifts and all", async () => {
    const list = vi.fn().mockResolvedValue(['2026-10-06', '2026-10-13', '2026-10-19']);   // Oct 19 is a Monday
    const broker = { getAvailableExpiries: vi.fn() };
    const cal = new ExpiryCalendar(broker as any, list, at('2026-10-14T06:00:00Z'));
    expect(await cal.expiries('nifty')).toEqual({ dates: ['2026-10-19'], source: 'upstox-instruments' });
    expect(broker.getAvailableExpiries).not.toHaveBeenCalled();
  });

  it('falls back to the logged-in broker or NSE, then to the rules', async () => {
    const broker = { getAvailableExpiries: vi.fn().mockResolvedValue({ expiries: ['2026-10-27T06:00:00.000Z'] }) };
    const cal = new ExpiryCalendar(broker as any, async () => [], at('2026-10-14T06:00:00Z'));
    expect(await cal.expiries('BANKNIFTY')).toEqual({ dates: ['2026-10-27'], source: 'broker' });

    const none = new ExpiryCalendar({ getAvailableExpiries: async () => ({ expiries: [] }) } as any, async () => [], at('2026-10-14T06:00:00Z'));
    expect((await none.expiries('NIFTY')).source).toBe('rules');
  });

  it("keeps today's expiry until the 15:30 close, then moves on", async () => {
    const list = async () => ['2026-10-06', '2026-10-13'];
    const before = new ExpiryCalendar(undefined, list, at('2026-10-06T09:55:00Z'));        // 15:25 IST
    const after = new ExpiryCalendar(undefined, list, at('2026-10-06T10:05:00Z'));         // 15:35 IST
    expect(await before.nextExpiry('NIFTY')).toBe('2026-10-06');
    expect(await after.nextExpiry('NIFTY')).toBe('2026-10-13');
  });

  it('answers expiry-day questions synchronously once loaded', async () => {
    const cal = new ExpiryCalendar(undefined, async (u) => (u === 'NIFTY' ? ['2026-10-19', '2026-10-27'] : ['2026-10-29']), at('2026-10-19T05:00:00Z'));
    await cal.warm();
    expect(cal.isExpiryDaySync('NIFTY')).toBe(true);                                   // a Monday, from the list
    expect(cal.isExpiryDaySync('SENSEX')).toBe(false);
    expect(cal.daysToExpirySync('SENSEX')).toBe(10);
    expect(await cal.summary()).toMatch(/NIFTY: next 2026-10-19, 2026-10-27/);
  });
});
