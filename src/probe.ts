// 取得テスト：COROS MCP で「実際に何が取れるか」を確かめる。
// 読み取り専用ツールだけを呼ぶ（書き込みツールは一覧に出るかの確認のみで、呼び出さない）。
import type { Env } from "./env.ts";
import { McpClient, type McpTool } from "./mcp.ts";

const WRITE_PREFIXES = ["create", "update", "schedule", "upload", "delete", "remove"];

export function isWriteTool(t: McpTool): boolean {
  if (t.annotations?.readOnlyHint === true) return false;
  if (t.annotations?.readOnlyHint === false) return true;
  return WRITE_PREFIXES.some((p) => t.name.startsWith(p));
}

/** JST の yyyyMMdd */
export function jstDate(offsetDays = 0, base = Date.now()): string {
  const d = new Date(base + 9 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 活動一覧の結果から最初の {labelId, sportType} を取り出す。
 * COROS は人が読む文章形式で返す（例: "LabelId: 481490330831585282 | SportType: 100"）。
 * labelId は JS の安全な整数範囲を超えるので文字列のまま扱う。JSON で返る場合にも対応する。
 */
export function findActivityRef(data: unknown): { labelId: string; sportType: number } | null {
  const stack: unknown[] = [data];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") {
      const m = v.match(/LabelId:\s*(\d+)\s*\|\s*SportType:\s*(\d+)/i);
      if (m) return { labelId: m[1], sportType: Number(m[2]) };
    } else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.labelId !== undefined && o.sportType !== undefined) return { labelId: String(o.labelId), sportType: Number(o.sportType) };
      stack.push(...Object.values(o));
    }
  }
  return null;
}

interface ProbeCall {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  isError?: boolean;
  ms: number;
  bytes?: number;
  data?: unknown;
  error?: string;
}

// D1 の1行上限（約2MB）に収まるよう、1ツールあたりの保存量を抑える
const MAX_BYTES_PER_CALL = 100_000;

export async function runProbe(env: Env) {
  const started = Date.now();
  const client = await McpClient.connect(env);
  const tools = await client.listTools();
  const available = new Set(tools.map((t) => t.name));
  const calls: ProbeCall[] = [];

  async function call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!available.has(tool)) {
      calls.push({ tool, args, ok: false, ms: 0, error: "tools/list に存在しない" });
      return undefined;
    }
    const t0 = Date.now();
    try {
      const r = await client.callTool(tool, args);
      const json = JSON.stringify(r.data) ?? "";
      calls.push({
        tool,
        args,
        ok: !r.isError,
        isError: r.isError,
        ms: Date.now() - t0,
        bytes: json.length,
        data: json.length > MAX_BYTES_PER_CALL ? { truncated: true, head: json.slice(0, MAX_BYTES_PER_CALL) } : r.data,
      });
      return r.data;
    } catch (e) {
      calls.push({ tool, args, ok: false, ms: Date.now() - t0, error: String(e) });
      return undefined;
    }
  }

  // プロフィール・端末・走力
  await call("queryUserInfo");
  await call("queryDevices");
  await call("queryFitnessAssessmentOverview");

  // 活動履歴（直近8週。走力・曜日傾向の算出に使う想定）
  await call("querySportRecords", { startDate: jstDate(-56), endDate: jstDate(0), limit: 100 });

  // 2026/11/3 の大会（40km以上）を検出 → 詳細とラップ
  const race = await call("querySportRecords", { startDate: "20261101", endDate: "20261105", minDistanceKm: 40, limit: 5 });
  const ref = findActivityRef(race);
  if (ref) {
    await call("getActivityDetail", ref);
    await call("queryActivityLapData", ref);
  } else {
    calls.push({ tool: "getActivityDetail", args: {}, ok: false, ms: 0, error: "大会の活動（labelId/sportType）が見つからず未実行" });
  }

  // 体調・回復
  await call("queryDailyHealthData", { days: 7 });
  await call("querySleepOverview", { days: 7 });
  await call("querySleepHrv", { days: 7 });
  await call("queryRestingHeartRate", { days: 7 });
  await call("queryRecoveryStatus");
  await call("queryTrainingLoadAssessment", { days: 28 });

  // 予定・プラン（読み取りのみ）
  await call("queryTrainingSchedule", { startDate: jstDate(0), endDate: jstDate(13) });
  await call("queryTrainingPlanLibrary", { statusList: [0, 1] });
  // 補強を時計に送るため：筋トレのワークアウト一覧（「Sub4 補強」を探す）
  await call("queryWorkoutLibrary", { sportType: 4 });

  return {
    ran_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    tools: tools.map((t) => ({ name: t.name, write: isWriteTool(t), description: t.description?.slice(0, 200) })),
    write_tools_available: tools.filter(isWriteTool).map((t) => t.name),
    calls,
  };
}
