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
  // 2026
  { date: '2026-01-26', name: 'Republic Day', exchanges: ['NSE', 'BSE'] },
  { date: '2026-02-17', name: 'Mahashivratri', exchanges: ['NSE', 'BSE'] },
  { date: '2026-03-04', name: 'Holi', exchanges: ['NSE', 'BSE'] },
  { date: '2026-03-20', name: 'Id-Ul-Fitr (Ramadan)', exchanges: ['NSE', 'BSE'] },
  { date: '2026-03-25', name: 'Shri Ram Navami', exchanges: ['NSE', 'BSE'] },
  { date: '2026-04-01', name: 'Shri Mahavir Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2026-04-03', name: 'Good Friday', exchanges: ['NSE', 'BSE'] },
  { date: '2026-04-14', name: 'Dr. Ambedkar Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2026-05-01', name: 'Maharashtra Day', exchanges: ['NSE', 'BSE'] },
  { date: '2026-05-28', name: 'Bakri Id', exchanges: ['NSE', 'BSE'] },
  { date: '2026-08-15', name: 'Independence Day', exchanges: ['NSE', 'BSE'] },
  { date: '2026-08-18', name: 'Ganesh Chaturthi', exchanges: ['NSE', 'BSE'] },
  { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2026-10-09', name: 'Dussehra', exchanges: ['NSE', 'BSE'] },
  { date: '2026-10-12', name: 'Diwali (Lakshmi Puja)', exchanges: ['NSE', 'BSE'] },
  { date: '2026-10-13', name: 'Diwali (Balipratipada)', exchanges: ['NSE', 'BSE'] },
  { date: '2026-10-25', name: 'Guru Nanak Jayanti', exchanges: ['NSE', 'BSE'] },
  { date: '2026-12-25', name: 'Christmas', exchanges: ['NSE', 'BSE'] },
];

// Muhurat trading windows (Diwali evening sessions)
const MUHURAT_SESSIONS: { date: string; start: number; end: number }[] = [
  { date: '2025-10-22', start: 1080, end: 1140 }, // 6:00 PM - 7:00 PM
  { date: '2026-10-12', start: 1080, end: 1140 },
];

export class MarketCalendar {
  private holidaySet = new Map<string, HolidayEntry>();

  constructor() {
    for (const h of NSE_HOLIDAYS) {
      this.holidaySet.set(h.date, h);
    }
  }

  private getIST(): Date {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
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
    return entry.exchanges.includes(exchange);
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

  isMarketOpen(exchange: string = 'NSE'): boolean {
    const ist = this.getIST();

    if (this.isMuhuratSession(ist)) return true;
    if (this.isWeekend(ist)) return false;
    if (this.isHoliday(ist, exchange)) return false;

    const mins = this.getTotalMinutes(ist);

    switch (exchange) {
      case 'MCX':
        return mins >= 540 && mins <= 1410; // 9:00 AM - 11:30 PM
      case 'CDS':
        return mins >= 540 && mins <= 1020; // 9:00 AM - 5:00 PM
      default: // NSE/BSE
        return mins >= 555 && mins <= 930;  // 9:15 AM - 3:30 PM
    }
  }

  getMarketPhase(): MarketPhase {
    const ist = this.getIST();

    if (this.isWeekend(ist)) return 'WEEKEND';
    if (this.isHoliday(ist)) return 'HOLIDAY';
    if (this.isMuhuratSession(ist)) return 'MARKET_HOURS';

    const mins = this.getTotalMinutes(ist);

    if (mins >= 480 && mins < 555) return 'PRE_MARKET';   // 8:00 - 9:15
    if (mins >= 555 && mins <= 930) return 'MARKET_HOURS'; // 9:15 - 15:30
    if (mins > 930 && mins <= 1020) return 'POST_MARKET';  // 15:30 - 17:00
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
        return { pingIntervalMs: 5 * 60_000, botTickMs: 0, scanIntervalMs: 0, botsActive: false, label: 'Pre-Market (8:00-9:15 IST)' };
      case 'MARKET_HOURS':
        return { pingIntervalMs: 5 * 60_000, botTickMs: 60_000, scanIntervalMs: 5 * 60_000, botsActive: true, label: 'Market Hours (9:15-15:30 IST)' };
      case 'POST_MARKET':
        return { pingIntervalMs: 10 * 60_000, botTickMs: 0, scanIntervalMs: 0, botsActive: false, label: 'Post-Market (15:30-17:00 IST)' };
      case 'AFTER_HOURS':
        return { pingIntervalMs: 14 * 60_000, botTickMs: 0, scanIntervalMs: 0, botsActive: false, label: 'After-Hours' };
      case 'WEEKEND':
        return { pingIntervalMs: 30 * 60_000, botTickMs: 0, scanIntervalMs: 0, botsActive: false, label: 'Weekend' };
      case 'HOLIDAY':
        return { pingIntervalMs: 30 * 60_000, botTickMs: 0, scanIntervalMs: 0, botsActive: false, label: `Holiday: ${this.getHolidayName() ?? 'Market Closed'}` };
    }
  }

  getNextMarketOpen(): { date: string; label: string } {
    const ist = this.getIST();
    const check = new Date(ist);

    for (let i = 0; i < 14; i++) {
      check.setDate(check.getDate() + (i === 0 ? 0 : 1));
      const day = check.getDay();
      if (day === 0 || day === 6) continue;
      if (this.isHoliday(check)) continue;

      const key = this.toDateKey(check);
      if (i === 0) {
        const mins = this.getTotalMinutes(ist);
        if (mins < 555) {
          return { date: `${key} 09:15 IST`, label: 'Today' };
        }
        continue;
      }

      return { date: `${key} 09:15 IST`, label: this.getDayLabel(check) };
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
