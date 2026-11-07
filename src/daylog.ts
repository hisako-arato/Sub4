// 選んだ気分の練習・達成判定の設定・痛みの状態。走った／走らなかった・体重は COROS を参照するだけで、ここでは扱わない。
import type { Env } from "./env.ts";
import { kvDelete, kvGet, kvSet } from "./store.ts";
import { DEFAULT_SETTINGS, type AchievementSettings, type DayLog, type SkipReason } from "./plan/adjust.ts";
import { addDays, todayJst } from "./plan/calendar.ts";


export async function loadLogs(env: Env, since: string): Promise<Record<string, DayLog>> {
  const rows = await env.DB.prepare("SELECT date, status, reason, km, choice FROM day_log WHERE date >= ?").bind(since).all<any>();
  return Object.fromEntries(
    rows.results.map((r) => [r.date, { status: r.status ?? null, reason: r.reason ?? null, km: r.km ?? null, choice: r.choice ?? null }]),
  );
}

async function upsert(env: Env, date: string, fields: Partial<DayLog>) {
  const cur = (await loadLogs(env, date))[date] ?? { status: null, reason: null, km: null, choice: null };
  const next = { ...cur, ...fields };
  await env.DB.prepare(
    `INSERT INTO day_log (date, status, reason, km, choice, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET status=excluded.status, reason=excluded.reason, km=excluded.km, choice=excluded.choice, updated_at=excluded.updated_at`,
  )
    .bind(date, next.status ?? null, next.reason ?? null, next.km ?? null, next.choice ?? null, Math.floor(Date.now() / 1000))
    .run();
}

export async function setChoice(env: Env, date: string, choice: number) {
  await upsert(env, date, { choice: Number.isInteger(choice) && choice >= 0 ? choice : null });
}

const K_SETTINGS = "settings:achievement";
const K_PAIN = "health:pain_since";

export async function loadSettings(env: Env): Promise<AchievementSettings> {
  return { ...DEFAULT_SETTINGS, ...((await kvGet<AchievementSettings>(env, K_SETTINGS)) ?? {}) };
}

export async function saveSettings(env: Env, body: any): Promise<AchievementSettings> {
  const s: AchievementSettings = {
    distPct: Math.min(100, Math.max(50, Math.round(Number(body?.distPct) || DEFAULT_SETTINGS.distPct))),
    paceTolS: Math.min(60, Math.max(0, Math.round(Number(body?.paceTolS ?? DEFAULT_SETTINGS.paceTolS)))),
  };
  await kvSet(env, K_SETTINGS, s);
  return s;
}

// 痛み：COROS には記録できない情報なので、これだけはアプリで受け付ける（安全のため）
export const loadPainSince = (env: Env) => kvGet<string>(env, K_PAIN);
export async function setPain(env: Env, active: boolean) {
  if (active) {
    if (!(await kvGet<string>(env, K_PAIN))) await kvSet(env, K_PAIN, todayJst());
  } else await kvDelete(env, K_PAIN);
}
