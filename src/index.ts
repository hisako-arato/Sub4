import type { Env } from "./env.ts";
import { isLoggedIn, login, logout } from "./session.ts";
import { connectionStatus, disconnect, getAccessToken, handleCallback, startAuth } from "./oauth.ts";
import { AuthRequiredError } from "./mcp.ts";
import { runProbe } from "./probe.ts";
import { ensureSchema } from "./schema.ts";
import { McpClient } from "./mcp.ts";
import { loadActivities, loadPlanStart, loadSnapshot, syncFromCoros } from "./coros/sync.ts";
import { computeAbility } from "./plan/ability.ts";
import { generateWithHistory } from "./plan/generate.ts";
import { clearPain, loadLogs, loadPainClearedAt, loadSettings, saveSettings, setChoice, setDayStatus } from "./daylog.ts";
import { addDays, daysBetween, RACE_DATE, todayJst, weekSpecFor, PHASE_JA } from "./plan/calendar.ts";
import { fmtPace, fmtTime, predictTime } from "./plan/vdot.ts";
import { loadPushed, pushWorkout } from "./coros/workout.ts";

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

  // 日々の記録
  if (p === "/api/day" && req.method === "POST") {
    const err = await setDayStatus(env, await req.json().catch(() => ({})));
    return err ? json({ error: "bad_request", message: err }, 400) : json({ ok: true });
  }
  if (p === "/api/choice" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { date?: string; choice?: number };
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return json({ error: "bad_request" }, 400);
    await setChoice(env, body.date, Number(body.choice));
    return json({ ok: true });
  }
  if (p === "/api/pain-clear" && req.method === "POST") {
    await clearPain(env);
    return json({ ok: true });
  }
  if (p === "/api/settings" && req.method === "POST") return json(await saveSettings(env, await req.json().catch(() => ({}))));

  // 練習を時計（COROS の予定）に送る
  if (p === "/api/push" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { date?: string; choice?: number };
    const { days } = await computePlan(env);
    const day = days.find((d) => d.date === body.date);
    if (!day) return json({ error: "bad_date", message: "2週間の計画の中の日付だけ送れます" }, 400);
    const choice = day.choice >= 0 ? day.choice : Number(body.choice ?? -1);
    const session = choice >= 0 ? day.subs[choice] : day.main;
    if (!session) return json({ error: "rest_day", message: "休養日なので送る練習はありません" }, 400);
    try {
      const r = await pushWorkout(env, day.date, session);
      // 内部ID（idInPlan など）は利用者に見せない
      const message = r.message.split("\n").filter((l) => !/id/i.test(l)).join("\n").trim();
      return json({ ok: true, title: r.title, updated: r.updated, message });
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      return json({ error: "push_failed", message: String(e instanceof Error ? e.message : e) }, 502);
    }
  }

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

async function computePlan(env: Env) {
  const today = todayJst();
  const [snapshot, activities, logs, settings, painClearedAt, planStart] = await Promise.all([
    loadSnapshot(env),
    loadActivities(env, addDays(today, -150)),
    loadLogs(env, addDays(today, -60)),
    loadSettings(env),
    loadPainClearedAt(env),
    loadPlanStart(env),
  ]);
  const ability = computeAbility(activities, snapshot?.fitness ?? null, today);
  const loadRatio = snapshot?.load?.[0]?.ratio ?? null;
  const { days, past, alerts } = generateWithHistory(ability, activities, {
    today, loadRatio, recoveryPercent: snapshot?.recovery?.percent ?? null, logs, settings, painClearedAt, planStart,
  });
  return { today, snapshot, ability, loadRatio, days, past, alerts, settings };
}

async function buildPlanResponse(env: Env) {
  const [{ today, snapshot, ability, loadRatio, days, past, alerts, settings }, pushed] = await Promise.all([computePlan(env), loadPushed(env)]);
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
    days: days.map((d) => ({ ...d, pushed: pushed[d.date] ? { title: pushed[d.date].title, at: pushed[d.date].at } : null })),
    past: past.filter((d) => d.date >= addDays(today, -7)),
    alerts,
    settings,
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
