import { getRedis } from "../config/redis";

const DEFAULT_TTL = 600; // 10 minutes

export class CacheService {
  private get redis() {
    return getRedis();
  }

  private get connected(): boolean {
    return this.redis.status === "ready";
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.connected) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds = DEFAULT_TTL): Promise<void> {
    if (!this.connected) return;
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {
      // silently fail
    }
  }

  async del(key: string): Promise<void> {
    if (!this.connected) return;
    try {
      await this.redis.del(key);
    } catch {
      // silently fail
    }
  }

  async delByPattern(pattern: string): Promise<void> {
    if (!this.connected) return;
    try {
      let cursor = "0";
      do {
        const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = next;
        if (keys.length) await this.redis.del(...keys);
      } while (cursor !== "0");
    } catch {
      // Cache invalidation must never make a successful publication fail.
    }
  }
}
