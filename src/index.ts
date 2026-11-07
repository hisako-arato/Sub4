import type { Env } from "./env.ts";
import { isLoggedIn, login, logout } from "./session.ts";
import { connectionStatus, disconnect, getAccessToken, handleCallback, startAuth } from "./oauth.ts";
import { AuthRequiredError } from "./mcp.ts";
import { runProbe } from "./probe.ts";
import { ensureSchema } from "./schema.ts";
import { McpClient } from "./mcp.ts";
import { loadActivities, loadLaps, loadPlanStart, loadSnapshot, syncFromCoros } from "./coros/sync.ts";
import { computeInsights } from "./insight/insights.ts";
import { computeAbility } from "./plan/ability.ts";
import { generateWithHistory } from "./plan/generate.ts";
import { loadLogs, loadPainSince, loadSettings, saveSettings, setChoice, setPain } from "./daylog.ts";
import { addDays, daysBetween, mondayOf, RACE_DATE, seasonTimeline, todayJst, weekSpecFor, PHASE_JA } from "./plan/calendar.ts";
import { fmtPace, fmtTime, predictTime } from "./plan/vdot.ts";
import { loadPushed, loadPushedStrength, pushStrength, pushWorkout } from "./coros/workout.ts";
import { computeVolume } from "./plan/volume.ts";
import { coachSpeech, stretchSpeech } from "./coach/speech.ts";
import { careFor, careLibrary, STRETCHES } from "./care/care.ts";
import { nutritionFor } from "./care/nutrition.ts";

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

  // 気分の練習の選択（COROS にない情報）
  if (p === "/api/choice" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { date?: string; choice?: number };
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return json({ error: "bad_request" }, 400);
    await setChoice(env, body.date, Number(body.choice));
    return json({ ok: true });
  }
  // 補強（筋トレ）を時計の予定へ：COROS アプリで作った「Sub4 補強」を日付に置く
  if (p === "/api/push-strength" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { date?: string };
    const { days } = await computePlan(env);
    const day = days.find((d) => d.date === body.date);
    if (!day?.strength || day.strength.skipped) return json({ error: "no_strength", message: "この日は補強の予定がありません" }, 400);
    try {
      return json({ ok: true, ...(await pushStrength(env, day.date)) });
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      return json({ error: "push_failed", message: String(e instanceof Error ? e.message : e) }, 502);
    }
  }

  // 痛み（COROS からは分からないので、安全のためこれだけ受け付ける）
  if (p === "/api/pain" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { active?: boolean };
    await setPain(env, !!body.active);
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
  const [snapshot, activities, logs, settings, painSince, planStart] = await Promise.all([
    loadSnapshot(env),
    loadActivities(env, addDays(today, -150)),
    loadLogs(env, addDays(today, -60)),
    loadSettings(env),
    loadPainSince(env),
    loadPlanStart(env),
  ]);
  const ability = computeAbility(activities, snapshot?.fitness ?? null, today);
  const loadRatio = snapshot?.load?.[0]?.ratio ?? null;
  // 練習カレンダー：先週の月曜〜再来週の日曜（過去2週・これから2週）
  const calEnd = addDays(mondayOf(today), 27);
  const { days, past, alerts, modes } = generateWithHistory(ability, activities, {
    days: daysBetween(today, calEnd) + 1,
    today, loadRatio, recoveryPercent: snapshot?.recovery?.percent ?? null, logs, settings, painSince, planStart,
  });
  return { today, snapshot, ability, loadRatio, days, past, alerts, modes, settings, activities };
}

async function buildPlanResponse(env: Env) {
  const [{ today, snapshot, ability, loadRatio, days, past, alerts, modes, settings, activities }, pushed, conn, laps, pushedStrength] = await Promise.all([
    computePlan(env),
    loadPushed(env),
    connectionStatus(env),
    loadLaps(env, addDays(todayJst(), -150)),
    loadPushedStrength(env),
  ]);
  const insights = computeInsights({
    today, activities, laps, fitness: snapshot?.fitness ?? null, loadRatio,
    loadComment: snapshot?.load?.[0]?.comment ?? null, ability,
  });
  // 今日のケアと栄養（選んだ気分の練習を優先）
  const d0 = days[0];
  const todaySession = d0 ? (d0.choice >= 0 && d0.subs[d0.choice]) || d0.main : null;
  const yesterdayRace = activities.some((r) => r.date === addDays(today, -1) && r.distanceKm >= 40);
  const carePlan = careFor(todaySession, { pain: modes.pain, raceDayAfter: yesterdayRace });
  // 体重は COROS の値だけを使う（アプリでは入力しない）
  const weightKg = snapshot?.user?.weightKg ?? null;
  const nutrition = weightKg ? nutritionFor(today, todaySession, weightKg, "coros") : null;
  const volume = computeVolume(ability, activities, days, today);
  const stale = !snapshot?.syncedAt || Date.now() / 1000 - snapshot.syncedAt > 36 * 3600;
  const tuneup = days.find((d) => d.main?.category === "race" && !/静岡/.test(d.main.title));
  const coach = coachSpeech({
    today: days[0] ?? null,
    daysToRace: daysBetween(today, RACE_DATE),
    phase: weekSpecFor(today)?.phase ?? null,
    phaseLabel: days[0]?.phaseLabel ?? null,
    connected: conn.connected,
    stale,
    modes,
    hourJst: new Date(Date.now() + 9 * 3600_000).getUTCHours(),
    week: { done: volume.week.done, planned: volume.week.planned },
    upcomingTuneup: tuneup ? { name: tuneup.main!.title.replace(/（.*$/, ""), inDays: daysBetween(today, tuneup.date) } : null,
    insights,
    care: modes.pain ? null : { title: carePlan.title, before: carePlan.before.map((id) => STRETCHES[id]), after: carePlan.after.map((id) => STRETCHES[id]) },
  });
  const spec = weekSpecFor(today);
  const syncedAt = snapshot?.syncedAt ?? null;
  const p = ability.paces;
  return {
    today,
    daysToRace: daysBetween(today, RACE_DATE),
    phase: spec ? { key: spec.phase, label: PHASE_JA[spec.phase], down: !!spec.down } : null,
    sync: {
      syncedAt,
      stale, // 36時間以上前なら「未同期」
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
    days: days.map((d) => ({
      ...d,
      pushed: pushed[d.date] ? { title: pushed[d.date].title, at: pushed[d.date].at } : null,
      strengthPushed: !!pushedStrength[d.date],
    })),
    past: past.filter((d) => d.date >= addDays(mondayOf(today), -7)),
    volume,
    coach,
    care: {
      ...carePlan,
      before: carePlan.before.map((id) => ({ ...STRETCHES[id], speech: stretchSpeech(STRETCHES[id]) })),
      after: carePlan.after.map((id) => ({ ...STRETCHES[id], speech: stretchSpeech(STRETCHES[id]) })),
    },
    // 今日の補強（その日のセット数で）
    strength: d0?.strength && !d0.strength.skipped
      ? {
          ...d0.strength,
          items: d0.strength.items.map((id) => {
            const st = { ...STRETCHES[id as keyof typeof STRETCHES], sets: d0.strength!.sets };
            return { ...st, speech: stretchSpeech(st) };
          }),
        }
      : null,
    // 「すべて」：いつでも見られる全種目（カテゴリごと）
    library: careLibrary().map((g) => ({ ...g, items: g.items.map((id) => ({ ...STRETCHES[id], speech: stretchSpeech(STRETCHES[id]) })) })),
    nutrition,
    pain: modes.pain,
    insights,
    season: { segments: seasonTimeline(), race: RACE_DATE },
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
