import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'fs';
import { resolve, join, relative } from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LEARNING_DIR = resolve(__dirname, '..', '..', '..', 'learning');
const MAX_SIZE_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB
const PRUNE_KEEP_DAYS = 90;
function ensureDir(dir) {
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
function dateStr(date) {
    return date.toISOString().split('T')[0];
}
export class LearningStoreService {
    constructor() {
        ensureDir(LEARNING_DIR);
        ensureDir(join(LEARNING_DIR, 'daily-reports'));
        ensureDir(join(LEARNING_DIR, 'trade-reviews'));
        ensureDir(join(LEARNING_DIR, 'false-positives'));
        ensureDir(join(LEARNING_DIR, 'strategy-evolution'));
        ensureDir(join(LEARNING_DIR, 'regime-log'));
    }
    async writeDailyReport(date, data) {
        const filePath = join(LEARNING_DIR, 'daily-reports', `${dateStr(date)}.json`);
        writeFileSync(filePath, JSON.stringify(data, null, 2));
        this.checkAndPrune();
    }
    async writeTradeReview(date, tradeId, data) {
        const dir = join(LEARNING_DIR, 'trade-reviews', dateStr(date));
        ensureDir(dir);
        writeFileSync(join(dir, `${tradeId}.json`), JSON.stringify(data, null, 2));
    }
    async writeFalsePositives(date, data) {
        const filePath = join(LEARNING_DIR, 'false-positives', `${dateStr(date)}.json`);
        writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
    async writeStrategyEvolution(strategyId, data) {
        const filePath = join(LEARNING_DIR, 'strategy-evolution', `${strategyId}.json`);
        let history = [];
        if (existsSync(filePath)) {
            try {
                history = JSON.parse(readFileSync(filePath, 'utf-8'));
            }
            catch {
                history = [];
            }
        }
        history.push({ timestamp: new Date().toISOString(), ...data });
        // Keep last 365 entries
        if (history.length > 365)
            history = history.slice(-365);
        writeFileSync(filePath, JSON.stringify(history, null, 2));
    }
    async writeRegimeLog(date, regime, data) {
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const filePath = join(LEARNING_DIR, 'regime-log', `${monthKey}.json`);
        let log = [];
        if (existsSync(filePath)) {
            try {
                log = JSON.parse(readFileSync(filePath, 'utf-8'));
            }
            catch {
                log = [];
            }
        }
        log.push({ date: dateStr(date), regime, ...data });
        writeFileSync(filePath, JSON.stringify(log, null, 2));
    }
    async readDailyReport(date) {
        const filePath = join(LEARNING_DIR, 'daily-reports', `${dateStr(date)}.json`);
        if (!existsSync(filePath))
            return null;
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    }
    readRecentFalsePositives(days = 30) {
        const fpDir = join(LEARNING_DIR, 'false-positives');
        if (!existsSync(fpDir))
            return [];
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffStr = dateStr(cutoff);
        const results = [];
        for (const file of readdirSync(fpDir).filter(f => f.endsWith('.json'))) {
            const name = file.replace('.json', '');
            if (name < cutoffStr)
                continue;
            try {
                const data = JSON.parse(readFileSync(join(fpDir, file), 'utf-8'));
                if (data?.signals) {
                    results.push({ date: name, signals: data.signals });
                }
            }
            catch { /* skip corrupted files */ }
        }
        return results;
    }
    getTotalSize() {
        return this.dirSize(LEARNING_DIR);
    }
    getMetaSummary() {
        const totalSize = this.getTotalSize();
        const reportDir = join(LEARNING_DIR, 'daily-reports');
        let fileCount = 0;
        let oldestDate = null;
        if (existsSync(reportDir)) {
            const files = readdirSync(reportDir).filter(f => f.endsWith('.json')).sort();
            fileCount = files.length;
            if (files.length > 0)
                oldestDate = files[0].replace('.json', '');
        }
        return {
            totalSizeMB: Math.round(totalSize / (1024 * 1024)),
            fileCount,
            oldestDate,
        };
    }
    async exportAll(userId, prisma) {
        const files = {};
        this.collectFiles(LEARNING_DIR, LEARNING_DIR, files);
        const [tradeJournals, learningInsights, eodReports, dailyPnlRecords, decisionAudits] = await Promise.all([
            prisma.tradeJournal.findMany({ where: { userId } }),
            prisma.learningInsight.findMany({ where: { userId } }),
            prisma.eODReport.findMany({ where: { userId } }),
            prisma.dailyPnlRecord.findMany({ where: { userId } }),
            prisma.decisionAudit.findMany({ where: { userId } }),
        ]);
        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            files,
            db: { tradeJournals, learningInsights, eodReports, dailyPnlRecords, decisionAudits },
        };
        return gzipSync(JSON.stringify(payload), { level: 9 });
    }
    async importAll(userId, prisma, gzBuffer) {
        const raw = gunzipSync(gzBuffer).toString('utf-8');
        const payload = JSON.parse(raw);
        if (payload.version !== 1)
            throw new Error('Unsupported export version');
        let filesRestored = 0;
        if (payload.files) {
            for (const [relPath, content] of Object.entries(payload.files)) {
                const fullPath = join(LEARNING_DIR, relPath);
                ensureDir(dirname(fullPath));
                writeFileSync(fullPath, JSON.stringify(content));
                filesRestored++;
            }
        }
        let dbRecords = 0;
        const db = payload.db ?? {};
        if (db.tradeJournals?.length) {
            for (const j of db.tradeJournals) {
                try {
                    await prisma.tradeJournal.upsert({
                        where: { tradeId: j.tradeId },
                        create: { ...j, userId },
                        update: { aiBriefing: j.aiBriefing, signalQualityReview: j.signalQualityReview, marketContext: j.marketContext, exitAnalysis: j.exitAnalysis, improvementSuggestion: j.improvementSuggestion },
                    });
                    dbRecords++;
                }
                catch { /* skip if trade FK missing */ }
            }
        }
        if (db.learningInsights?.length) {
            for (const i of db.learningInsights) {
                await prisma.learningInsight.upsert({
                    where: { userId_date: { userId, date: new Date(i.date) } },
                    create: { userId, date: new Date(i.date), marketRegime: i.marketRegime, topWinningStrategies: i.topWinningStrategies, topLosingStrategies: i.topLosingStrategies, paramAdjustments: i.paramAdjustments, narrative: i.narrative },
                    update: { marketRegime: i.marketRegime, topWinningStrategies: i.topWinningStrategies, topLosingStrategies: i.topLosingStrategies, paramAdjustments: i.paramAdjustments, narrative: i.narrative },
                });
                dbRecords++;
            }
        }
        if (db.eodReports?.length) {
            for (const r of db.eodReports) {
                await prisma.eODReport.upsert({
                    where: { userId_date: { userId, date: new Date(r.date) } },
                    create: { userId, date: new Date(r.date), totalPnl: r.totalPnl, targetPnl: r.targetPnl, targetAchieved: r.targetAchieved, tradesSummary: r.tradesSummary, falsePositives: r.falsePositives, decisionsReview: r.decisionsReview, improvements: r.improvements, marketContext: r.marketContext, riskEvents: r.riskEvents },
                    update: { totalPnl: r.totalPnl, targetPnl: r.targetPnl, targetAchieved: r.targetAchieved, tradesSummary: r.tradesSummary, falsePositives: r.falsePositives, decisionsReview: r.decisionsReview, improvements: r.improvements, marketContext: r.marketContext, riskEvents: r.riskEvents },
                });
                dbRecords++;
            }
        }
        if (db.dailyPnlRecords?.length) {
            for (const d of db.dailyPnlRecords) {
                await prisma.dailyPnlRecord.upsert({
                    where: { userId_date: { userId, date: new Date(d.date) } },
                    create: { userId, date: new Date(d.date), grossPnl: d.grossPnl, netPnl: d.netPnl, tradeCount: d.tradeCount, winCount: d.winCount, lossCount: d.lossCount, status: d.status },
                    update: { grossPnl: d.grossPnl, netPnl: d.netPnl, tradeCount: d.tradeCount, winCount: d.winCount, lossCount: d.lossCount, status: d.status },
                });
                dbRecords++;
            }
        }
        if (db.decisionAudits?.length) {
            for (const a of db.decisionAudits) {
                try {
                    await prisma.decisionAudit.create({
                        data: { userId, symbol: a.symbol, decisionType: a.decisionType, direction: a.direction, confidence: a.confidence, signalSource: a.signalSource, marketDataSnapshot: a.marketDataSnapshot, riskChecks: a.riskChecks, reasoning: a.reasoning, outcome: a.outcome, entryPrice: a.entryPrice, exitPrice: a.exitPrice, pnl: a.pnl, predictionAccuracy: a.predictionAccuracy },
                    });
                    dbRecords++;
                }
                catch { /* skip duplicates */ }
            }
        }
        return { filesRestored, dbRecords };
    }
    collectFiles(baseDir, currentDir, result) {
        if (!existsSync(currentDir))
            return;
        for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = join(currentDir, entry.name);
            if (entry.isDirectory()) {
                this.collectFiles(baseDir, fullPath, result);
            }
            else if (entry.name.endsWith('.json')) {
                const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');
                try {
                    result[relPath] = JSON.parse(readFileSync(fullPath, 'utf-8'));
                }
                catch { /* skip corrupted */ }
            }
        }
    }
    checkAndPrune() {
        const totalSize = this.getTotalSize();
        if (totalSize < MAX_SIZE_BYTES * 0.9)
            return; // Under 90% threshold
        console.log(`[LearningStore] Size ${(totalSize / 1024 / 1024).toFixed(0)}MB approaching ${MAX_SIZE_BYTES / 1024 / 1024}MB limit, pruning...`);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - PRUNE_KEEP_DAYS);
        const cutoffStr = dateStr(cutoffDate);
        // Prune daily reports older than 90 days
        this.pruneDirectory(join(LEARNING_DIR, 'daily-reports'), cutoffStr);
        // Prune false positives older than 90 days
        this.pruneDirectory(join(LEARNING_DIR, 'false-positives'), cutoffStr);
        // Prune trade review directories older than 30 days
        const tradeReviewDir = join(LEARNING_DIR, 'trade-reviews');
        if (existsSync(tradeReviewDir)) {
            const cutoff30 = new Date();
            cutoff30.setDate(cutoff30.getDate() - 30);
            const cutoff30Str = dateStr(cutoff30);
            for (const dir of readdirSync(tradeReviewDir)) {
                if (dir < cutoff30Str) {
                    try {
                        rmSync(join(tradeReviewDir, dir), { recursive: true, force: true });
                    }
                    catch { /* skip */ }
                }
            }
        }
        const newSize = this.getTotalSize();
        console.log(`[LearningStore] Pruned to ${(newSize / 1024 / 1024).toFixed(0)}MB`);
    }
    pruneDirectory(dir, cutoffStr) {
        if (!existsSync(dir))
            return;
        for (const file of readdirSync(dir)) {
            const name = file.replace('.json', '');
            if (name < cutoffStr) {
                try {
                    unlinkSync(join(dir, file));
                }
                catch { /* skip */ }
            }
        }
    }
    dirSize(dirPath) {
        if (!existsSync(dirPath))
            return 0;
        let total = 0;
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
            const fullPath = join(dirPath, entry.name);
            if (entry.isDirectory()) {
                total += this.dirSize(fullPath);
            }
            else {
                try {
                    total += statSync(fullPath).size;
                }
                catch { /* skip */ }
            }
        }
        return total;
    }
}
//# sourceMappingURL=learning-store.service.js.map