// 日々の記録（走る予定はない／走らなかった＋理由／走った〔手動〕）と、選んだ気分の練習。設定も扱う。
import type { Env } from "./env.ts";
import { kvGet, kvSet } from "./store.ts";
import { DEFAULT_SETTINGS, type AchievementSettings, type DayLog, type SkipReason } from "./plan/adjust.ts";
import { addDays, todayJst } from "./plan/calendar.ts";

const REASONS: SkipReason[] = ["schedule", "fatigue", "pain"];

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

/** 状態の記録。エラーなら理由の文字列を返す */
export async function setDayStatus(env: Env, body: any): Promise<string | null> {
  const today = todayJst();
  const date = String(body?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < addDays(today, -21) || date > addDays(today, 30)) return "日付が範囲外です";
  const status = body?.status ?? null;
  if (status === "off" && date < today) return "「走る予定はない」は今日以降の日に使ってください（過ぎた日は「走らなかった」）";
  if ((status === "skipped" || status === "ran") && date > today) return "まだ来ていない日です";
  if (![null, "off", "skipped", "ran"].includes(status)) return "不明な状態です";
  const reason = status === "skipped" && REASONS.includes(body?.reason) ? body.reason : null;
  const km = status === "ran" && Number(body?.km) > 0 ? Math.min(Number(body.km), 60) : null;
  await upsert(env, date, { status, reason, km });
  return null;
}

export async function setChoice(env: Env, date: string, choice: number) {
  await upsert(env, date, { choice: Number.isInteger(choice) && choice >= 0 ? choice : null });
}

const K_SETTINGS = "settings:achievement";
const K_PAIN_CLEARED = "health:pain_cleared_at";

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

export const loadPainClearedAt = (env: Env) => kvGet<string>(env, K_PAIN_CLEARED);
export const clearPain = (env: Env) => kvSet(env, K_PAIN_CLEARED, todayJst());

// 体重（COROS の値を使い、アプリで上書きできる）
const K_BODY = "settings:body";
export const loadBody = async (env: Env) => (await kvGet<{ weightKg: number | null }>(env, K_BODY)) ?? { weightKg: null };
export async function saveBody(env: Env, body: any) {
  const w = Number(body?.weightKg);
  const weightKg = w >= 30 && w <= 150 ? Math.round(w * 10) / 10 : null; // 空や不正な値は「COROS の値を使う」
  await kvSet(env, K_BODY, { weightKg });
  return { weightKg };
}
