// 日付ユーティリティ・祝日・期分け。日付は "YYYY-MM-DD"（JST）の文字列で扱う。

export const RACE_DATE = "2027-03-14";
export const SUB4_SECONDS = 4 * 3600 - 60; // 3:59:00 を狙う
export const RACE_KM = 42.195;

const DAY = 86400_000;

export function todayJst(now = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

/** 0=月 … 6=日 */
export function weekday(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function mondayOf(date: string): string {
  return addDays(date, -weekday(date));
}

export const WEEKDAY_JA = ["月", "火", "水", "木", "金", "土", "日"];

// 祝日（大会までの期間分。内閣府の公表に基づく）。外部サービスに頼らないため固定で持つ。
// 期間を延ばすときはここに追記する。
export const HOLIDAYS: Record<string, string> = {
  "2026-09-21": "敬老の日",
  "2026-09-22": "国民の休日",
  "2026-09-23": "秋分の日",
  "2026-10-12": "スポーツの日",
  "2026-11-03": "文化の日",
  "2026-11-23": "勤労感謝の日",
  "2027-01-01": "元日",
  "2027-01-11": "成人の日",
  "2027-02-11": "建国記念の日",
  "2027-02-23": "天皇誕生日",
  "2027-03-21": "春分の日",
  "2027-03-22": "振替休日",
};

export const isHoliday = (date: string) => date in HOLIDAYS;
export const isWeekendOrHoliday = (date: string) => weekday(date) >= 5 || isHoliday(date);

export type Phase = "recovery" | "base" | "build" | "peak" | "taper" | "race";

export const PHASE_JA: Record<Phase, string> = {
  recovery: "回復期",
  base: "基礎期",
  build: "強化期",
  peak: "ピーク期",
  taper: "テーパー期",
  race: "大会週",
};

/** 週の種類。key は週末のメイン練習 */
export interface WeekSpec {
  monday: string;
  phase: Phase;
  down?: boolean; // 軽めの週（任意ジョグなし）
  label?: string; // 週の説明（例：台北前の調整週）
  monRest?: boolean; // 月曜を休養にする（大会の翌日など）
  key:
    | { kind: "jog"; km: number }
    | { kind: "long"; km: number }
    | { kind: "mp"; km: number } // マラソンペース区間の距離（前後にアップ・ダウン2kmずつ）
    | { kind: "race" }
    | { kind: "tuneup"; name: string }; // サブ4を狙わない大会（日曜）
  wed: "jog" | "strides" | "buildup" | "interval" | "tempo" | "sharpen";
  intervalReps?: number;
  tempoMin?: number;
}

// 大会日（3/14）から逆算した週ごとの計画（月曜始まり）。
// ロング走は週+4km以内で伸ばし、3〜4週に1回は軽めの週を入れる。30km走はピーク期に2回。
// 12/20 台北マラソン（サブ4は狙わない）：前の週を調整週、後の週を回復週にする。
export const WEEKS: WeekSpec[] = [
  { monday: "2026-11-02", phase: "recovery", key: { kind: "jog", km: 5 }, wed: "jog" },
  { monday: "2026-11-09", phase: "recovery", key: { kind: "jog", km: 8 }, wed: "jog" },
  { monday: "2026-11-16", phase: "base", key: { kind: "long", km: 14 }, wed: "strides" },
  { monday: "2026-11-23", phase: "base", key: { kind: "long", km: 16 }, wed: "strides" },
  { monday: "2026-11-30", phase: "base", key: { kind: "long", km: 18 }, wed: "buildup" },
  { monday: "2026-12-07", phase: "base", key: { kind: "long", km: 20 }, wed: "buildup" },
  { monday: "2026-12-14", phase: "base", down: true, label: "台北前の調整週", key: { kind: "tuneup", name: "台北マラソン" }, wed: "strides" },
  { monday: "2026-12-21", phase: "recovery", down: true, label: "台北後の回復週", monRest: true, key: { kind: "jog", km: 10 }, wed: "jog" },
  { monday: "2026-12-28", phase: "build", key: { kind: "mp", km: 8 }, wed: "interval", intervalReps: 4 },
  { monday: "2027-01-04", phase: "build", key: { kind: "long", km: 22 }, wed: "tempo", tempoMin: 20 },
  { monday: "2027-01-11", phase: "build", key: { kind: "mp", km: 12 }, wed: "interval", intervalReps: 5 },
  { monday: "2027-01-18", phase: "build", down: true, key: { kind: "long", km: 18 }, wed: "strides" },
  { monday: "2027-01-25", phase: "build", key: { kind: "long", km: 26 }, wed: "tempo", tempoMin: 25 },
  { monday: "2027-02-01", phase: "peak", key: { kind: "mp", km: 15 }, wed: "interval", intervalReps: 5 },
  { monday: "2027-02-08", phase: "peak", key: { kind: "long", km: 30 }, wed: "tempo", tempoMin: 25 },
  { monday: "2027-02-15", phase: "peak", down: true, key: { kind: "mp", km: 10 }, wed: "strides" },
  { monday: "2027-02-22", phase: "peak", key: { kind: "long", km: 30 }, wed: "interval", intervalReps: 6 },
  { monday: "2027-03-01", phase: "taper", key: { kind: "mp", km: 10 }, wed: "interval", intervalReps: 4 },
  { monday: "2027-03-08", phase: "race", key: { kind: "race" }, wed: "sharpen" },
];

export function weekSpecFor(date: string): WeekSpec | null {
  const mon = mondayOf(date);
  return WEEKS.find((w) => w.monday === mon) ?? null;
}
