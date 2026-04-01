import Redis from 'ioredis';
export declare function getRedis(): Redis | null;
export declare function disconnectRedis(): Promise<void>;
export declare class CacheService {
    private redis;
    constructor(redisInstance?: Redis | null);
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    ttl(key: string): Promise<number>;
}
//# sourceMappingURL=redis.d.ts.map