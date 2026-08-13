import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/lib/rust-engine.js', () => ({
  isEngineAvailable: vi.fn().mockReturnValue(false),
  engineFeatureStore: vi.fn().mockResolvedValue({ features: { columns: [], data: [] } }),
  engineScan: vi.fn().mockResolvedValue({ signals: [] }),
}));

vi.mock('../../src/lib/ml-service-client.js', () => ({
  isMLServiceAvailable: vi.fn().mockResolvedValue(false),
  mlScore: vi.fn().mockResolvedValue({ scores: [], labels: [], model_type: 'xgboost', feature_importance: {} }),
}));

import { DataPipelineService } from '../../src/services/data-pipeline.service.js';

describe('DataPipelineService', () => {
  let pipeline: DataPipelineService;

  beforeEach(() => {
    pipeline = new DataPipelineService();
  });

  describe('initialize', () => {
    it('should return false when Redis is not available', async () => {
      const result = await pipeline.initialize();
      expect(result).toBe(false);
    });
  });

  describe('publishTick', () => {
    it('should not throw when Redis is unavailable', async () => {
      await expect(pipeline.publishTick('TCS', 2500, 10000, Date.now())).resolves.not.toThrow();
    });
  });

  describe('publishFeatures', () => {
    it('should not throw when Redis is unavailable', async () => {
      await expect(pipeline.publishFeatures('TCS', { ema_vote: 0.5 })).resolves.not.toThrow();
    });
  });

  describe('publishSignal', () => {
    it('should not throw when Redis is unavailable', async () => {
      await expect(pipeline.publishSignal({
        symbol: 'TCS',
        direction: 'BUY',
        confidence: 0.8,
        strategy: 'composite',
      })).resolves.not.toThrow();
    });
  });

  describe('getStats', () => {
    it('should return zero stats when Redis is unavailable', async () => {
      const stats = await pipeline.getStats();
      expect(stats.redisAvailable).toBe(false);
      expect(stats.tickStreamLen).toBe(0);
      expect(stats.featureStreamLen).toBe(0);
    });
  });

  describe('readStream', () => {
    it('should return empty array when Redis is unavailable', async () => {
      const entries = await pipeline.readStream('stream:ticks');
      expect(entries).toEqual([]);
    });
  });

  describe('scoreAndFilter', () => {
    it('should return empty array when ML service is unavailable', async () => {
      const signals = await pipeline.scoreAndFilter([
        { symbol: 'TCS', featureMap: { ema_vote: 0.5, rsi_vote: 0.3 } },
      ]);
      expect(signals).toEqual([]);
    });
  });

  describe('processTickBatch', () => {
    it('should handle empty batch gracefully', async () => {
      await expect(pipeline.processTickBatch([])).resolves.not.toThrow();
    });
  });
});
