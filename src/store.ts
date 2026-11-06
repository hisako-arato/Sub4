import type { Env } from "./env.ts";

const now = () => Math.floor(Date.now() / 1000);

export async function kvGet<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value, expires_at FROM kv WHERE key = ?")
    .bind(key)
    .first<{ value: string; expires_at: number | null }>();
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at < now()) {
    await kvDelete(env, key);
    return null;
  }
  return JSON.parse(row.value) as T;
}

export async function kvSet(env: Env, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO kv (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
  )
    .bind(key, JSON.stringify(value), ttlSeconds ? now() + ttlSeconds : null, now())
    .run();
}

export async function kvDelete(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
}
