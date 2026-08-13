export type MarketPhase =
  | 'PRE_MARKET'
  | 'MARKET_HOURS'
  | 'POST_MARKET'
  | 'AFTER_HOURS'
  | 'WEEKEND'
  | 'HOLIDAY';

interface HolidayEntry {
  date: string;   // YYYY-MM-DD
  name: string;
  exchanges: string[];  // which exchanges are closed
}

// NSE/BSE holidays for 2025 and 2026 (update annually)
const NSE_HOLIDAYS: HolidayEntry[] = [
  // 2025
  { date: '2025-02-26', name: 'Mahashivratri', exchanges: ['NSE', 'BSE'] },
  { date: '2025-03-14', name: 'Holi', exchanges: ['NSE', 'BSE'] },
  { date: '2025-03-31', name: 'Id-Ul-Fitr (Ramadan)', exchanges: ['NSE', 'BSE'] },
  { date: '2025-04-10', name: 'Shri Mahavir Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2025-04-14', name: 'Dr. Ambedkar Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2025-04-18', name: 'Good Friday', exchanges: ['NSE', 'BSE'] },
  { date: '2025-05-01', name: 'Maharashtra Day', exchanges: ['NSE', 'BSE'] },
  { date: '2025-06-07', name: 'Bakri Id', exchanges: ['NSE', 'BSE'] },
  { date: '2025-08-15', name: 'Independence Day', exchanges: ['NSE', 'BSE'] },
  { date: '2025-08-16', name: 'Parsi New Year', exchanges: ['NSE', 'BSE'] },
  { date: '2025-08-27', name: 'Ganesh Chaturthi', exchanges: ['NSE', 'BSE'] },
  { date: '2025-10-02', name: 'Mahatma Gandhi Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2025-10-21', name: 'Dussehra', exchanges: ['NSE', 'BSE'] },
  { date: '2025-10-22', name: 'Diwali (Lakshmi Puja)', exchanges: ['NSE', 'BSE'] },
  { date: '2025-11-05', name: 'Guru Nanak Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2025-12-25', name: 'Christmas', exchanges: ['NSE', 'BSE'] },
  // 2026 — Official NSE circular (15 trading holidays)
  // Mahashivratri (Feb 15) and Id-Ul-Fitr (Mar 21) fall on weekends — no trading holiday
  // Independence Day (Aug 15) falls on Saturday — no trading holiday
  { date: '2026-01-26', name: 'Republic Day', exchanges: ['NSE', 'BSE'] },
  { date: '2026-03-03', name: 'Holi', exchanges: ['NSE', 'BSE'] },
  { date: '2026-03-26', name: 'Shri Ram Navami', exchanges: ['NSE', 'BSE'] },
  { date: '2026-03-31', name: 'Shri Mahavir Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2026-04-03', name: 'Good Friday', exchanges: ['NSE', 'BSE'] },
  { date: '2026-04-14', name: 'Dr. Baba Saheb Ambedkar Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2026-05-01', name: 'Maharashtra Day', exchanges: ['NSE', 'BSE'] },
  { date: '2026-05-28', name: 'Bakri Id', exchanges: ['NSE', 'BSE'] },
  { date: '2026-06-26', name: 'Muharram', exchanges: ['NSE', 'BSE'] },
  { date: '2026-09-14', name: 'Ganesh Chaturthi', exchanges: ['NSE', 'BSE'] },
  { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2026-10-20', name: 'Dussehra', exchanges: ['NSE', 'BSE'] },
  { date: '2026-11-10', name: 'Diwali (Balipratipada)', exchanges: ['NSE', 'BSE'] },
  { date: '2026-11-24', name: 'Prakash Gurpurb Sri Guru Nanak Dev', exchanges: ['NSE', 'BSE'] },
  { date: '2026-12-25', name: 'Christmas', exchanges: ['NSE', 'BSE'] },
];

// Muhurat trading windows (Diwali evening sessions)
const MUHURAT_SESSIONS: { date: string; start: number; end: number }[] = [
  { date: '2025-10-22', start: 1080, end: 1140 }, // 6:00 PM - 7:00 PM
  { date: '2026-11-08', start: 1080, end: 1140 }, // Diwali Laxmi Pujan (Sunday — Muhurat only)
];

export class MarketCalendar {
  private holidaySet = new Map<string, HolidayEntry>();

  constructor() {
    for (const h of NSE_HOLIDAYS) {
      this.holidaySet.set(h.date, h);
    }
  }

  private getIST(): Date {
    // Manual UTC+5:30 offset — reliable on all Node.js builds regardless of ICU data
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
    return new Date(utcMs + 5.5 * 3600_000);
  }

  private toDateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private getTotalMinutes(d: Date): number {
    return d.getHours() * 60 + d.getMinutes();
  }

  isHoliday(date?: Date, exchange: string = 'NSE'): boolean {
    const d = date ?? this.getIST();
    const key = this.toDateKey(d);
    const entry = this.holidaySet.get(key);
    if (!entry) return false;

    const ex = exchange.toUpperCase();
    if (entry.exchanges.includes(ex)) return true;

    // MCX and CDS inherit the equity holiday list.
    //
    // Every entry above is tagged ['NSE','BSE'], so `isHoliday(d, 'MCX')`
    // previously returned FALSE for all of them — the calendar reported MCX as
    // OPEN on Republic Day and every other national holiday.
    //
    // Inheriting is the conservative direction: it is correct for full-day
    // national holidays, and errs toward "do not trade" on the handful of days
    // where MCX runs an evening session only. Encoding those exceptions needs
    // MCX's own annual circular, which is not in this repo — do not guess them.
    if (ex === 'MCX' || ex === 'CDS') {
      return entry.exchanges.includes('NSE');
    }

    return false;
  }

  getHolidayName(date?: Date): string | null {
    const d = date ?? this.getIST();
    const key = this.toDateKey(d);
    return this.holidaySet.get(key)?.name ?? null;
  }

  isWeekend(date?: Date): boolean {
    const d = date ?? this.getIST();
    const day = d.getDay();
    return day === 0 || day === 6;
  }

  isMuhuratSession(date?: Date): boolean {
    const d = date ?? this.getIST();
    const key = this.toDateKey(d);
    const session = MUHURAT_SESSIONS.find(s => s.date === key);
    if (!session) return false;
    const mins = this.getTotalMinutes(d);
    return mins >= session.start && mins <= session.end;
  }

  /**
   * Trading session for an exchange, in minutes since IST midnight.
   *
   * MCX's evening close moves with US daylight saving (23:30 vs 23:55). 23:30 is
   * used year-round here, matching what this file already assumed — it is the
   * conservative end of the range, so the only cost is not trading the last 25
   * minutes during part of the year. Sourcing the DST switch dates properly is a
   * separate job; do not guess them.
   */
  private getSession(exchange: string): {
    open: number; close: number; preOpen: number; postCloseMins: number;
  } {
    switch (exchange.toUpperCase()) {
      // No post-close window: the commodity evening session runs to the close,
      // and a POST_MARKET phase after 23:30 would just be the middle of the night.
      case 'MCX':
        return { open: 540, close: 1410, preOpen: 480, postCloseMins: 0 };  // 9:00 - 23:30
      case 'CDS':
        return { open: 540, close: 1020, preOpen: 480, postCloseMins: 0 };  // 9:00 - 17:00
      default:
        return { open: 555, close: 930, preOpen: 480, postCloseMins: 90 };  // 9:15 - 15:30, post to 17:00
    }
  }

  isMarketOpen(exchange: string = 'NSE'): boolean {
    const ist = this.getIST();

    if (this.isMuhuratSession(ist)) return true;
    if (this.isWeekend(ist)) return false;
    if (this.isHoliday(ist, exchange)) return false;

    const mins = this.getTotalMinutes(ist);
    const { open, close } = this.getSession(exchange);
    return mins >= open && mins <= close;
  }

  /**
   * Phase for an exchange. Defaults to NSE so existing callers are unchanged.
   *
   * This was NSE-only and took no argument, which mattered for commodities: the
   * whole MCX evening session (15:30–23:30 — when crude and the metals actually
   * move on US data) was classified POST_MARKET then AFTER_HOURS, and
   * `getPhaseConfig` throttles bots to a 5–10 minute tick and a 10–30 minute scan
   * in those phases. The most active part of the commodity day ran at idle speed.
   *
   * NOTE: ServerOrchestrator still drives one GLOBAL phase off the NSE default,
   * so passing 'MCX' here gives the right answer but does not by itself re-time
   * the schedulers. Per-exchange scheduling is a separate change.
   */
  getMarketPhase(exchange: string = 'NSE'): MarketPhase {
    const ist = this.getIST();

    if (this.isWeekend(ist)) return 'WEEKEND';
    if (this.isHoliday(ist, exchange)) return 'HOLIDAY';
    if (this.isMuhuratSession(ist)) return 'MARKET_HOURS';

    const mins = this.getTotalMinutes(ist);
    const { open, close, preOpen, postCloseMins } = this.getSession(exchange);

    if (mins >= preOpen && mins < open) return 'PRE_MARKET';
    if (mins >= open && mins <= close) return 'MARKET_HOURS';
    if (postCloseMins > 0 && mins > close && mins <= close + postCloseMins) return 'POST_MARKET';
    return 'AFTER_HOURS';
  }

  getPhaseConfig(phase: MarketPhase): {
    pingIntervalMs: number;
    botTickMs: number;
    scanIntervalMs: number;
    botsActive: boolean;
    label: string;
  } {
    switch (phase) {
      case 'PRE_MARKET':
        return { pingIntervalMs: 5 * 60_000, botTickMs: 5 * 60_000, scanIntervalMs: 10 * 60_000, botsActive: true, label: 'Pre-Market (8:00-9:15 IST)' };
      case 'MARKET_HOURS':
        return { pingIntervalMs: 5 * 60_000, botTickMs: 3 * 60_000, scanIntervalMs: 5 * 60_000, botsActive: true, label: 'Market Hours (9:15-15:30 IST)' };
      case 'POST_MARKET':
        return { pingIntervalMs: 10 * 60_000, botTickMs: 5 * 60_000, scanIntervalMs: 10 * 60_000, botsActive: true, label: 'Post-Market (15:30-17:00 IST)' };
      case 'AFTER_HOURS':
        return { pingIntervalMs: 14 * 60_000, botTickMs: 10 * 60_000, scanIntervalMs: 30 * 60_000, botsActive: true, label: 'After-Hours' };
      case 'WEEKEND':
        return { pingIntervalMs: 30 * 60_000, botTickMs: 30 * 60_000, scanIntervalMs: 0, botsActive: true, label: 'Weekend' };
      case 'HOLIDAY':
        return { pingIntervalMs: 30 * 60_000, botTickMs: 30 * 60_000, scanIntervalMs: 0, botsActive: true, label: `Holiday: ${this.getHolidayName() ?? 'Market Closed'}` };
    }
  }

  getNextMarketOpen(exchange: string = 'NSE'): { date: string; label: string } {
    const ist = this.getIST();
    const check = new Date(ist);
    const { open } = this.getSession(exchange);
    // The open time was hardcoded to 09:15, which is wrong for MCX and CDS (9:00).
    const openLabel = `${String(Math.floor(open / 60)).padStart(2, '0')}:${String(open % 60).padStart(2, '0')}`;

    for (let i = 0; i < 14; i++) {
      check.setDate(check.getDate() + (i === 0 ? 0 : 1));
      const day = check.getDay();
      if (day === 0 || day === 6) continue;
      if (this.isHoliday(check, exchange)) continue;

      const key = this.toDateKey(check);
      if (i === 0) {
        const mins = this.getTotalMinutes(ist);
        if (mins < open) {
          return { date: `${key} ${openLabel} IST`, label: 'Today' };
        }
        continue;
      }

      return { date: `${key} ${openLabel} IST`, label: this.getDayLabel(check) };
    }
    return { date: 'Unknown', label: 'Check calendar' };
  }

  private getDayLabel(d: Date): string {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[d.getDay()];
  }

  getUpcomingHolidays(count: number = 5): Array<{ date: string; name: string }> {
    const today = this.toDateKey(this.getIST());
    return NSE_HOLIDAYS
      .filter(h => h.date >= today)
      .slice(0, count)
      .map(h => ({ date: h.date, name: h.name }));
  }

  getStatus(): {
    phase: MarketPhase;
    phaseLabel: string;
    isOpen: boolean;
    isHoliday: boolean;
    holidayName: string | null;
    isWeekend: boolean;
    nextOpen: { date: string; label: string };
    upcomingHolidays: Array<{ date: string; name: string }>;
    timestamp: string;
  } {
    const phase = this.getMarketPhase();
    const config = this.getPhaseConfig(phase);
    return {
      phase,
      phaseLabel: config.label,
      isOpen: this.isMarketOpen(),
      isHoliday: this.isHoliday(),
      holidayName: this.getHolidayName(),
      isWeekend: this.isWeekend(),
      nextOpen: this.getNextMarketOpen(),
      upcomingHolidays: this.getUpcomingHolidays(),
      timestamp: this.getIST().toISOString(),
    };
  }
}
