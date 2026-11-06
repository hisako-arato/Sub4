import type { Env } from "./env.ts";
import { isLoggedIn, login, logout } from "./session.ts";
import { connectionStatus, disconnect, getAccessToken, handleCallback, startAuth } from "./oauth.ts";
import { AuthRequiredError } from "./mcp.ts";
import { runProbe } from "./probe.ts";
import { ensureSchema } from "./schema.ts";
import { McpClient } from "./mcp.ts";
import { loadActivities, loadSnapshot, syncFromCoros } from "./coros/sync.ts";
import { computeAbility } from "./plan/ability.ts";
import { generatePlan } from "./plan/generate.ts";
import { addDays, daysBetween, RACE_DATE, todayJst, weekSpecFor, PHASE_JA } from "./plan/calendar.ts";
import { fmtPace, fmtTime, predictTime } from "./plan/vdot.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  // 設定確認用（値は返さず、登録されているかどうかだけ）
  if (p === "/api/health") {
    return json({ ok: true, app_password_set: !!env.APP_PASSWORD, db_bound: !!env.DB, coros_mcp_url: env.COROS_MCP_URL });
  }

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

  if (p === "/api/sync" && req.method === "POST") {
    const r = await syncFromCoros(env);
    return json({ ok: true, activities: r.activities, errors: r.snapshot.errors });
  }

  if (p === "/api/plan") return json(await buildPlanResponse(env));

  // 時計への送信を作るための確認用：書き込みツールの入力スキーマ
  if (p === "/api/tools") {
    const client = await McpClient.connect(env);
    const tools = await client.listTools();
    const only = url.searchParams.get("name");
    return json(tools.filter((t) => (only ? t.name === only : true)));
  }

  if (p === "/api/probe/latest") {
    const row = await env.DB.prepare("SELECT id, result FROM probe_runs ORDER BY id DESC LIMIT 1").first<{ id: number; result: string }>();
    return row ? json({ id: row.id, ...JSON.parse(row.result) }) : json(null);
  }

  return json({ error: "not_found" }, 404);
}

async function buildPlanResponse(env: Env) {
  const today = todayJst();
  const [snapshot, activities] = await Promise.all([loadSnapshot(env), loadActivities(env, addDays(today, -150))]);
  const ability = computeAbility(activities, snapshot?.fitness ?? null, today);
  const loadRatio = snapshot?.load?.[0]?.ratio ?? null;
  const days = generatePlan(ability, activities, { today, loadRatio });
  const spec = weekSpecFor(today);
  const syncedAt = snapshot?.syncedAt ?? null;
  const p = ability.paces;
  return {
    today,
    daysToRace: daysBetween(today, RACE_DATE),
    phase: spec ? { key: spec.phase, label: PHASE_JA[spec.phase], down: !!spec.down } : null,
    sync: {
      syncedAt,
      stale: !syncedAt || Date.now() / 1000 - syncedAt > 36 * 3600, // 36時間以上前なら「未同期」
      errors: snapshot?.errors ?? [],
    },
    condition: {
      loadRatio,
      loadComment: snapshot?.load?.[0]?.comment ?? null,
      recovery: snapshot?.recovery ?? null,
    },
    ability: {
      race: ability.race && {
        date: ability.race.date,
        km: ability.race.km,
        time: fmtTime(ability.race.timeS),
        pace: fmtPace(ability.race.paceS),
        avgHr: ability.race.avgHr ?? null,
      },
      vdotRace: ability.vdotRace && Math.round(ability.vdotRace * 10) / 10,
      vdotPredicted: ability.vdotPredicted && Math.round(ability.vdotPredicted * 10) / 10,
      vdotSpeed: Math.round(ability.vdotSpeed * 10) / 10,
      predictedFull: snapshot?.fitness?.predictions.full ? fmtTime(snapshot.fitness.predictions.full) : fmtTime(predictTime(ability.vdotSpeed, 42.195)),
      paces: {
        jog: `${fmtPace(p.jog[0])}〜${fmtPace(p.jog[1])}`,
        long: `${fmtPace(p.long[0])}〜${fmtPace(p.long[1])}`,
        mpBuild: fmtPace(p.mpBuild),
        mpPeak: fmtPace(p.mpPeak),
        tempo: fmtPace(p.tempo),
        interval: fmtPace(p.interval),
        goal: fmtPace(p.goal),
      },
      history: ability.history,
    },
    days,
  };
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

  // 毎朝：トークンの期限が7日以内なら更新（30日で切れるのを防ぐ）し、直近3週間の活動を同期する。
  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(
      ensureSchema(env)
        .then(() => getAccessToken(env, 7 * 86400))
        .then((token) => (token ? syncFromCoros(env, { days: 21 }) : null))
        .catch((e) => console.error("scheduled sync failed", e)),
    );
  },
} satisfies ExportedHandler<Env>;
