-- 汎用の設定・認証情報置き場（OAuthクライアント情報、トークン、認可途中のstateなど）
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER,            -- UNIX秒。NULLなら無期限
  updated_at INTEGER NOT NULL
);

-- COROS取得テストの結果
CREATE TABLE IF NOT EXISTS probe_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  result     TEXT NOT NULL         -- JSON
);
