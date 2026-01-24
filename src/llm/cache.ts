import { Database } from "bun:sqlite";
import { nowIso } from "../util/time";

export type CacheKey = {
  toolName: string;
  args: Record<string, any>;
  promptVersion?: string;
};

export type CacheEntry = {
  id: string;
  key: string;
  value: any;
  toolName: string;
  argsHash: string;
  promptVersion: string | null;
  createdAt: string;
  expiresAt: string | null;
  hits: number;
};

const DDL = `
CREATE TABLE IF NOT EXISTS generation_cache (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  prompt_version TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  hits INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cache_tool ON generation_cache(tool_name);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON generation_cache(expires_at);
`;

function hashArgs(args: Record<string, any>): string {
  const sorted = JSON.stringify(args, Object.keys(args).sort());
  // Simple hash for cache key
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    const char = sorted.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

function makeCacheKey(key: CacheKey): string {
  const argsHash = hashArgs(key.args);
  return `${key.toolName}:${argsHash}:${key.promptVersion || "default"}`;
}

function makeId(): string {
  return `cache_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class GenerationCache {
  private db: Database;
  private path: string;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(path);
    this.db.exec(DDL);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Get a cached value
   */
  get(key: CacheKey): any | undefined {
    const cacheKey = makeCacheKey(key);
    const row = this.db.prepare(
      "SELECT * FROM generation_cache WHERE key = ?"
    ).get(cacheKey) as any;

    if (!row) return undefined;

    // Check expiration
    if (row.expires_at) {
      const expires = new Date(row.expires_at);
      if (expires < new Date()) {
        // Expired, delete it
        this.db.prepare("DELETE FROM generation_cache WHERE id = ?").run(row.id);
        return undefined;
      }
    }

    // Increment hit count
    this.db.prepare(
      "UPDATE generation_cache SET hits = hits + 1 WHERE id = ?"
    ).run(row.id);

    try {
      return JSON.parse(row.value_json);
    } catch {
      return undefined;
    }
  }

  /**
   * Set a cached value
   */
  set(key: CacheKey, value: any, ttlDays?: number): void {
    const cacheKey = makeCacheKey(key);
    const id = makeId();
    const ts = nowIso();

    let expiresAt: string | null = null;
    if (ttlDays && ttlDays > 0) {
      const expires = new Date();
      expires.setDate(expires.getDate() + ttlDays);
      expiresAt = expires.toISOString();
    }

    this.db.prepare(`
      INSERT INTO generation_cache (id, key, value_json, tool_name, args_hash, prompt_version, created_at, expires_at, hits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        hits = 0
    `).run(
      id,
      cacheKey,
      JSON.stringify(value),
      key.toolName,
      hashArgs(key.args),
      key.promptVersion || null,
      ts,
      expiresAt
    );
  }

  /**
   * Invalidate cache entries
   */
  invalidate(opts: {
    toolName?: string;
    promptVersion?: string;
    olderThanDays?: number;
  } = {}): number {
    const where: string[] = [];
    const params: any[] = [];

    if (opts.toolName) {
      where.push("tool_name = ?");
      params.push(opts.toolName);
    }

    if (opts.promptVersion) {
      where.push("prompt_version = ?");
      params.push(opts.promptVersion);
    }

    if (opts.olderThanDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - opts.olderThanDays);
      where.push("created_at < ?");
      params.push(cutoff.toISOString());
    }

    let sql = "DELETE FROM generation_cache";
    if (where.length) {
      sql += " WHERE " + where.join(" AND ");
    }

    const result = this.db.prepare(sql).run(...params);
    return result.changes;
  }

  /**
   * Clear all expired entries
   */
  clearExpired(): number {
    const result = this.db.prepare(
      "DELETE FROM generation_cache WHERE expires_at IS NOT NULL AND expires_at < ?"
    ).run(nowIso());
    return result.changes;
  }

  /**
   * Get cache statistics
   */
  stats(): { total: number; expired: number; totalHits: number } {
    const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM generation_cache").get() as any)?.cnt || 0;
    const expired = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM generation_cache WHERE expires_at IS NOT NULL AND expires_at < ?"
    ).get(nowIso()) as any)?.cnt || 0;
    const totalHits = (this.db.prepare("SELECT SUM(hits) as sum FROM generation_cache").get() as any)?.sum || 0;

    return { total, expired, totalHits };
  }

  /**
   * List recent cache entries
   */
  list(limit = 20): CacheEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM generation_cache ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      value: JSON.parse(r.value_json),
      toolName: r.tool_name,
      argsHash: r.args_hash,
      promptVersion: r.prompt_version,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      hits: r.hits,
    }));
  }
}

// Singleton cache instance
let globalCache: GenerationCache | null = null;

export function getGlobalCache(path?: string): GenerationCache {
  if (!globalCache) {
    const cachePath = path || "./data/generation-cache.db";
    globalCache = new GenerationCache(cachePath);
  }
  return globalCache;
}

export function closeGlobalCache(): void {
  if (globalCache) {
    globalCache.close();
    globalCache = null;
  }
}
