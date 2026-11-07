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

// ---- 補強（筋トレ）を時計の予定に入れる ----
// MCP では筋トレのワークアウトを新しく作れない（作成はラン・バイク・トレイルランのみ）。
// 利用者が COROS アプリで一度作った「Sub4 補強」をワークアウト一覧から探し、scheduleWorkout で日付に置く。
const STRENGTH_NAME = /sub\s*4|補強/i;

/** ワークアウト一覧のテキスト（または JSON）から、名前が合うものの ID を探す */
export function findStrengthWorkoutId(data: unknown): { id: string; name: string } | null {
  if (data && typeof data === "object") {
    const stack: unknown[] = [data];
    while (stack.length) {
      const v = stack.pop();
      if (Array.isArray(v)) stack.push(...v);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const name = String(o.name ?? o.courseName ?? o.workoutName ?? "");
        const id = o.workoutId ?? o.id ?? o.courseId;
        if (id != null && STRENGTH_NAME.test(name)) return { id: String(id), name };
        stack.push(...Object.values(o));
      }
    }
    return null;
  }
  if (typeof data !== "string") return null;
  // 番号付きの項目（「2. Sub4 補強」〜次の番号の前まで）ごとに、名前と ID を探す
  const blocks = data.split(/\n(?=\s*\d+[.)]\s)/);
  for (const b of blocks) {
    const name = b.match(/^\s*\d+[.)]\s*(.+)$/m)?.[1]?.trim() ?? b.match(/(?:Name|Workout Name)\s*[:：]\s*(.+)/i)?.[1]?.trim();
    if (!name || !STRENGTH_NAME.test(name)) continue;
    const id = b.match(/(?:Workout\s*ID|Course\s*ID|\bID)\s*[:：=]\s*([\w-]+)/i)?.[1];
    if (id) return { id, name };
  }
  return null;
}

export async function pushStrength(env: Env, date: string): Promise<{ name: string; message: string }> {
  const client = await McpClient.connect(env);
  const lib = await client.callTool("queryWorkoutLibrary", { sportType: 4 });
  const text = typeof lib.data === "string" ? lib.data : JSON.stringify(lib.data);
  if (lib.isError) throw new Error(`COROS のワークアウト一覧を取得できませんでした：${text.slice(0, 200)}`);
  const found = findStrengthWorkoutId(lib.data);
  if (!found) {
    throw new Error(`COROS のワークアウト一覧に「Sub4 補強」が見つかりませんでした。COROS アプリで作成してください。（一覧の先頭：${text.slice(0, 160)}）`);
  }
  const r = await client.callTool("scheduleWorkout", { workoutId: found.id, date: ymd(date) });
  const msg = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  if (r.isError) throw new Error(`COROS が受け付けませんでした：${msg.slice(0, 300)}`);
  await kvSet(env, `pushed-strength:${date}`, { name: found.name, at: Math.floor(Date.now() / 1000) });
  return { name: found.name, message: msg.split("\n").filter((l) => !/id/i.test(l)).join("\n").trim() };
}

export async function loadPushedStrength(env: Env): Promise<Record<string, { name: string; at: number }>> {
  const rows = await env.DB.prepare("SELECT key, value FROM kv WHERE key LIKE 'pushed-strength:%'").all<{ key: string; value: string }>();
  return Object.fromEntries(rows.results.map((r) => [r.key.slice(16), JSON.parse(r.value)]));
}
