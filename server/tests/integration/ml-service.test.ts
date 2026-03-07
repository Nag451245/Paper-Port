import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  mlScore,
  mlTrain,
  mlDetectRegime,
  mlAllocate,
} from '../../src/lib/ml-service-client.js';

describe('ML Service Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('mlScore', () => {
    it('should return scores from the service', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          scores: [0.85, 0.42],
          labels: ['WIN', 'LOSS'],
          model_type: 'xgboost',
          feature_importance: { ema_vote: 0.15 },
        }),
      });

      const result = await mlScore({
        features: [
          { features: { ema_vote: 0.5, rsi_vote: 0.3 } },
          { features: { ema_vote: -0.2, rsi_vote: -0.5 } },
        ],
        model_type: 'xgboost',
      });

      expect(result.scores).toHaveLength(2);
      expect(result.labels[0]).toBe('WIN');
      expect(result.model_type).toBe('xgboost');
    });

    it('should throw on non-200 response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(mlScore({ features: [] })).rejects.toThrow('500');
    });
  });

  describe('mlTrain', () => {
    it('should return training results', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          accuracy: 0.72,
          auc_roc: 0.78,
          feature_importance: { momentum_vote: 0.25 },
          training_samples: 400,
          validation_samples: 100,
          model_type: 'xgboost',
        }),
      });

      const result = await mlTrain({
        training_data: [{ features: { ema_vote: 0.5 }, outcome: 1 }],
        model_type: 'xgboost',
      });

      expect(result.accuracy).toBeGreaterThan(0);
      expect(result.auc_roc).toBeGreaterThan(0);
      expect(result.training_samples).toBe(400);
    });
  });

  describe('mlDetectRegime', () => {
    it('should return regime detection results', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          current_regime: 'trending_up',
          regime_id: 0,
          regime_probabilities: { trending_up: 0.7, ranging: 0.2, volatile: 0.1 },
          transition_matrix: [[0.8, 0.1, 0.05, 0.05]],
          regime_labels: { 0: 'trending_up', 1: 'trending_down', 2: 'ranging', 3: 'volatile' },
        }),
      });

      const result = await mlDetectRegime({
        returns: [0.01, -0.005, 0.008],
        volatility: [0.015, 0.016, 0.014],
      });

      expect(result.current_regime).toBe('trending_up');
      expect(result.regime_probabilities).toBeDefined();
    });
  });

  describe('mlAllocate', () => {
    it('should return allocation results', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          allocations: { orb: 25.0, mean_reversion: 20.0, pairs: 15.0 },
          capital_per_strategy: { orb: 250000, mean_reversion: 200000, pairs: 150000 },
          method: 'thompson_bayesian_regime',
          exploration_rate: 0.35,
        }),
      });

      const result = await mlAllocate({
        strategy_stats: [
          { strategy_id: 'orb', wins: 30, losses: 10, sharpe: 1.5 },
          { strategy_id: 'mean_reversion', wins: 20, losses: 15, sharpe: 0.8 },
        ],
        total_capital: 1_000_000,
      });

      expect(result.allocations.orb).toBe(25.0);
      expect(result.method).toBe('thompson_bayesian_regime');
      expect(result.exploration_rate).toBeGreaterThan(0);
    });
  });
});
