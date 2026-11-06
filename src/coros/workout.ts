// 練習（Session）を COROS の course 形式に変換し、時計の予定に登録する。
// 形式は createScheduledWorkout の inputSchema（2026-11 確認）に従う：
//   section: sectionType 1=アップ 2=本練習 3=つなぎ 4=ダウン / targetType 1=距離(m) 2=時間(s)
//   intensityType 2=ペース、intensityValueStart/End は秒/km（120〜1499）
//   繰り返しは intervalGroup + repeats + sets（入れ子不可、sets 内は 2/3 のみ）
import type { Env } from "../env.ts";
import { McpClient } from "../mcp.ts";
import { kvGet, kvSet } from "../store.ts";
import type { Session, Step } from "../plan/generate.ts";

const SECTION_TYPE = { warmup: 1, training: 2, recovery: 3, cooldown: 4 } as const;
const clampPace = (s: number) => Math.min(1499, Math.max(120, Math.round(s)));

function toSection(step: Step): Record<string, unknown> {
  if (step.kind === "repeat") {
    return { intervalGroup: true, repeats: Math.min(20, Math.max(1, step.times)), sets: step.steps.map(toSection) };
  }
  const byDistance = step.distanceM !== undefined;
  return {
    sectionType: SECTION_TYPE[step.kind],
    targetType: byDistance ? 1 : 2,
    targetValue: Math.max(1, Math.round(byDistance ? step.distanceM! : step.timeS!)),
    intensityType: 2,
    intensityValueStart: clampPace(step.pace[0]),
    intensityValueEnd: clampPace(step.pace[1]),
  };
}

export function toCourse(s: Session) {
  return {
    sportType: 1,
    courseName: s.title.slice(0, 100),
    courseDescription: [
      ...s.menu,
      `ペースの目安：${s.pace}（各区間に実測ペースの範囲で設定）`,
      "Sub4 Coach より",
    ].join("\n"),
    sections: s.steps.map(toSection),
  };
}

export interface PushedRecord {
  title: string;
  idInPlan?: string;
  at: number;
  message: string;
}

const key = (date: string) => `pushed:${date}`;
const ymd = (d: string) => d.replace(/-/g, "");

export async function loadPushed(env: Env): Promise<Record<string, PushedRecord>> {
  const rows = await env.DB.prepare("SELECT key, value FROM kv WHERE key LIKE 'pushed:%'").all<{ key: string; value: string }>();
  return Object.fromEntries(rows.results.map((r) => [r.key.slice(7), JSON.parse(r.value) as PushedRecord]));
}

/** 時計の予定に登録する。同じ日に送信済みなら、その予定を書き換える（重複させない） */
export async function pushWorkout(env: Env, date: string, session: Session): Promise<PushedRecord & { updated: boolean }> {
  const client = await McpClient.connect(env);
  const course = toCourse(session);
  const prev = await kvGet<PushedRecord>(env, key(date));

  let r;
  let updated = false;
  if (prev?.idInPlan) {
    r = await client.callTool("updateScheduledWorkout", { date: ymd(date), idInPlan: prev.idInPlan, course });
    updated = true;
  } else if (prev) {
    throw new Error("この日はすでに送信済みです（変更するには COROS アプリで予定を削除してから、もう一度送ってください）");
  } else {
    r = await client.callTool("createScheduledWorkout", { date: ymd(date), course });
  }
  const text = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  if (r.isError) throw new Error(`COROS が受け付けませんでした：${text.slice(0, 300)}`);

  const id = text.match(/idInPlan["'\s:=]*["']?([\w-]+)/i)?.[1] ?? prev?.idInPlan;
  const rec: PushedRecord = { title: session.title, idInPlan: id, at: Math.floor(Date.now() / 1000), message: text.slice(0, 1000) };
  await kvSet(env, key(date), rec);
  return { ...rec, updated };
}
