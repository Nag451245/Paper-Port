import Redis from 'ioredis';
import { env } from '../config.js';

let redis: Redis | null = null;
let redisAvailable = false;

export function getRedis(): Redis | null {
  if (redis) return redis;
  if (!env.REDIS_URL || env.REDIS_URL.includes('placeholder')) {
    return null;
  }
  try {
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      tls: env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    });
    redis.on('connect', () => { redisAvailable = true; });
    redis.on('error', () => { redisAvailable = false; });
    redis.connect().catch(() => { redisAvailable = false; });
  } catch {
    redis = null;
  }
  return redis;
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => {});
    redis = null;
    redisAvailable = false;
  }
}

export class CacheService {
  private redis: Redis | null;

  constructor(redisInstance?: Redis | null) {
    this.redis = redisInstance ?? getRedis();
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const value = await this.redis.get(key);
      if (!value) return null;
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as unknown as T;
      }
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.redis) return;
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      if (ttlSeconds) {
        await this.redis.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await this.redis.set(key, serialized);
      }
    } catch {
      // Redis unavailable, skip caching
    }
  }

  async del(key: string): Promise<void> {
    if (!this.redis) return;
    try { await this.redis.del(key); } catch { /* skip */ }
  }

  async exists(key: string): Promise<boolean> {
    if (!this.redis) return false;
    try { return (await this.redis.exists(key)) === 1; } catch { return false; }
  }

  async ttl(key: string): Promise<number> {
    if (!this.redis) return -1;
    try { return await this.redis.ttl(key); } catch { return -1; }
  }
}
