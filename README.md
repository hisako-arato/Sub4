# Sub4 Coach

2027年3月14日の静岡マラソンでサブ4を目指す、自分専用のランニングコーチアプリ。
目的・思想・決定事項は [CLAUDE.md](CLAUDE.md) を参照。

## 構成
| 役割 | 使うもの（すべて Cloudflare 無料枠） |
|---|---|
| 画面 | `public/`（スマホブラウザ向け。ホーム画面に追加可） |
| サーバー | Cloudflare Workers（`src/`）：ログイン、COROS の OAuth、COROS MCP の呼び出し |
| 保存 | Cloudflare D1（`migrations/`） |
| 定期処理 | Cron Trigger（毎朝 5:00 JST にトークン更新） |

```
src/
  index.ts    ルーティング・Cron
  session.ts  パスワード1つのログイン（署名付きCookie）
  oauth.ts    COROS OAuth（メタデータ自動発見 → 動的クライアント登録 → PKCE）
  mcp.ts      COROS MCP を LLM なしで直接呼ぶ JSON-RPC クライアント
  probe.ts    データ取得テスト（読み取り専用ツールのみ呼ぶ）
test/
  mock-coros.mjs  偽の COROS サーバー（OAuth + MCP）
  e2e.mjs         ローカル通しテスト
```

## 段階1：デプロイして取得テストをする

PC（Node.js 20 以上）で行う。

```sh
git clone https://github.com/hisako-arato/Sub4.git && cd Sub4
npm install
npx wrangler login                 # ブラウザで Cloudflare にログイン（アカウントは無料で作成）

npx wrangler d1 create sub4        # 出力の database_id を wrangler.toml に貼る
npm run db:migrate:remote

npx wrangler secret put APP_PASSWORD     # アプリのログインパスワードを入力
node -e "console.log(crypto.randomBytes(32).toString('base64url'))" | npx wrangler secret put SESSION_SECRET

npm run deploy                     # https://sub4-coach.<あなたのサブドメイン>.workers.dev が表示される
```

スマホで表示された URL を開き：
1. パスワードでログイン
2. 「COROSと接続」→ COROS アカウントでログインして許可
3. 「取得テストを実行」→「結果をJSONで保存」
4. 保存した JSON（または画面の内容）を Claude Code に渡す → 結果に合わせて走力算出・計画ロジックを作る

### うまくいかないとき
- **「動的クライアント登録に対応していません」**：COROS が自動登録に非対応。画面の「認可サーバーの発見ログ」を Claude Code に共有する。クライアントIDが入手できれば `npx wrangler secret put COROS_CLIENT_ID` で設定できる。
- **地域の問題で繋がらない**：`wrangler.toml` の `COROS_MCP_URL` を地域別 URL（例：`https://mcpus.coros.com/mcp`）に変えて再デプロイ。

## 開発
```sh
npm run typecheck
npm run test:e2e     # 偽COROS + wrangler dev で ログイン→OAuth→取得テスト→トークン更新 を確認
```
