import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_LEARNING_DIR = resolve(__dirname, '..', '..', '..', 'learning');

function createMockPrisma() {
  return {
    tradeJournal: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    learningInsight: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    eODReport: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    dailyPnlRecord: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    decisionAudit: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('LearningStoreService – export/import', () => {
  let store: any;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();
    const { LearningStoreService } = await import('../../src/services/learning-store.service.js');
    store = new LearningStoreService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('exportAll', () => {
    it('should produce a valid gzip buffer that decompresses to JSON with correct structure', async () => {
      const buffer = await store.exportAll('user-1', mockPrisma);

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);

      const decompressed = gunzipSync(buffer).toString('utf-8');
      const payload = JSON.parse(decompressed);

      expect(payload.version).toBe(1);
      expect(payload.exportedAt).toBeDefined();
      expect(typeof payload.files).toBe('object');
      expect(payload.db).toBeDefined();
      expect(payload.db.tradeJournals).toEqual([]);
      expect(payload.db.learningInsights).toEqual([]);
      expect(payload.db.eodReports).toEqual([]);
      expect(payload.db.dailyPnlRecords).toEqual([]);
      expect(payload.db.decisionAudits).toEqual([]);
    });

    it('should include file-based learning data in export', async () => {
      const reportDir = join(TEST_LEARNING_DIR, 'daily-reports');
      writeFileSync(join(reportDir, '2026-03-10.json'), JSON.stringify({ pnl: 500, trades: 3 }));

      const buffer = await store.exportAll('user-1', mockPrisma);
      const payload = JSON.parse(gunzipSync(buffer).toString('utf-8'));

      expect(payload.files['daily-reports/2026-03-10.json']).toBeDefined();
      expect(payload.files['daily-reports/2026-03-10.json'].pnl).toBe(500);
    });

    it('should include nested trade-review directories', async () => {
      const reviewDir = join(TEST_LEARNING_DIR, 'trade-reviews', '2026-03-10');
      mkdirSync(reviewDir, { recursive: true });
      writeFileSync(join(reviewDir, 'trade-abc.json'), JSON.stringify({ rating: 'good' }));

      const buffer = await store.exportAll('user-1', mockPrisma);
      const payload = JSON.parse(gunzipSync(buffer).toString('utf-8'));

      expect(payload.files['trade-reviews/2026-03-10/trade-abc.json']).toBeDefined();
      expect(payload.files['trade-reviews/2026-03-10/trade-abc.json'].rating).toBe('good');
    });

    it('should include DB records in export', async () => {
      const mockJournals = [
        { tradeId: 't1', aiBriefing: 'bullish setup', signalQualityReview: 'high' },
        { tradeId: 't2', aiBriefing: 'bearish reversal', signalQualityReview: 'medium' },
      ];
      const mockInsights = [
        { date: new Date('2026-03-10'), marketRegime: 'bullish', narrative: 'strong day' },
      ];
      mockPrisma.tradeJournal.findMany.mockResolvedValue(mockJournals);
      mockPrisma.learningInsight.findMany.mockResolvedValue(mockInsights);

      const buffer = await store.exportAll('user-1', mockPrisma);
      const payload = JSON.parse(gunzipSync(buffer).toString('utf-8'));

      expect(payload.db.tradeJournals).toHaveLength(2);
      expect(payload.db.tradeJournals[0].tradeId).toBe('t1');
      expect(payload.db.learningInsights).toHaveLength(1);
    });

    it('should query DB with the correct userId', async () => {
      await store.exportAll('user-42', mockPrisma);

      expect(mockPrisma.tradeJournal.findMany).toHaveBeenCalledWith({ where: { userId: 'user-42' } });
      expect(mockPrisma.learningInsight.findMany).toHaveBeenCalledWith({ where: { userId: 'user-42' } });
      expect(mockPrisma.eODReport.findMany).toHaveBeenCalledWith({ where: { userId: 'user-42' } });
      expect(mockPrisma.dailyPnlRecord.findMany).toHaveBeenCalledWith({ where: { userId: 'user-42' } });
      expect(mockPrisma.decisionAudit.findMany).toHaveBeenCalledWith({ where: { userId: 'user-42' } });
    });

    it('should produce compact output (no pretty-printing)', async () => {
      const reportDir = join(TEST_LEARNING_DIR, 'daily-reports');
      writeFileSync(join(reportDir, '2026-03-11.json'), JSON.stringify({ key: 'value', nested: { a: 1, b: 2 } }, null, 2));

      const buffer = await store.exportAll('user-1', mockPrisma);
      const raw = gunzipSync(buffer).toString('utf-8');

      expect(raw).not.toContain('  ');
    });

    it('should skip corrupted JSON files gracefully', async () => {
      const fpDir = join(TEST_LEARNING_DIR, 'false-positives');
      writeFileSync(join(fpDir, '2026-03-10.json'), '{invalid json!!!');

      const buffer = await store.exportAll('user-1', mockPrisma);
      const payload = JSON.parse(gunzipSync(buffer).toString('utf-8'));

      expect(payload.files['false-positives/2026-03-10.json']).toBeUndefined();
    });

    it('should handle empty learning directory', async () => {
      const buffer = await store.exportAll('user-1', mockPrisma);
      const payload = JSON.parse(gunzipSync(buffer).toString('utf-8'));

      expect(payload.version).toBe(1);
      expect(typeof payload.files).toBe('object');
    });
  });

  describe('importAll', () => {
    it('should restore files from export and return correct counts', async () => {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {
          'daily-reports/2026-03-10.json': { pnl: 500, trades: 3 },
          'false-positives/2026-03-10.json': { signals: [] },
        },
        db: {},
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.filesRestored).toBe(2);
      expect(result.dbRecords).toBe(0);

      const restored = join(TEST_LEARNING_DIR, 'daily-reports', '2026-03-10.json');
      expect(existsSync(restored)).toBe(true);
    });

    it('should upsert learning insights correctly', async () => {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {},
        db: {
          learningInsights: [
            { date: '2026-03-10', marketRegime: 'bullish', topWinningStrategies: '[]', topLosingStrategies: '[]', paramAdjustments: '{}', narrative: 'good day' },
          ],
        },
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.dbRecords).toBe(1);
      expect(mockPrisma.learningInsight.upsert).toHaveBeenCalledTimes(1);
      const call = mockPrisma.learningInsight.upsert.mock.calls[0][0];
      expect(call.where.userId_date.userId).toBe('user-1');
    });

    it('should upsert trade journals correctly', async () => {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {},
        db: {
          tradeJournals: [
            { tradeId: 't1', aiBriefing: 'bullish', signalQualityReview: 'high', marketContext: 'up', exitAnalysis: 'good', improvementSuggestion: 'none' },
          ],
        },
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.dbRecords).toBe(1);
      expect(mockPrisma.tradeJournal.upsert).toHaveBeenCalledTimes(1);
    });

    it('should upsert EOD reports correctly', async () => {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {},
        db: {
          eodReports: [
            { date: '2026-03-10', totalPnl: 5000, targetPnl: 10000, targetAchieved: false, tradesSummary: '[]', falsePositives: '[]', decisionsReview: '{}', improvements: '{}', marketContext: '{}', riskEvents: '[]' },
          ],
        },
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.dbRecords).toBe(1);
      expect(mockPrisma.eODReport.upsert).toHaveBeenCalledTimes(1);
    });

    it('should upsert daily PnL records correctly', async () => {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {},
        db: {
          dailyPnlRecords: [
            { date: '2026-03-10', grossPnl: 6000, netPnl: 5500, tradeCount: 10, winCount: 7, lossCount: 3, status: 'COMPLETED' },
          ],
        },
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.dbRecords).toBe(1);
      expect(mockPrisma.dailyPnlRecord.upsert).toHaveBeenCalledTimes(1);
    });

    it('should create decision audit records', async () => {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {},
        db: {
          decisionAudits: [
            { symbol: 'TCS', decisionType: 'BUY', direction: 'LONG', confidence: 0.85, signalSource: 'AI', marketDataSnapshot: '{}', riskChecks: '{}', reasoning: 'strong trend', outcome: 'WIN', entryPrice: 3500, exitPrice: 3600, pnl: 100, predictionAccuracy: 0.9 },
          ],
        },
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.dbRecords).toBe(1);
      expect(mockPrisma.decisionAudit.create).toHaveBeenCalledTimes(1);
    });

    it('should reject unsupported export version', async () => {
      const payload = { version: 99, exportedAt: new Date().toISOString(), files: {}, db: {} };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      await expect(store.importAll('user-1', mockPrisma, gzBuffer)).rejects.toThrow('Unsupported export version');
    });

    it('should reject invalid gzip data', async () => {
      const garbage = Buffer.from('not gzip data at all');

      await expect(store.importAll('user-1', mockPrisma, garbage)).rejects.toThrow();
    });

    it('should reject invalid JSON inside valid gzip', async () => {
      const gzBuffer = gzipSync(Buffer.from('{broken json!!!'));

      await expect(store.importAll('user-1', mockPrisma, gzBuffer)).rejects.toThrow();
    });

    it('should handle empty db section gracefully', async () => {
      const payload = { version: 1, exportedAt: new Date().toISOString(), files: {}, db: {} };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.filesRestored).toBe(0);
      expect(result.dbRecords).toBe(0);
    });

    it('should handle missing db section gracefully', async () => {
      const payload = { version: 1, exportedAt: new Date().toISOString(), files: {} };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.filesRestored).toBe(0);
      expect(result.dbRecords).toBe(0);
    });

    it('should handle empty files section gracefully', async () => {
      const payload = { version: 1, exportedAt: new Date().toISOString(), files: {}, db: {} };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.filesRestored).toBe(0);
    });

    it('should skip trade journals when FK constraint fails', async () => {
      mockPrisma.tradeJournal.upsert.mockRejectedValue(new Error('FK constraint'));

      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {},
        db: {
          tradeJournals: [
            { tradeId: 'missing-trade', aiBriefing: 'x', signalQualityReview: 'x', marketContext: 'x', exitAnalysis: 'x', improvementSuggestion: 'x' },
          ],
        },
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.dbRecords).toBe(0);
    });

    it('should skip decision audits when duplicate constraint fails', async () => {
      mockPrisma.decisionAudit.create.mockRejectedValue(new Error('Unique constraint'));

      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {},
        db: {
          decisionAudits: [
            { symbol: 'TCS', decisionType: 'BUY', direction: 'LONG', confidence: 0.8, signalSource: 'AI', marketDataSnapshot: '{}', riskChecks: '{}', reasoning: 'test', outcome: null, entryPrice: null, exitPrice: null, pnl: null, predictionAccuracy: null },
          ],
        },
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.dbRecords).toBe(0);
    });

    it('should create nested directories for trade reviews on import', async () => {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {
          'trade-reviews/2026-03-12/trade-xyz.json': { verdict: 'profitable' },
        },
        db: {},
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.filesRestored).toBe(1);
      const restored = join(TEST_LEARNING_DIR, 'trade-reviews', '2026-03-12', 'trade-xyz.json');
      expect(existsSync(restored)).toBe(true);
    });
  });

  describe('round-trip export → import', () => {
    it('should perfectly round-trip file-based data', async () => {
      const reportDir = join(TEST_LEARNING_DIR, 'daily-reports');
      const testData = { pnl: 1234.56, trades: 5, notes: 'test round-trip' };
      writeFileSync(join(reportDir, '2026-03-13.json'), JSON.stringify(testData));

      const exported = await store.exportAll('user-1', mockPrisma);

      rmSync(join(reportDir, '2026-03-13.json'), { force: true });
      expect(existsSync(join(reportDir, '2026-03-13.json'))).toBe(false);

      await store.importAll('user-1', mockPrisma, exported);

      expect(existsSync(join(reportDir, '2026-03-13.json'))).toBe(true);
    });

    it('should round-trip DB records through export → import', async () => {
      const mockInsights = [
        { date: new Date('2026-03-10'), marketRegime: 'bearish', topWinningStrategies: '["momentum"]', topLosingStrategies: '["mean-revert"]', paramAdjustments: '{}', narrative: 'volatile day' },
      ];
      mockPrisma.learningInsight.findMany.mockResolvedValue(mockInsights);

      const exported = await store.exportAll('user-1', mockPrisma);

      mockPrisma.learningInsight.findMany.mockResolvedValue([]);

      await store.importAll('user-1', mockPrisma, exported);

      expect(mockPrisma.learningInsight.upsert).toHaveBeenCalledTimes(1);
      const upsertCall = mockPrisma.learningInsight.upsert.mock.calls[0][0];
      expect(upsertCall.create.marketRegime).toBe('bearish');
    });

    it('should handle large payloads with significant compression', async () => {
      const largeData: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        largeData[`field_${i}`] = 'x'.repeat(500);
      }
      const reportDir = join(TEST_LEARNING_DIR, 'daily-reports');
      writeFileSync(join(reportDir, '2026-03-14.json'), JSON.stringify(largeData));

      const exported = await store.exportAll('user-1', mockPrisma);
      const uncompressedSize = gunzipSync(exported).length;

      expect(exported.length).toBeLessThan(uncompressedSize * 0.5);
    });

    it('should handle multiple DB record types in a single round-trip', async () => {
      mockPrisma.tradeJournal.findMany.mockResolvedValue([
        { tradeId: 't1', aiBriefing: 'a', signalQualityReview: 'b', marketContext: 'c', exitAnalysis: 'd', improvementSuggestion: 'e' },
      ]);
      mockPrisma.eODReport.findMany.mockResolvedValue([
        { date: new Date('2026-03-10'), totalPnl: 1000, targetPnl: 2000, targetAchieved: false, tradesSummary: '[]', falsePositives: '[]', decisionsReview: '{}', improvements: '{}', marketContext: '{}', riskEvents: '[]' },
      ]);
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue([
        { date: new Date('2026-03-10'), grossPnl: 1200, netPnl: 1000, tradeCount: 5, winCount: 3, lossCount: 2, status: 'COMPLETED' },
      ]);
      mockPrisma.decisionAudit.findMany.mockResolvedValue([
        { symbol: 'INFY', decisionType: 'SELL', direction: 'SHORT', confidence: 0.9, signalSource: 'Rust', marketDataSnapshot: '{}', riskChecks: '{}', reasoning: 'breakdown', outcome: 'WIN', entryPrice: 1500, exitPrice: 1450, pnl: 50, predictionAccuracy: 0.95 },
      ]);

      const exported = await store.exportAll('user-1', mockPrisma);
      const result = await store.importAll('user-1', mockPrisma, exported);

      expect(result.dbRecords).toBe(4);
      expect(mockPrisma.tradeJournal.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.eODReport.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dailyPnlRecord.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.decisionAudit.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    it('should handle unicode content in files and DB records', async () => {
      const reportDir = join(TEST_LEARNING_DIR, 'daily-reports');
      writeFileSync(join(reportDir, '2026-03-15.json'), JSON.stringify({ notes: 'मार्केट बुलिश था 📈' }));

      const exported = await store.exportAll('user-1', mockPrisma);
      const payload = JSON.parse(gunzipSync(exported).toString('utf-8'));

      expect(payload.files['daily-reports/2026-03-15.json'].notes).toBe('मार्केट बुलिश था 📈');
    });

    it('should handle special characters in file paths', async () => {
      const stratDir = join(TEST_LEARNING_DIR, 'strategy-evolution');
      writeFileSync(join(stratDir, 'ema-crossover-v2.json'), JSON.stringify([{ version: 2 }]));

      const exported = await store.exportAll('user-1', mockPrisma);
      const payload = JSON.parse(gunzipSync(exported).toString('utf-8'));

      expect(payload.files['strategy-evolution/ema-crossover-v2.json']).toBeDefined();
    });

    it('should handle zero-byte buffer import gracefully', async () => {
      await expect(store.importAll('user-1', mockPrisma, Buffer.alloc(0))).rejects.toThrow();
    });

    it('should export with empty DB and no files as valid minimal payload', async () => {
      const exported = await store.exportAll('user-1', mockPrisma);
      const payload = JSON.parse(gunzipSync(exported).toString('utf-8'));

      expect(payload.version).toBe(1);
      expect(Object.keys(payload.db)).toHaveLength(5);
    });

    it('should not leak data between users (userId isolation)', async () => {
      await store.exportAll('user-A', mockPrisma);

      for (const model of ['tradeJournal', 'learningInsight', 'eODReport', 'dailyPnlRecord', 'decisionAudit'] as const) {
        expect(mockPrisma[model].findMany).toHaveBeenCalledWith({ where: { userId: 'user-A' } });
      }
    });

    it('should handle import with null/undefined optional fields in DB records', async () => {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        files: {},
        db: {
          tradeJournals: [
            { tradeId: 't-null', aiBriefing: null, signalQualityReview: null, marketContext: null, exitAnalysis: null, improvementSuggestion: null },
          ],
          decisionAudits: [
            { symbol: 'TCS', decisionType: 'BUY', direction: null, confidence: 0.5, signalSource: 'manual', marketDataSnapshot: '{}', riskChecks: '{}', reasoning: 'test', outcome: null, entryPrice: null, exitPrice: null, pnl: null, predictionAccuracy: null },
          ],
        },
      };
      const gzBuffer = gzipSync(JSON.stringify(payload));

      const result = await store.importAll('user-1', mockPrisma, gzBuffer);

      expect(result.dbRecords).toBe(2);
    });

    it('should handle many records efficiently', async () => {
      const manyInsights = Array.from({ length: 365 }, (_, i) => ({
        date: new Date(2025, 0, i + 1),
        marketRegime: i % 2 === 0 ? 'bullish' : 'bearish',
        topWinningStrategies: '[]',
        topLosingStrategies: '[]',
        paramAdjustments: '{}',
        narrative: `Day ${i + 1} narrative`,
      }));
      mockPrisma.learningInsight.findMany.mockResolvedValue(manyInsights);

      const start = Date.now();
      const exported = await store.exportAll('user-1', mockPrisma);
      const exportTime = Date.now() - start;

      expect(exportTime).toBeLessThan(5000);

      const payload = JSON.parse(gunzipSync(exported).toString('utf-8'));
      expect(payload.db.learningInsights).toHaveLength(365);

      const importStart = Date.now();
      await store.importAll('user-1', mockPrisma, exported);
      const importTime = Date.now() - importStart;

      expect(importTime).toBeLessThan(5000);
      expect(mockPrisma.learningInsight.upsert).toHaveBeenCalledTimes(365);
    });
  });
});
