// DB のテーブル定義。初回アクセス時に Worker 自身が未適用の分を適用する
// （管理画面やコマンドでの作業を不要にするため）。
// 変更するときは、既存の要素を書き換えず、配列の末尾に追加する。
import type { Env } from "./env.ts";

const MIGRATIONS: string[][] = [
  // 1: 初期
  [
    `CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS probe_runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      result     TEXT NOT NULL
    )`,
  ],
];

let ready: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  ready ??= migrate(env).catch((e) => {
    ready = null; // 失敗したら次のリクエストで再試行
    throw e;
  });
  return ready;
}

async function migrate(env: Env): Promise<void> {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)").run();
  const row = await env.DB.prepare("SELECT MAX(version) AS v FROM schema_version").first<{ v: number | null }>();
  const current = row?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    await env.DB.batch([
      ...MIGRATIONS[i].map((sql) => env.DB.prepare(sql)),
      env.DB.prepare("INSERT INTO schema_version (version) VALUES (?)").bind(i + 1),
    ]);
  }
}
