export type MarketPhase = 'PRE_MARKET' | 'MARKET_HOURS' | 'POST_MARKET' | 'AFTER_HOURS' | 'WEEKEND' | 'HOLIDAY';
export declare class MarketCalendar {
    private holidaySet;
    constructor();
    private getIST;
    private toDateKey;
    private getTotalMinutes;
    isHoliday(date?: Date, exchange?: string): boolean;
    getHolidayName(date?: Date): string | null;
    isWeekend(date?: Date): boolean;
    isMuhuratSession(date?: Date): boolean;
    isMarketOpen(exchange?: string): boolean;
    getMarketPhase(): MarketPhase;
    getPhaseConfig(phase: MarketPhase): {
        pingIntervalMs: number;
        botTickMs: number;
        scanIntervalMs: number;
        botsActive: boolean;
        label: string;
    };
    getNextMarketOpen(): {
        date: string;
        label: string;
    };
    private getDayLabel;
    getUpcomingHolidays(count?: number): Array<{
        date: string;
        name: string;
    }>;
    getStatus(): {
        phase: MarketPhase;
        phaseLabel: string;
        isOpen: boolean;
        isHoliday: boolean;
        holidayName: string | null;
        isWeekend: boolean;
        nextOpen: {
            date: string;
            label: string;
        };
        upcomingHolidays: Array<{
            date: string;
            name: string;
        }>;
        timestamp: string;
    };
}
//# sourceMappingURL=market-calendar.d.ts.map