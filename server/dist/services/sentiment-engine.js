import { chatCompletionJSON } from '../lib/openai.js';
import { MarketDataService } from './market-data.service.js';
export class SentimentEngine {
    prisma;
    marketData = new MarketDataService();
    cache = null;
    cacheExpiry = 0;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getSentimentSnapshot() {
        if (this.cache && Date.now() < this.cacheExpiry) {
            return this.cache;
        }
        const [fiiDii, breadth, vix] = await Promise.all([
            this.fetchFIIDII(),
            this.fetchMarketBreadth(),
            this.marketData.getVIX().catch(() => ({ value: 15, change: 0 })),
        ]);
        const fearGreed = this.computeFearGreedIndex(fiiDii, breadth, vix.value ?? 15);
        const signals = [];
        if (fiiDii) {
            if (fiiDii.fiiNet > 1000) {
                signals.push({
                    source: 'FII_FLOW', symbol: 'NIFTY', sentiment: 'BULLISH',
                    strength: Math.min(1, fiiDii.fiiNet / 5000),
                    headline: `FII net buying ₹${fiiDii.fiiNet}Cr — institutional support`,
                    timestamp: new Date().toISOString(),
                });
            }
            else if (fiiDii.fiiNet < -1000) {
                signals.push({
                    source: 'FII_FLOW', symbol: 'NIFTY', sentiment: 'BEARISH',
                    strength: Math.min(1, Math.abs(fiiDii.fiiNet) / 5000),
                    headline: `FII net selling ₹${Math.abs(fiiDii.fiiNet)}Cr — institutional exit`,
                    timestamp: new Date().toISOString(),
                });
            }
            if (fiiDii.diiNet > 1000) {
                signals.push({
                    source: 'DII_FLOW', symbol: 'NIFTY', sentiment: 'BULLISH',
                    strength: Math.min(1, fiiDii.diiNet / 3000),
                    headline: `DII net buying ₹${fiiDii.diiNet}Cr — domestic support`,
                    timestamp: new Date().toISOString(),
                });
            }
        }
        if (breadth.ratio > 2) {
            signals.push({
                source: 'MARKET_BREADTH', symbol: 'MARKET', sentiment: 'BULLISH',
                strength: Math.min(1, breadth.ratio / 4),
                headline: `Strong breadth: ${breadth.advancers} advancers vs ${breadth.decliners} decliners`,
                timestamp: new Date().toISOString(),
            });
        }
        else if (breadth.ratio < 0.5) {
            signals.push({
                source: 'MARKET_BREADTH', symbol: 'MARKET', sentiment: 'BEARISH',
                strength: Math.min(1, 1 / breadth.ratio / 4),
                headline: `Weak breadth: ${breadth.decliners} decliners vs ${breadth.advancers} advancers`,
                timestamp: new Date().toISOString(),
            });
        }
        const vixValue = vix.value ?? 15;
        if (vixValue > 25) {
            signals.push({
                source: 'VIX', symbol: 'INDIAVIX', sentiment: 'BEARISH',
                strength: Math.min(1, (vixValue - 20) / 20),
                headline: `India VIX at ${vixValue} — elevated fear in the market`,
                timestamp: new Date().toISOString(),
            });
        }
        else if (vixValue < 12) {
            signals.push({
                source: 'VIX', symbol: 'INDIAVIX', sentiment: 'BULLISH',
                strength: 0.5,
                headline: `India VIX at ${vixValue} — complacency / low volatility regime`,
                timestamp: new Date().toISOString(),
            });
        }
        const bullishCount = signals.filter(s => s.sentiment === 'BULLISH').length;
        const bearishCount = signals.filter(s => s.sentiment === 'BEARISH').length;
        const sentimentScore = signals.length > 0
            ? (bullishCount - bearishCount) / signals.length
            : 0;
        const overallSentiment = sentimentScore > 0.3 ? 'BULLISH'
            : sentimentScore < -0.3 ? 'BEARISH' : 'NEUTRAL';
        const snapshot = {
            overallSentiment,
            sentimentScore: Number(sentimentScore.toFixed(2)),
            fiiDiiFlow: fiiDii,
            signals,
            corporateActions: [],
            marketBreadth: breadth,
            fearGreedIndex: fearGreed,
        };
        this.cache = snapshot;
        this.cacheExpiry = Date.now() + 5 * 60_000;
        return snapshot;
    }
    async getAISentimentAnalysis(symbols) {
        const snapshot = await this.getSentimentSnapshot();
        try {
            const result = await chatCompletionJSON({
                messages: [
                    {
                        role: 'system',
                        content: `You are a market sentiment analyst for Indian markets. Analyze the given sentiment data and provide insights for each symbol.
Return JSON: { "analysis": "overall market analysis", "symbolSentiments": [{ "symbol": "...", "sentiment": "BULLISH|BEARISH|NEUTRAL", "confidence": 0-1, "reasoning": "..." }] }`,
                    },
                    {
                        role: 'user',
                        content: `Market Sentiment: ${snapshot.overallSentiment} (score: ${snapshot.sentimentScore})
Fear & Greed: ${snapshot.fearGreedIndex}/100
Signals: ${JSON.stringify(snapshot.signals.slice(0, 5))}
Breadth: A/D ratio ${snapshot.marketBreadth.ratio}
Symbols to analyze: ${symbols.join(', ')}`,
                    },
                ],
                maxTokens: 500,
                temperature: 0.3,
            });
            return result;
        }
        catch {
            return {
                analysis: `Market sentiment is ${snapshot.overallSentiment} with fear/greed at ${snapshot.fearGreedIndex}`,
                symbolSentiments: symbols.map(s => ({
                    symbol: s,
                    sentiment: snapshot.overallSentiment,
                    confidence: 0.5,
                    reasoning: 'Based on overall market sentiment',
                })),
            };
        }
    }
    async fetchFIIDII() {
        try {
            const data = await this.marketData.getFIIDII();
            if (!data)
                return null;
            const fiiNet = data.fiiBuy - data.fiiSell;
            const diiNet = data.diiBuy - data.diiSell;
            return {
                date: new Date().toISOString().split('T')[0],
                fiiBuy: data.fiiBuy ?? 0,
                fiiSell: data.fiiSell ?? 0,
                fiiNet,
                diiBuy: data.diiBuy ?? 0,
                diiSell: data.diiSell ?? 0,
                diiNet,
                signal: fiiNet > 0 && diiNet > 0 ? 'STRONG_BULLISH'
                    : fiiNet < 0 && diiNet < 0 ? 'STRONG_BEARISH'
                        : fiiNet > 0 ? 'FII_BULLISH'
                            : diiNet > 0 ? 'DII_SUPPORT' : 'MIXED',
            };
        }
        catch {
            return null;
        }
    }
    async fetchMarketBreadth() {
        try {
            const movers = await this.marketData.getTopMovers();
            const gainers = movers?.gainers?.length ?? 0;
            const losers = movers?.losers?.length ?? 0;
            const ratio = losers > 0 ? gainers / losers : gainers > 0 ? 3 : 1;
            return { advancers: gainers, decliners: losers, unchanged: 0, ratio: Number(ratio.toFixed(2)) };
        }
        catch {
            return { advancers: 0, decliners: 0, unchanged: 0, ratio: 1 };
        }
    }
    computeFearGreedIndex(fiiDii, breadth, vix) {
        let score = 50;
        if (vix > 30)
            score -= 20;
        else if (vix > 20)
            score -= 10;
        else if (vix < 12)
            score += 15;
        else if (vix < 15)
            score += 5;
        if (breadth.ratio > 2)
            score += 15;
        else if (breadth.ratio > 1.5)
            score += 8;
        else if (breadth.ratio < 0.5)
            score -= 15;
        else if (breadth.ratio < 0.7)
            score -= 8;
        if (fiiDii) {
            if (fiiDii.fiiNet > 2000)
                score += 10;
            else if (fiiDii.fiiNet < -2000)
                score -= 10;
        }
        return Math.max(0, Math.min(100, Math.round(score)));
    }
}
//# sourceMappingURL=sentiment-engine.js.map