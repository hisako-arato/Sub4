# Sub4 Coach

2027年3月14日の静岡マラソンでサブ4を目指す、自分専用のランニングコーチアプリ。
目的・思想・決定事項は [CLAUDE.md](CLAUDE.md) を参照。

## 構成
| 役割 | 使うもの（すべて Cloudflare 無料枠） |
|---|---|
| 画面 | `public/`（スマホブラウザ向け。ホーム画面に追加可） |
| サーバー | Cloudflare Workers（`src/`）：ログイン、COROS の OAuth、COROS MCP の呼び出し |
| 保存 | Cloudflare D1（テーブル定義は `src/schema.ts`。初回アクセス時に自動適用） |
| 定期処理 | Cron Trigger（毎朝 5:00 JST にトークン更新） |

```
src/
  index.ts    ルーティング・Cron
  session.ts  パスワード1つのログイン（署名付きCookie。署名鍵は自動生成）
  oauth.ts    COROS OAuth（メタデータ自動発見 → 動的クライアント登録 → PKCE）
  mcp.ts      COROS MCP を LLM なしで直接呼ぶ JSON-RPC クライアント
  probe.ts    データ取得テスト（読み取り専用ツールのみ呼ぶ）
  schema.ts   DBテーブル定義と自動適用
test/
  mock-coros.mjs  偽の COROS サーバー（OAuth + MCP）
  e2e.mjs         ローカル通しテスト
```

## 段階1：デプロイして取得テストをする

PC は不要。Cloudflare の管理画面と GitHub 連携だけでデプロイできる。
D1 データベース `sub4` は作成済み（ID は `wrangler.toml` に記入済み）。テーブルはアプリが初回アクセス時に自動で作る。

1. 管理画面「Workers & Pages」→「Create」→「Import a repository」→ GitHub の `hisako-arato/Sub4` を選ぶ
2. プロジェクト名は **`sub4-coach`**（`wrangler.toml` の `name` と一致させる）。ブランチは `ccr-4d387e48-agut1d`。他は既定のまま「Deploy」
3. デプロイ後、その Worker の「Settings」→「Variables and Secrets」→「Add」で、種類 **Secret**、名前 **`APP_PASSWORD`**、値にアプリのログインパスワードを入れて保存
4. 表示される `https://sub4-coach.<サブドメイン>.workers.dev` をスマホで開き：
   1. パスワードでログイン
   2. 「COROSと接続」→ COROS アカウントでログインして許可
   3. 「取得テストを実行」→「結果をJSONで保存」
   4. 保存した JSON を Claude Code に渡す → 結果に合わせて走力算出・計画ロジックを作る

以後は、このブランチに push すると自動で再デプロイされる。

PC から wrangler でデプロイする場合は `npx wrangler login` → `npx wrangler secret put APP_PASSWORD` → `npm run deploy`。

### うまくいかないとき
- **「動的クライアント登録に対応していません」**：COROS が自動登録に非対応。画面の「認可サーバーの発見ログ」を Claude Code に共有する。クライアントIDが入手できれば `npx wrangler secret put COROS_CLIENT_ID` で設定できる。
- **地域の問題で繋がらない**：`wrangler.toml` の `COROS_MCP_URL` を地域別 URL（例：`https://mcpus.coros.com/mcp`）に変えて再デプロイ。

## 開発
```sh
npm run typecheck
npm run test:e2e     # 偽COROS + wrangler dev で ログイン→OAuth→取得テスト→トークン更新 を確認
```
