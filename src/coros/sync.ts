// COROS から活動・走力評価・負荷・回復を取り込んで D1 に保存する。
import type { Env } from "../env.ts";
import { McpClient } from "../mcp.ts";
import { kvGet, kvSet } from "../store.ts";
import { addDays, todayJst } from "../plan/calendar.ts";
import {
  parseFitness, parseRecovery, parseSportRecords, parseTrainingLoad, parseUserInfo,
  type Activity, type FitnessOverview, type LoadDay,
} from "./parse.ts";

export interface Snapshot {
  syncedAt: number; // UNIX秒
  fitness: FitnessOverview | null;
  load: LoadDay[];
  recovery: { percent?: number; level?: string } | null;
  user: ReturnType<typeof parseUserInfo>;
  errors: string[];
}

const K_SNAPSHOT = "coros:snapshot";
const K_PLAN_START = "app:plan_start";
export const loadPlanStart = (env: Env) => kvGet<string>(env, K_PLAN_START);
const ymd = (d: string) => d.replace(/-/g, "");

export async function syncFromCoros(env: Env, opts: { days?: number } = {}): Promise<{ activities: number; snapshot: Snapshot }> {
  const today = todayJst();
  const days = opts.days ?? 120;
  const client = await McpClient.connect(env);
  const errors: string[] = [];

  async function text(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      const r = await client.callTool(tool, args);
      if (r.isError) errors.push(`${tool}: ${String(r.data).slice(0, 200)}`);
      return r.isError ? null : r.data;
    } catch (e) {
      errors.push(`${tool}: ${String(e).slice(0, 200)}`);
      return null;
    }
  }

  // 活動は 30 日ずつ取得（1回の件数上限に引っかからないように）
  const activities: Activity[] = [];
  for (let from = addDays(today, -days); from <= today; from = addDays(from, 30)) {
    const end = addDays(from, 29);
    const to = end < today ? end : today;
    activities.push(...parseSportRecords(await text("querySportRecords", { startDate: ymd(from), endDate: ymd(to), limit: 100 })));
  }

  const [fitness, load, recovery, user] = await Promise.all([
    text("queryFitnessAssessmentOverview"),
    text("queryTrainingLoadAssessment", { days: 28 }),
    text("queryRecoveryStatus"),
    text("queryUserInfo"),
  ]);

  const now = Math.floor(Date.now() / 1000);
  if (activities.length) {
    await env.DB.batch(
      activities.map((a) =>
        env.DB.prepare(
          `INSERT INTO activities (label_id, sport_type, title, date, start_ts, distance_km, duration_s, avg_hr, location, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(label_id) DO UPDATE SET sport_type=excluded.sport_type, title=excluded.title, date=excluded.date,
             start_ts=excluded.start_ts, distance_km=excluded.distance_km, duration_s=excluded.duration_s,
             avg_hr=excluded.avg_hr, location=excluded.location, synced_at=excluded.synced_at`,
        ).bind(a.labelId, a.sportType, a.title, a.date, a.startTs ?? null, a.distanceKm, a.durationS, a.avgHr ?? null, a.location ?? null, now),
      ),
    );
  }

  const snapshot: Snapshot = {
    syncedAt: now,
    fitness: parseFitness(fitness),
    load: parseTrainingLoad(load),
    recovery: parseRecovery(recovery),
    user: parseUserInfo(user),
    errors,
  };
  await kvSet(env, K_SNAPSHOT, snapshot);
  // 初回同期の日を「計画の開始日」として記録（それより前の日は達成度を判定しない）
  if (!(await kvGet<string>(env, K_PLAN_START))) await kvSet(env, K_PLAN_START, today);
  return { activities: activities.length, snapshot };
}

export async function loadSnapshot(env: Env): Promise<Snapshot | null> {
  return kvGet<Snapshot>(env, K_SNAPSHOT);
}

export async function loadActivities(env: Env, sinceDate: string): Promise<Activity[]> {
  const rows = await env.DB.prepare(
    "SELECT label_id, sport_type, title, date, start_ts, distance_km, duration_s, avg_hr, location FROM activities WHERE date >= ? ORDER BY date",
  )
    .bind(sinceDate)
    .all<any>();
  return rows.results.map((r) => ({
    labelId: r.label_id,
    sportType: r.sport_type,
    title: r.title,
    date: r.date,
    startTs: r.start_ts ?? undefined,
    distanceKm: r.distance_km,
    durationS: r.duration_s,
    avgHr: r.avg_hr ?? undefined,
    location: r.location ?? undefined,
  }));
}
