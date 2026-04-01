import { MarketDataService } from './market-data.service.js';
import { chatCompletionJSON } from '../lib/openai.js';
import { getPrisma } from '../lib/prisma.js';
import { istDateStr } from '../lib/ist.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 12_000;
let _latestIntelligence = null;
export class GlobalMarketService {
    marketData = new MarketDataService();
    getLatestIntelligence() {
        return _latestIntelligence;
    }
    async runDailyIntelligenceScan() {
        console.log('[GlobalMarket] Starting daily intelligence scan...');
        const startTime = Date.now();
        const [giftNifty, globalIndices, fiiDii, sectorPerf, indianIndices] = await Promise.all([
            this.fetchGiftNifty(),
            this.fetchGlobalIndices(),
            this.marketData.getFIIDII(),
            this.fetchSectorPerformance(),
            this.marketData.getIndices(),
        ]);
        const contextParts = [];
        if (giftNifty) {
            contextParts.push(`Gift Nifty: ${giftNifty.value} (${giftNifty.changePercent >= 0 ? '+' : ''}${giftNifty.changePercent.toFixed(2)}%)`);
        }
        if (globalIndices.length > 0) {
            contextParts.push('Global Indices:');
            for (const idx of globalIndices) {
                contextParts.push(`  ${idx.name}: ${idx.value.toFixed(2)} (${idx.changePercent >= 0 ? '+' : ''}${idx.changePercent.toFixed(2)}%)`);
            }
        }
        if (indianIndices.length > 0) {
            contextParts.push('Indian Indices:');
            for (const idx of indianIndices) {
                contextParts.push(`  ${idx.name}: ${idx.value.toFixed(2)} (${idx.changePercent >= 0 ? '+' : ''}${idx.changePercent.toFixed(2)}%)`);
            }
        }
        if (fiiDii.fiiNet !== 0 || fiiDii.diiNet !== 0) {
            contextParts.push(`FII/DII Activity (${fiiDii.date}):`);
            contextParts.push(`  FII Net: ₹${(fiiDii.fiiNet / 100).toFixed(0)} Cr (Buy: ₹${(fiiDii.fiiBuy / 100).toFixed(0)} Cr, Sell: ₹${(fiiDii.fiiSell / 100).toFixed(0)} Cr)`);
            contextParts.push(`  DII Net: ₹${(fiiDii.diiNet / 100).toFixed(0)} Cr (Buy: ₹${(fiiDii.diiBuy / 100).toFixed(0)} Cr, Sell: ₹${(fiiDii.diiSell / 100).toFixed(0)} Cr)`);
        }
        if (sectorPerf.length > 0) {
            contextParts.push('Sector Performance:');
            for (const s of sectorPerf) {
                contextParts.push(`  ${s.sector}: ${s.changePercent >= 0 ? '+' : ''}${s.changePercent.toFixed(2)}%`);
            }
        }
        let aiSummary = '';
        let sentiment = 'NEUTRAL';
        let keyEvents = [];
        let stockFlows = { mfTopBuys: [], mfTopSells: [], fiiTopBuys: [], fiiTopSells: [] };
        try {
            const prompt = `You are a global market intelligence analyst for an Indian stock trading system.

Analyze the following market data and provide a comprehensive pre-market / intra-day intelligence briefing:

${contextParts.join('\n')}

Respond in JSON with this schema:
{
  "sentiment": "VERY_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "VERY_BEARISH",
  "summary": "2-3 paragraph analysis covering: (1) Global cues and their impact on Indian markets, (2) FII/DII flow analysis and what it signals, (3) Sector rotation trends and actionable sectors, (4) Key risk factors to watch",
  "keyEvents": ["list of 3-5 key market events/triggers to watch today"],
  "sectorRecommendations": {
    "bullishSectors": ["sectors with positive momentum"],
    "bearishSectors": ["sectors to avoid or short"],
    "watchSectors": ["sectors at inflection points"]
  },
  "tradingBias": "BUY" | "SELL" | "NEUTRAL",
  "confidence": 0.0 to 1.0,
  "stockCategories": {
    "largeCap": "brief outlook",
    "midCap": "brief outlook",
    "smallCap": "brief outlook"
  }
}`;
            const result = await chatCompletionJSON({
                messages: [
                    { role: 'system', content: 'You are a global market intelligence analyst for an Indian stock trading system. Respond ONLY with valid JSON.' },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.3,
                maxTokens: 2048,
            });
            if (result) {
                aiSummary = result.summary ?? '';
                sentiment = result.sentiment ?? 'NEUTRAL';
                keyEvents = result.keyEvents ?? [];
            }
        }
        catch (err) {
            console.error('[GlobalMarket] AI analysis failed:', err.message);
            aiSummary = this.generateRuleBasedSummary(giftNifty, globalIndices, fiiDii, sectorPerf);
            sentiment = this.computeRuleBasedSentiment(giftNifty, globalIndices, fiiDii);
        }
        const intelligence = {
            timestamp: new Date().toISOString(),
            giftNifty,
            globalIndices,
            fiiDii,
            sectorPerformance: sectorPerf,
            aiSummary,
            sentiment,
            keyEvents,
            stockFlows,
        };
        _latestIntelligence = intelligence;
        try {
            await this.storeIntelligence(intelligence);
        }
        catch (err) {
            console.error('[GlobalMarket] Failed to store intelligence:', err.message);
        }
        console.log(`[GlobalMarket] Intelligence scan complete in ${Date.now() - startTime}ms — Sentiment: ${sentiment}`);
        return intelligence;
    }
    getIntelligenceContextForBots() {
        const intel = _latestIntelligence;
        if (!intel)
            return '';
        const parts = ['\n=== GLOBAL MARKET INTELLIGENCE ==='];
        if (intel.giftNifty) {
            parts.push(`Gift Nifty: ${intel.giftNifty.value} (${intel.giftNifty.changePercent >= 0 ? '+' : ''}${intel.giftNifty.changePercent.toFixed(2)}%)`);
        }
        const usIndices = intel.globalIndices.filter(i => ['S&P 500', 'NASDAQ', 'DOW JONES'].some(n => i.name.toUpperCase().includes(n.toUpperCase())));
        if (usIndices.length > 0) {
            parts.push('US Markets: ' + usIndices.map(i => `${i.name} ${i.changePercent >= 0 ? '+' : ''}${i.changePercent.toFixed(2)}%`).join(', '));
        }
        if (intel.fiiDii.fiiNet !== 0) {
            parts.push(`FII Net: ₹${(intel.fiiDii.fiiNet / 100).toFixed(0)}Cr | DII Net: ₹${(intel.fiiDii.diiNet / 100).toFixed(0)}Cr`);
        }
        parts.push(`Overall Sentiment: ${intel.sentiment}`);
        if (intel.keyEvents.length > 0) {
            parts.push('Key Events: ' + intel.keyEvents.slice(0, 3).join('; '));
        }
        if (intel.sectorPerformance.length > 0) {
            const top3 = [...intel.sectorPerformance].sort((a, b) => b.changePercent - a.changePercent).slice(0, 3);
            const bottom3 = [...intel.sectorPerformance].sort((a, b) => a.changePercent - b.changePercent).slice(0, 3);
            parts.push('Top Sectors: ' + top3.map(s => `${s.sector} +${s.changePercent.toFixed(1)}%`).join(', '));
            parts.push('Weak Sectors: ' + bottom3.map(s => `${s.sector} ${s.changePercent.toFixed(1)}%`).join(', '));
        }
        return parts.join('\n');
    }
    async fetchGiftNifty() {
        try {
            const url = 'https://query1.finance.yahoo.com/v8/finance/chart/SGX_NIFTY.SI?interval=1d&range=1d';
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
            const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
            clearTimeout(timer);
            if (!res.ok) {
                // Try alternate ticker
                const alt = await this.fetchYahooChart('^SGXNIFTY');
                return alt;
            }
            const data = await res.json();
            const meta = data?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice) {
                const value = meta.regularMarketPrice;
                const prevClose = meta.chartPreviousClose ?? value;
                return {
                    value: Number(value.toFixed(2)),
                    change: Number((value - prevClose).toFixed(2)),
                    changePercent: Number((prevClose > 0 ? ((value - prevClose) / prevClose) * 100 : 0).toFixed(2)),
                };
            }
        }
        catch { /* Gift Nifty fetch failed */ }
        // Try Nifty futures as proxy
        try {
            const alt = await this.fetchYahooChart('^NSEI');
            return alt;
        }
        catch { /* fallback failed */ }
        return null;
    }
    async fetchYahooChart(ticker) {
        try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
            const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
            clearTimeout(timer);
            if (!res.ok)
                return null;
            const data = await res.json();
            const meta = data?.chart?.result?.[0]?.meta;
            if (!meta?.regularMarketPrice)
                return null;
            const value = meta.regularMarketPrice;
            const prevClose = meta.chartPreviousClose ?? value;
            return {
                value: Number(value.toFixed(2)),
                change: Number((value - prevClose).toFixed(2)),
                changePercent: Number((prevClose > 0 ? ((value - prevClose) / prevClose) * 100 : 0).toFixed(2)),
            };
        }
        catch {
            return null;
        }
    }
    async fetchGlobalIndices() {
        const tickers = [
            ['^GSPC', 'S&P 500'],
            ['^IXIC', 'NASDAQ'],
            ['^DJI', 'DOW JONES'],
            ['^FTSE', 'FTSE 100'],
            ['^GDAXI', 'DAX'],
            ['^N225', 'NIKKEI 225'],
            ['^HSI', 'HANG SENG'],
            ['000001.SS', 'SHANGHAI'],
            ['^STOXX50E', 'EURO STOXX 50'],
            ['^KS11', 'KOSPI'],
        ];
        const indices = [];
        const promises = tickers.map(async ([ticker, name]) => {
            const result = await this.fetchYahooChart(ticker);
            if (result) {
                indices.push({ name, ...result });
            }
        });
        await Promise.all(promises);
        return indices;
    }
    async fetchSectorPerformance() {
        const sectorIndices = [
            ['NIFTY IT.NS', 'IT'],
            ['NIFTY BANK.NS', 'Banking'],
            ['NIFTY PHARMA.NS', 'Pharma'],
            ['NIFTY AUTO.NS', 'Auto'],
            ['NIFTY FMCG.NS', 'FMCG'],
            ['NIFTY METAL.NS', 'Metal'],
            ['NIFTY REALTY.NS', 'Realty'],
            ['NIFTY ENERGY.NS', 'Energy'],
            ['NIFTY INFRA.NS', 'Infra'],
            ['NIFTY PSE.NS', 'PSE'],
            ['NIFTY FIN SERVICE.NS', 'Financial Services'],
            ['NIFTY MEDIA.NS', 'Media'],
        ];
        const sectors = [];
        // Try Yahoo Finance sector tickers
        const yahooTickers = [
            ['^CNXIT', 'IT'], ['^CNXPHARMA', 'Pharma'],
            ['^NSEBANK', 'Banking'], ['^CNXAUTO', 'Auto'],
            ['^CNXFMCG', 'FMCG'], ['^CNXMETAL', 'Metal'],
            ['^CNXREALTY', 'Realty'], ['^CNXENERGY', 'Energy'],
            ['^CNXINFRA', 'Infra'], ['^CNXPSE', 'PSE'],
        ];
        const promises = yahooTickers.map(async ([ticker, sector]) => {
            const result = await this.fetchYahooChart(ticker);
            if (result) {
                sectors.push({ sector, changePercent: result.changePercent });
            }
        });
        await Promise.all(promises);
        // If Yahoo failed, try NSE directly
        if (sectors.length < 3) {
            try {
                const res = await fetch('https://www.nseindia.com/api/allIndices', {
                    headers: {
                        'User-Agent': UA,
                        'Accept': 'application/json',
                    },
                });
                if (res.ok) {
                    const data = await res.json();
                    const sectorMap = {
                        'NIFTY IT': 'IT', 'NIFTY BANK': 'Banking', 'NIFTY PHARMA': 'Pharma',
                        'NIFTY AUTO': 'Auto', 'NIFTY FMCG': 'FMCG', 'NIFTY METAL': 'Metal',
                        'NIFTY REALTY': 'Realty', 'NIFTY ENERGY': 'Energy', 'NIFTY INFRA': 'Infra',
                        'NIFTY PSE': 'PSE', 'NIFTY FIN SERVICE': 'Financial Services',
                        'NIFTY MEDIA': 'Media', 'NIFTY MIDCAP 100': 'Midcap',
                        'NIFTY SMLCAP 100': 'Smallcap',
                    };
                    for (const idx of (data.data ?? [])) {
                        const mappedName = sectorMap[idx.index];
                        if (mappedName && !sectors.find(s => s.sector === mappedName)) {
                            sectors.push({ sector: mappedName, changePercent: idx.percentChange ?? 0 });
                        }
                    }
                }
            }
            catch { /* NSE fallback failed */ }
        }
        return sectors.sort((a, b) => b.changePercent - a.changePercent);
    }
    generateRuleBasedSummary(giftNifty, globalIndices, fiiDii, sectors) {
        const parts = [];
        if (giftNifty) {
            const bias = giftNifty.changePercent > 0.3 ? 'positive' : giftNifty.changePercent < -0.3 ? 'negative' : 'flat';
            parts.push(`Gift Nifty indicates a ${bias} opening (${giftNifty.changePercent >= 0 ? '+' : ''}${giftNifty.changePercent.toFixed(2)}%).`);
        }
        const us = globalIndices.filter(i => ['S&P 500', 'NASDAQ', 'DOW JONES'].some(n => i.name.includes(n)));
        if (us.length > 0) {
            const avgUs = us.reduce((s, i) => s + i.changePercent, 0) / us.length;
            parts.push(`US markets closed ${avgUs > 0 ? 'higher' : 'lower'} (avg ${avgUs >= 0 ? '+' : ''}${avgUs.toFixed(2)}%).`);
        }
        if (fiiDii.fiiNet !== 0) {
            const fiiDirection = fiiDii.fiiNet > 0 ? 'net buyers' : 'net sellers';
            parts.push(`FII were ${fiiDirection} (₹${Math.abs(fiiDii.fiiNet / 100).toFixed(0)} Cr).`);
        }
        if (sectors.length > 0) {
            const top = sectors.slice(0, 2).map(s => s.sector).join(', ');
            parts.push(`Strongest sectors: ${top}.`);
        }
        return parts.join(' ') || 'Market intelligence data collection in progress.';
    }
    computeRuleBasedSentiment(giftNifty, globalIndices, fiiDii) {
        let score = 0;
        if (giftNifty) {
            if (giftNifty.changePercent > 0.5)
                score += 2;
            else if (giftNifty.changePercent > 0.1)
                score += 1;
            else if (giftNifty.changePercent < -0.5)
                score -= 2;
            else if (giftNifty.changePercent < -0.1)
                score -= 1;
        }
        const us = globalIndices.filter(i => ['S&P 500', 'NASDAQ', 'DOW JONES'].some(n => i.name.includes(n)));
        if (us.length > 0) {
            const avgUs = us.reduce((s, i) => s + i.changePercent, 0) / us.length;
            if (avgUs > 0.5)
                score += 2;
            else if (avgUs > 0.1)
                score += 1;
            else if (avgUs < -0.5)
                score -= 2;
            else if (avgUs < -0.1)
                score -= 1;
        }
        if (fiiDii.fiiNet > 500)
            score += 2;
        else if (fiiDii.fiiNet > 0)
            score += 1;
        else if (fiiDii.fiiNet < -500)
            score -= 2;
        else if (fiiDii.fiiNet < 0)
            score -= 1;
        if (score >= 4)
            return 'VERY_BULLISH';
        if (score >= 2)
            return 'BULLISH';
        if (score <= -4)
            return 'VERY_BEARISH';
        if (score <= -2)
            return 'BEARISH';
        return 'NEUTRAL';
    }
    async storeIntelligence(intel) {
        const date = istDateStr();
        try {
            const prisma = getPrisma();
            await prisma.botMessage.create({
                data: {
                    fromBotId: 'global-market-intelligence',
                    userId: 'system',
                    messageType: 'intelligence_report',
                    content: JSON.stringify({
                        date,
                        sentiment: intel.sentiment,
                        giftNifty: intel.giftNifty,
                        globalIndices: intel.globalIndices.map(i => `${i.name}: ${i.changePercent}%`),
                        fiiNet: intel.fiiDii.fiiNet,
                        diiNet: intel.fiiDii.diiNet,
                        topSectors: intel.sectorPerformance.slice(0, 5).map(s => `${s.sector}: ${s.changePercent}%`),
                        keyEvents: intel.keyEvents,
                        summary: intel.aiSummary.slice(0, 500),
                    }),
                },
            });
        }
        catch (err) {
            console.log(`[GlobalMarket] ${date} — Sentiment: ${intel.sentiment} (DB store skipped: ${err.message})`);
        }
    }
}
//# sourceMappingURL=global-market.service.js.map