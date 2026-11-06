import type { Env } from "./env.ts";
import { isLoggedIn, login, logout } from "./session.ts";
import { connectionStatus, disconnect, getAccessToken, handleCallback, startAuth } from "./oauth.ts";
import { AuthRequiredError } from "./mcp.ts";
import { runProbe } from "./probe.ts";
import { ensureSchema } from "./schema.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/api/login" && req.method === "POST") return login(req, env);
  if (p === "/api/logout" && req.method === "POST") return logout();

  // ここから先はログイン必須（OAuthコールバックも、他人のCOROSを紐付けられないようにする）
  if (!(await isLoggedIn(req, env))) {
    if (p.startsWith("/oauth/")) return Response.redirect(`${url.origin}/?login_required=1`, 302);
    return json({ error: "login_required" }, 401);
  }

  if (p === "/oauth/start") return startAuth(req, env);
  if (p === "/oauth/callback") return handleCallback(req, env);

  if (p === "/api/status") return json({ logged_in: true, coros: await connectionStatus(env) });

  if (p === "/api/coros/disconnect" && req.method === "POST") {
    await disconnect(env);
    return json({ ok: true });
  }

  if (p === "/api/probe" && req.method === "POST") {
    const result = await runProbe(env);
    const r = await env.DB.prepare("INSERT INTO probe_runs (created_at, result) VALUES (?, ?)")
      .bind(Math.floor(Date.now() / 1000), JSON.stringify(result))
      .run();
    return json({ id: r.meta.last_row_id, ...result });
  }

  if (p === "/api/probe/latest") {
    const row = await env.DB.prepare("SELECT id, result FROM probe_runs ORDER BY id DESC LIMIT 1").first<{ id: number; result: string }>();
    return row ? json({ id: row.id, ...JSON.parse(row.result) }) : json(null);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env): Promise<Response> {
    try {
      await ensureSchema(env);
      return await route(req, env);
    } catch (e) {
      if (e instanceof AuthRequiredError) return json({ error: "coros_auth_required", message: e.message }, 409);
      console.error(e);
      return json({ error: "internal", message: String(e) }, 500);
    }
  },

  // 毎朝：トークンの期限が7日以内なら更新（30日で切れるのを防ぐ）。後の段階でデータ同期を追加。
  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(
      ensureSchema(env)
        .then(() => getAccessToken(env, 7 * 86400))
        .catch((e) => console.error("token refresh failed", e)),
    );
  },
} satisfies ExportedHandler<Env>;
