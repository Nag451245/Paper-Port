import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarketCalendar } from '../../src/services/market-calendar.js';

/**
 * Commodity session handling.
 *
 * Two bugs are covered. The calendar reported MCX as OPEN on every national
 * holiday, because holiday entries are tagged ['NSE','BSE'] and MCX inherited
 * nothing. And `getMarketPhase` was NSE-only, so the entire MCX evening session
 * (15:30–23:30, when crude and the metals move on US data) was classified
 * POST_MARKET/AFTER_HOURS — phases in which `getPhaseConfig` throttles bots to a
 * 5–10 minute tick and a 10–30 minute scan.
 */

/** Freeze the clock at a given IST wall-clock time. */
function freezeIST(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

afterEach(() => vi.useRealTimers());

describe('MCX holidays', () => {
  const calendar = new MarketCalendar();

  it('treats a national holiday as a holiday for MCX and CDS too', () => {
    // 2026-01-26 Republic Day, listed as ['NSE','BSE'].
    const republicDay = new Date('2026-01-26T12:00:00+05:30');

    expect(calendar.isHoliday(republicDay, 'NSE')).toBe(true);
    expect(calendar.isHoliday(republicDay, 'MCX')).toBe(true);
    expect(calendar.isHoliday(republicDay, 'CDS')).toBe(true);
  });

  it('does not invent holidays on ordinary days', () => {
    const ordinary = new Date('2026-01-27T12:00:00+05:30');
    expect(calendar.isHoliday(ordinary, 'NSE')).toBe(false);
    expect(calendar.isHoliday(ordinary, 'MCX')).toBe(false);
  });
});

describe('getMarketPhase — per exchange', () => {
  it('classifies the MCX evening session as MARKET_HOURS, not AFTER_HOURS', () => {
    // 20:00 IST on a Thursday — NSE shut hours ago, MCX very much open.
    freezeIST('2026-08-13T20:00:00+05:30');
    const calendar = new MarketCalendar();

    expect(calendar.getMarketPhase('MCX')).toBe('MARKET_HOURS');
    expect(calendar.getMarketPhase('NSE')).toBe('AFTER_HOURS');
  });

  it('keeps bots at market cadence during the MCX evening', () => {
    freezeIST('2026-08-13T21:30:00+05:30');
    const calendar = new MarketCalendar();

    const mcx = calendar.getPhaseConfig(calendar.getMarketPhase('MCX'));
    const nse = calendar.getPhaseConfig(calendar.getMarketPhase('NSE'));

    // The whole point: the commodity session must not be throttled to idle.
    expect(mcx.botTickMs).toBeLessThan(nse.botTickMs);
    expect(mcx.scanIntervalMs).toBeLessThan(nse.scanIntervalMs);
  });

  it('agrees with isMarketOpen for MCX in the evening', () => {
    freezeIST('2026-08-13T22:00:00+05:30');
    const calendar = new MarketCalendar();

    expect(calendar.isMarketOpen('MCX')).toBe(true);
    expect(calendar.isMarketOpen('NSE')).toBe(false);
    expect(calendar.getMarketPhase('MCX')).toBe('MARKET_HOURS');
  });

  it('closes MCX after 23:30', () => {
    freezeIST('2026-08-13T23:45:00+05:30');
    const calendar = new MarketCalendar();

    expect(calendar.isMarketOpen('MCX')).toBe(false);
    expect(calendar.getMarketPhase('MCX')).toBe('AFTER_HOURS');
  });

  it('treats 09:05 as pre-market for NSE but open for MCX', () => {
    freezeIST('2026-08-13T09:05:00+05:30');
    const calendar = new MarketCalendar();

    expect(calendar.getMarketPhase('NSE')).toBe('PRE_MARKET');
    expect(calendar.getMarketPhase('MCX')).toBe('MARKET_HOURS');
    expect(calendar.isMarketOpen('MCX')).toBe(true);
    expect(calendar.isMarketOpen('NSE')).toBe(false);
  });

  it('defaults to NSE when no exchange is given, so existing callers are unchanged', () => {
    freezeIST('2026-08-13T20:00:00+05:30');
    const calendar = new MarketCalendar();
    expect(calendar.getMarketPhase()).toBe(calendar.getMarketPhase('NSE'));
  });

  it('reports HOLIDAY for MCX on a national holiday', () => {
    freezeIST('2026-01-26T20:00:00+05:30');
    const calendar = new MarketCalendar();
    expect(calendar.getMarketPhase('MCX')).toBe('HOLIDAY');
    expect(calendar.isMarketOpen('MCX')).toBe(false);
  });
});

describe('getNextMarketOpen — per exchange', () => {
  it('uses 09:00 for MCX and 09:15 for NSE', () => {
    // Before either open, on a normal trading day.
    freezeIST('2026-08-13T07:00:00+05:30');
    const calendar = new MarketCalendar();

    expect(calendar.getNextMarketOpen('MCX').date).toMatch(/09:00 IST$/);
    expect(calendar.getNextMarketOpen('NSE').date).toMatch(/09:15 IST$/);
  });

  it('uses 09:00 for CDS', () => {
    freezeIST('2026-08-13T07:00:00+05:30');
    const calendar = new MarketCalendar();
    expect(calendar.getNextMarketOpen('CDS').date).toMatch(/09:00 IST$/);
  });
});
