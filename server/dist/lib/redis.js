import Redis from 'ioredis';
import { env } from '../config.js';
let redis = null;
let redisAvailable = false;
export function getRedis() {
    if (redis)
        return redis;
    if (!env.REDIS_URL || env.REDIS_URL.includes('placeholder')) {
        return null;
    }
    try {
        redis = new Redis(env.REDIS_URL, {
            maxRetriesPerRequest: 3,
            lazyConnect: true,
            retryStrategy(times) {
                if (times > 3)
                    return null;
                return Math.min(times * 200, 2000);
            },
            tls: env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
        });
        redis.on('connect', () => { redisAvailable = true; });
        redis.on('error', () => { redisAvailable = false; });
        redis.connect().catch(() => { redisAvailable = false; });
    }
    catch {
        redis = null;
    }
    return redis;
}
export async function disconnectRedis() {
    if (redis) {
        await redis.quit().catch(err => console.warn('[Redis] Error during disconnect:', err?.message ?? err));
        redis = null;
        redisAvailable = false;
    }
}
export class CacheService {
    redis;
    constructor(redisInstance) {
        this.redis = redisInstance ?? getRedis();
    }
    async get(key) {
        if (!this.redis)
            return null;
        try {
            const value = await this.redis.get(key);
            if (!value)
                return null;
            try {
                return JSON.parse(value);
            }
            catch {
                return value;
            }
        }
        catch {
            return null;
        }
    }
    async set(key, value, ttlSeconds) {
        if (!this.redis)
            return;
        try {
            const serialized = typeof value === 'string' ? value : JSON.stringify(value);
            if (ttlSeconds) {
                await this.redis.set(key, serialized, 'EX', ttlSeconds);
            }
            else {
                await this.redis.set(key, serialized);
            }
        }
        catch {
            // Redis unavailable, skip caching
        }
    }
    async del(key) {
        if (!this.redis)
            return;
        try {
            await this.redis.del(key);
        }
        catch { /* skip */ }
    }
    async exists(key) {
        if (!this.redis)
            return false;
        try {
            return (await this.redis.exists(key)) === 1;
        }
        catch {
            return false;
        }
    }
    async ttl(key) {
        if (!this.redis)
            return -1;
        try {
            return await this.redis.ttl(key);
        }
        catch {
            return -1;
        }
    }
}
//# sourceMappingURL=redis.js.map