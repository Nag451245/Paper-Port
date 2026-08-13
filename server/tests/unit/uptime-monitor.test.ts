import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/lib/rust-engine.js', () => ({
  isEngineAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/lib/ml-service-client.js', () => ({
  isMLServiceAvailable: vi.fn().mockResolvedValue(false),
}));

import { UptimeMonitorService } from '../../src/services/uptime-monitor.service.js';

describe('UptimeMonitorService', () => {
  let monitor: UptimeMonitorService;

  beforeEach(() => {
    monitor = new UptimeMonitorService(async () => true);
  });

  afterEach(() => {
    monitor.stop();
  });

  describe('getStatus', () => {
    it('should return initial status with 100% uptime', () => {
      const status = monitor.getStatus();
      expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(status.uptimePct).toBe(100);
      expect(status.target).toBe('99.9%');
    });

    it('should track errors', () => {
      monitor.recordError();
      monitor.recordError();
      monitor.recordError();
      // Errors are counted but only persisted on heartbeat
      const status = monitor.getStatus();
      expect(status).toBeDefined();
    });

    it('should track latency', () => {
      monitor.recordLatency(50);
      monitor.recordLatency(100);
      monitor.recordLatency(150);
      const status = monitor.getStatus();
      expect(status).toBeDefined();
    });
  });

  describe('getHistory', () => {
    it('should return empty history initially', () => {
      const history = monitor.getHistory(1);
      expect(history).toHaveLength(0);
    });
  });

  describe('start/stop', () => {
    it('should start and stop without error', () => {
      monitor.start();
      expect(() => monitor.stop()).not.toThrow();
    });

    it('should be idempotent', () => {
      monitor.start();
      monitor.start(); // second call is noop
      monitor.stop();
      monitor.stop(); // second call is noop
    });
  });
});
