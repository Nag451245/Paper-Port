export interface ResolvedMemory {
    symbol: string;
    signalDirection: string;
    signalStrategy: string;
    niftyBand: string;
    vixLevel: number;
    regime: string;
    outcome: string;
    pnlPct: number;
    holdingMinutes: number;
    dayOfWeek: number;
    hourOfDay: number;
    gapPct: number;
    signalConfidence: number;
}
export interface PatternInsight {
    pattern: string;
    description: string;
    occurrences: number;
    winRate: number;
    avgPnlPct: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    actionable: boolean;
    recommendation: string;
}
export declare class LessonsEngineService {
    generateLesson(memory: ResolvedMemory): string;
    generatePatternInsights(userId: string): Promise<PatternInsight[]>;
    getRelevantLessons(userId: string, symbol: string, strategy: string, regime: string, limit?: number): Promise<string[]>;
    getDayOfWeekName(day: number): string;
    private extractInsights;
    private regimeMatchesDirection;
    private regimeContradictsDirection;
    private detectGapDayPatterns;
    private detectNiftyBandPatterns;
    private detectStrategyRegimePatterns;
    private detectSymbolLevelPatterns;
    private detectTimeOfDayPatterns;
    private detectVixPatterns;
    private patternConfidence;
    private uniqueValues;
}
//# sourceMappingURL=lessons-engine.service.d.ts.map