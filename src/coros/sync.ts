// COROS から活動・走力評価・負荷・回復を取り込んで D1 に保存する。
import type { Env } from "../env.ts";
import { McpClient } from "../mcp.ts";
import { kvGet, kvSet } from "../store.ts";
import { addDays, todayJst } from "../plan/calendar.ts";
import {
  parseLaps,
  parseFitness, parseRecovery, parseSportRecords, parseTrainingLoad, parseUserInfo,
  type Activity, type FitnessOverview, type Lap, type LoadDay,
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

  // 大会・ロング走（20km以上）のラップ。まだ取っていないものを1回の同期で4件まで
  const have = new Set(
    (await env.DB.prepare("SELECT label_id FROM laps WHERE date >= ?").bind(addDays(today, -days)).all<{ label_id: string }>()).results.map((r) => r.label_id),
  );
  const need = activities.filter((a) => a.distanceKm >= 20 && !have.has(a.labelId)).sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 4);
  for (const a of need) {
    const raw = await text("queryActivityLapData", { labelId: a.labelId, sportType: a.sportType });
    if (raw == null) continue;
    const laps = parseLaps(raw, a.distanceKm, a.durationS);
    await env.DB.prepare("INSERT OR REPLACE INTO laps (label_id, date, laps, raw, synced_at) VALUES (?, ?, ?, ?, ?)")
      .bind(a.labelId, a.date, JSON.stringify(laps), (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 60000), now)
      .run();
    if (!laps.length) errors.push(`queryActivityLapData: ${a.date} のラップを読み取れませんでした`);
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

/** ラップを読み込む。保存時に読めなかったものは、保存しておいた元の応答から読み直す（読み取りを直したときに効く） */
export async function loadLaps(env: Env, sinceDate: string): Promise<Record<string, Lap[]>> {
  const rows = await env.DB.prepare(
    `SELECT l.label_id, l.laps, l.raw, a.distance_km, a.duration_s FROM laps l JOIN activities a ON a.label_id = l.label_id WHERE l.date >= ?`,
  )
    .bind(sinceDate)
    .all<{ label_id: string; laps: string; raw: string | null; distance_km: number; duration_s: number }>();
  return Object.fromEntries(
    rows.results.map((r) => {
      let laps = JSON.parse(r.laps) as Lap[];
      if (!laps.length && r.raw) {
        let raw: unknown = r.raw;
        try {
          raw = JSON.parse(r.raw);
        } catch {
          /* テキストのまま */
        }
        laps = parseLaps(raw, r.distance_km, r.duration_s);
      }
      return [r.label_id, laps];
    }),
  );
}
