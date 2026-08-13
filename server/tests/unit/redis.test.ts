import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheService } from '../../src/lib/redis.js';

function createMockRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    exists: vi.fn(),
    ttl: vi.fn(),
    quit: vi.fn(),
  } as any;
}

describe('CacheService', () => {
  let cache: CacheService;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    cache = new CacheService(mockRedis);
    vi.clearAllMocks();
  });

  describe('get', () => {
    it('should return parsed JSON for valid JSON strings', async () => {
      mockRedis.get.mockResolvedValue('{"name":"test","value":42}');

      const result = await cache.get<{ name: string; value: number }>('test-key');

      expect(result).toEqual({ name: 'test', value: 42 });
      expect(mockRedis.get).toHaveBeenCalledWith('test-key');
    });

    it('should return null when key does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await cache.get('nonexistent');

      expect(result).toBeNull();
    });

    it('should return raw string when value is not valid JSON', async () => {
      mockRedis.get.mockResolvedValue('plain-string-value');

      const result = await cache.get<string>('str-key');

      expect(result).toBe('plain-string-value');
    });

    it('should handle JSON arrays', async () => {
      mockRedis.get.mockResolvedValue('[1,2,3]');

      const result = await cache.get<number[]>('arr-key');

      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('set', () => {
    it('should set a JSON value without TTL', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await cache.set('key', { hello: 'world' });

      expect(mockRedis.set).toHaveBeenCalledWith('key', '{"hello":"world"}');
    });

    it('should set a JSON value with TTL', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await cache.set('key', { hello: 'world' }, 3600);

      expect(mockRedis.set).toHaveBeenCalledWith('key', '{"hello":"world"}', 'EX', 3600);
    });

    it('should set a plain string without double-serializing', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await cache.set('key', 'plain-value');

      expect(mockRedis.set).toHaveBeenCalledWith('key', 'plain-value');
    });

    it('should set numeric values as JSON', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await cache.set('key', 42, 60);

      expect(mockRedis.set).toHaveBeenCalledWith('key', '42', 'EX', 60);
    });
  });

  describe('del', () => {
    it('should delete a key', async () => {
      mockRedis.del.mockResolvedValue(1);

      await cache.del('key');

      expect(mockRedis.del).toHaveBeenCalledWith('key');
    });
  });

  describe('exists', () => {
    it('should return true when key exists', async () => {
      mockRedis.exists.mockResolvedValue(1);

      const result = await cache.exists('key');

      expect(result).toBe(true);
    });

    it('should return false when key does not exist', async () => {
      mockRedis.exists.mockResolvedValue(0);

      const result = await cache.exists('key');

      expect(result).toBe(false);
    });
  });

  describe('ttl', () => {
    it('should return TTL in seconds', async () => {
      mockRedis.ttl.mockResolvedValue(3500);

      const result = await cache.ttl('key');

      expect(result).toBe(3500);
    });

    it('should return -2 when key does not exist', async () => {
      mockRedis.ttl.mockResolvedValue(-2);

      const result = await cache.ttl('key');

      expect(result).toBe(-2);
    });
  });
});
