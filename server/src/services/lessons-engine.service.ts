import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';

const log = createChildLogger('lessons-engine');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

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

export class LessonsEngineService {

  generateLesson(memory: ResolvedMemory): string {
    const insights = this.extractInsights(memory);
    const combined = insights.slice(0, 3).join('. ');

    const outcomeLabel = memory.outcome === 'WIN' ? 'Won' : memory.outcome === 'LOSS' ? 'Lost' : memory.outcome;
    const pnlSign = memory.pnlPct >= 0 ? '+' : '';

    return (
      `${memory.symbol} ${memory.signalDirection} via ${memory.signalStrategy} ` +
      `at NIFTY ${memory.niftyBand} (VIX: ${memory.vixLevel.toFixed(1)}) ` +
      `in ${memory.regime} regime: ${outcomeLabel} ${pnlSign}${memory.pnlPct.toFixed(2)}% ` +
      `in ${memory.holdingMinutes} min. Key: ${combined}`
    );
  }

  async generatePatternInsights(userId: string): Promise<PatternInsight[]> {
    const prisma = getPrisma();
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const memories = await prisma.marketMemory.findMany({
      where: {
        userId,
        resolvedAt: { not: null },
        outcome: { not: null },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (memories.length === 0) return [];

    const patterns: PatternInsight[] = [];

    this.detectGapDayPatterns(memories, patterns);
    this.detectNiftyBandPatterns(memories, patterns);
    this.detectStrategyRegimePatterns(memories, patterns);
    this.detectSymbolLevelPatterns(memories, patterns);
    this.detectTimeOfDayPatterns(memories, patterns);
    this.detectVixPatterns(memories, patterns);

    const significant = patterns
      .filter(p => p.occurrences >= 5)
      .sort((a, b) => {
        const aSignificance = a.occurrences * Math.abs(a.winRate - 0.5);
        const bSignificance = b.occurrences * Math.abs(b.winRate - 0.5);
        return bSignificance - aSignificance;
      })
      .slice(0, 10);

    log.info({ userId, totalMemories: memories.length, patternCount: significant.length }, 'Pattern insights generated');

    return significant;
  }

  async getRelevantLessons(
    userId: string,
    symbol: string,
    strategy: string,
    regime: string,
    limit = 10,
  ): Promise<string[]> {
    const prisma = getPrisma();

    const memories = await prisma.marketMemory.findMany({
      where: {
        userId,
        resolvedAt: { not: null },
        outcome: { not: null },
        OR: [
          { symbol },
          { signalStrategy: strategy },
          { regime },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit * 3,
    });

    const scored: Array<{ memory: typeof memories[number]; relevance: number }> = [];

    for (const m of memories) {
      let relevance = 0;
      if (m.symbol === symbol) relevance += 3;
      if (m.signalStrategy === strategy) relevance += 2;
      if (m.regime === regime) relevance += 1;
      scored.push({ memory: m, relevance });
    }

    scored.sort((a, b) => b.relevance - a.relevance);

    const lessons: string[] = [];
    for (const { memory } of scored.slice(0, limit)) {
      if (memory.outcome == null || memory.pnlPct == null || memory.holdingMinutes == null) continue;

      const resolved: ResolvedMemory = {
        symbol: memory.symbol,
        signalDirection: memory.signalDirection,
        signalStrategy: memory.signalStrategy,
        niftyBand: memory.niftyBand,
        vixLevel: memory.vixLevel,
        regime: memory.regime,
        outcome: memory.outcome,
        pnlPct: memory.pnlPct,
        holdingMinutes: memory.holdingMinutes,
        dayOfWeek: memory.dayOfWeek,
        hourOfDay: memory.hourOfDay,
        gapPct: memory.gapPct,
        signalConfidence: memory.signalConfidence,
      };

      lessons.push(this.generateLesson(resolved));
    }

    return lessons;
  }

  getDayOfWeekName(day: number): string {
    return DAY_NAMES[day] ?? 'Unknown';
  }

  private extractInsights(memory: ResolvedMemory): string[] {
    const insights: string[] = [];
    const isWin = memory.outcome === 'WIN';

    if (isWin && memory.vixLevel < 15) {
      insights.push('Low volatility favored this setup');
    }

    if (isWin && this.regimeMatchesDirection(memory.regime, memory.signalDirection)) {
      insights.push('Regime-aligned trade worked well');
    }

    if (!isWin && memory.vixLevel > 20) {
      insights.push('High volatility made this setup unreliable');
    }

    if (!isWin && this.regimeContradictsDirection(memory.regime, memory.signalDirection)) {
      insights.push('Counter-trend trade in strong downtrend failed');
    }

    if (isWin && Math.abs(memory.gapPct) > 1) {
      insights.push('Gap-up/down provided momentum for this trade');
    }

    if (!isWin && Math.abs(memory.gapPct) > 1) {
      insights.push('Gap faded — gap trades unreliable in current conditions');
    }

    if (isWin && memory.hourOfDay < 10) {
      insights.push('Morning session provided good entry');
    }

    if (!isWin && memory.hourOfDay > 14) {
      insights.push('Late session entry — reduced time for recovery');
    }

    if (isWin && memory.signalConfidence > 0.7) {
      insights.push('Consistent with historical pattern — high confidence setup');
    }

    if (insights.length === 0) {
      insights.push(isWin ? 'Standard winning setup' : 'Setup did not produce expected result');
    }

    return insights;
  }

  private regimeMatchesDirection(regime: string, direction: string): boolean {
    const r = regime.toUpperCase().replace(/\s+/g, '_');
    return (
      (direction === 'BUY' && r === 'TRENDING_UP') ||
      (direction === 'SELL' && r === 'TRENDING_DOWN')
    );
  }

  private regimeContradictsDirection(regime: string, direction: string): boolean {
    const r = regime.toUpperCase().replace(/\s+/g, '_');
    return (
      (direction === 'BUY' && r === 'TRENDING_DOWN') ||
      (direction === 'SELL' && r === 'TRENDING_UP')
    );
  }

  private detectGapDayPatterns(memories: any[], patterns: PatternInsight[]): void {
    for (let dow = 0; dow < 7; dow++) {
      const gapTrades = memories.filter(
        m => m.dayOfWeek === dow && Math.abs(m.gapPct) > 0.5,
      );
      if (gapTrades.length < 5) continue;

      for (const strategy of this.uniqueValues(gapTrades, 'signalStrategy')) {
        const subset = gapTrades.filter(m => m.signalStrategy === strategy);
        if (subset.length < 5) continue;

        const wins = subset.filter(m => m.outcome === 'WIN').length;
        const winRate = wins / subset.length;
        const avgPnl = subset.reduce((s: number, m: any) => s + (m.pnlPct ?? 0), 0) / subset.length;
        const dayName = this.getDayOfWeekName(dow);
        const gapDir = subset.filter(m => m.gapPct > 0).length > subset.length / 2 ? 'gap-ups' : 'gap-downs';

        patterns.push({
          pattern: `${dayName}_gap_${strategy}`,
          description: `${dayName} ${gapDir} fade: ${(winRate * 100).toFixed(0)}% win rate on ${strategy} after gap > 0.5% on ${dayName}s`,
          occurrences: subset.length,
          winRate,
          avgPnlPct: Number(avgPnl.toFixed(2)),
          confidence: this.patternConfidence(subset.length, winRate),
          actionable: Math.abs(winRate - 0.5) > 0.15,
          recommendation: winRate > 0.6
            ? `${strategy} after ${dayName} gaps has been profitable — continue using`
            : `Avoid ${strategy} after ${dayName} gaps — low win rate`,
        });
      }
    }
  }

  private detectNiftyBandPatterns(memories: any[], patterns: PatternInsight[]): void {
    const bands = this.uniqueValues(memories, 'niftyBand');

    for (const band of bands) {
      const bandTrades = memories.filter(m => m.niftyBand === band);

      for (const strategy of this.uniqueValues(bandTrades, 'signalStrategy')) {
        const subset = bandTrades.filter(m => m.signalStrategy === strategy);
        if (subset.length < 5) continue;

        const wins = subset.filter(m => m.outcome === 'WIN').length;
        const winRate = wins / subset.length;
        const avgPnl = subset.reduce((s: number, m: any) => s + (m.pnlPct ?? 0), 0) / subset.length;

        if (strategy.toLowerCase().includes('mean_reversion') || strategy.toLowerCase().includes('reversal')) {
          patterns.push({
            pattern: `mean_reversion_${band}`,
            description: `Mean reversion works at NIFTY ${band}: ${(winRate * 100).toFixed(0)}% historical win rate`,
            occurrences: subset.length,
            winRate,
            avgPnlPct: Number(avgPnl.toFixed(2)),
            confidence: this.patternConfidence(subset.length, winRate),
            actionable: winRate > 0.55,
            recommendation: winRate > 0.6
              ? `Mean reversion at NIFTY ${band} has strong track record`
              : `Mean reversion at NIFTY ${band} underperforms — use with caution`,
          });
        }
      }
    }
  }

  private detectStrategyRegimePatterns(memories: any[], patterns: PatternInsight[]): void {
    const strategies = this.uniqueValues(memories, 'signalStrategy');
    const regimes = this.uniqueValues(memories, 'regime');

    for (const strategy of strategies) {
      for (const regime of regimes) {
        const subset = memories.filter(m => m.signalStrategy === strategy && m.regime === regime);
        if (subset.length < 5) continue;

        const losses = subset.filter(m => m.outcome === 'LOSS').length;
        const lossRate = losses / subset.length;
        const winRate = 1 - lossRate;
        const avgPnl = subset.reduce((s: number, m: any) => s + (m.pnlPct ?? 0), 0) / subset.length;

        if (lossRate > 0.55) {
          patterns.push({
            pattern: `${strategy}_fails_${regime}`,
            description: `Strategy ${strategy} fails in ${regime}: ${(lossRate * 100).toFixed(0)}% losses`,
            occurrences: subset.length,
            winRate,
            avgPnlPct: Number(avgPnl.toFixed(2)),
            confidence: this.patternConfidence(subset.length, winRate),
            actionable: true,
            recommendation: `Avoid ${strategy} during ${regime} regime — historically unprofitable`,
          });
        } else if (winRate > 0.65) {
          patterns.push({
            pattern: `${strategy}_works_${regime}`,
            description: `Strategy ${strategy} excels in ${regime}: ${(winRate * 100).toFixed(0)}% win rate`,
            occurrences: subset.length,
            winRate,
            avgPnlPct: Number(avgPnl.toFixed(2)),
            confidence: this.patternConfidence(subset.length, winRate),
            actionable: true,
            recommendation: `Prioritize ${strategy} during ${regime} regime`,
          });
        }
      }
    }
  }

  private detectSymbolLevelPatterns(memories: any[], patterns: PatternInsight[]): void {
    const symbols = this.uniqueValues(memories, 'symbol');

    for (const symbol of symbols) {
      const symbolTrades = memories.filter(m => m.symbol === symbol);
      if (symbolTrades.length < 5) continue;

      const keyLevelTrades = symbolTrades.filter(m => m.keyLevels != null);
      if (keyLevelTrades.length < 5) continue;

      const wins = keyLevelTrades.filter(m => m.outcome === 'WIN').length;
      const winRate = wins / keyLevelTrades.length;
      const avgPnl = keyLevelTrades.reduce((s: number, m: any) => s + (m.pnlPct ?? 0), 0) / keyLevelTrades.length;

      patterns.push({
        pattern: `${symbol}_key_level`,
        description: `${symbol} reverses at key levels: tested ${keyLevelTrades.length} times, held ${wins} times`,
        occurrences: keyLevelTrades.length,
        winRate,
        avgPnlPct: Number(avgPnl.toFixed(2)),
        confidence: this.patternConfidence(keyLevelTrades.length, winRate),
        actionable: winRate > 0.55,
        recommendation: winRate > 0.6
          ? `${symbol} key level reversals are reliable — use for entries`
          : `${symbol} key level reactions are inconsistent`,
      });
    }
  }

  private detectTimeOfDayPatterns(memories: any[], patterns: PatternInsight[]): void {
    const timeSlots = [
      { label: 'Opening (9:15-10:00)', min: 9, max: 10 },
      { label: 'Mid-morning (10:00-12:00)', min: 10, max: 12 },
      { label: 'Afternoon (12:00-14:00)', min: 12, max: 14 },
      { label: 'Closing (14:00-15:30)', min: 14, max: 16 },
    ];

    for (const slot of timeSlots) {
      for (const strategy of this.uniqueValues(memories, 'signalStrategy')) {
        const subset = memories.filter(
          m => m.hourOfDay >= slot.min && m.hourOfDay < slot.max && m.signalStrategy === strategy,
        );
        if (subset.length < 5) continue;

        const wins = subset.filter(m => m.outcome === 'WIN').length;
        const winRate = wins / subset.length;
        const avgPnl = subset.reduce((s: number, m: any) => s + (m.pnlPct ?? 0), 0) / subset.length;

        if (Math.abs(winRate - 0.5) > 0.15) {
          patterns.push({
            pattern: `${strategy}_${slot.label.split(' ')[0].toLowerCase()}`,
            description: `${strategy} during ${slot.label}: ${(winRate * 100).toFixed(0)}% win rate`,
            occurrences: subset.length,
            winRate,
            avgPnlPct: Number(avgPnl.toFixed(2)),
            confidence: this.patternConfidence(subset.length, winRate),
            actionable: true,
            recommendation: winRate > 0.6
              ? `${strategy} performs well during ${slot.label}`
              : `Avoid ${strategy} during ${slot.label}`,
          });
        }
      }
    }
  }

  private detectVixPatterns(memories: any[], patterns: PatternInsight[]): void {
    const vixBands = [
      { label: 'Low VIX (<15)', min: 0, max: 15 },
      { label: 'Normal VIX (15-20)', min: 15, max: 20 },
      { label: 'High VIX (>20)', min: 20, max: Infinity },
    ];

    for (const vb of vixBands) {
      for (const strategy of this.uniqueValues(memories, 'signalStrategy')) {
        const subset = memories.filter(
          m => m.vixLevel >= vb.min && m.vixLevel < vb.max && m.signalStrategy === strategy,
        );
        if (subset.length < 5) continue;

        const wins = subset.filter(m => m.outcome === 'WIN').length;
        const winRate = wins / subset.length;
        const avgPnl = subset.reduce((s: number, m: any) => s + (m.pnlPct ?? 0), 0) / subset.length;

        if (Math.abs(winRate - 0.5) > 0.15) {
          patterns.push({
            pattern: `${strategy}_vix_${vb.label.split(' ')[0].toLowerCase()}`,
            description: `${strategy} at ${vb.label}: ${(winRate * 100).toFixed(0)}% win rate, avg PnL ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`,
            occurrences: subset.length,
            winRate,
            avgPnlPct: Number(avgPnl.toFixed(2)),
            confidence: this.patternConfidence(subset.length, winRate),
            actionable: true,
            recommendation: winRate > 0.6
              ? `${strategy} is profitable at ${vb.label} — lean into this setup`
              : `${strategy} struggles at ${vb.label} — reduce position size or skip`,
          });
        }
      }
    }
  }

  private patternConfidence(occurrences: number, winRate: number): 'HIGH' | 'MEDIUM' | 'LOW' {
    const deviation = Math.abs(winRate - 0.5);
    if (occurrences >= 20 && deviation > 0.15) return 'HIGH';
    if (occurrences >= 10 && deviation > 0.10) return 'MEDIUM';
    return 'LOW';
  }

  private uniqueValues(records: any[], field: string): string[] {
    const set = new Set<string>();
    for (const r of records) {
      if (r[field] != null) set.add(String(r[field]));
    }
    return Array.from(set);
  }
}
