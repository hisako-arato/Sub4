// COROS MCP は英語の整形テキストで応答する（2026-11 の取得テストで確認）。
// ここで各ツールのテキストを構造化データに変換する。書式が変わっても落ちないよう、
// 取れない項目は undefined / null にする。

export interface Activity {
  labelId: string; // 2^53 を超えるので文字列
  sportType: number;
  title: string; // 例: "Outdoor Run"
  date: string; // YYYY-MM-DD（COROSのタイムゾーン）
  startTs?: number;
  distanceKm: number;
  durationS: number;
  avgHr?: number;
  location?: string;
}

/** "4:24:44" / "24:13" → 秒 */
export function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const parts = s.trim().split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const num = (s: string | undefined) => (s === undefined ? undefined : Number(s.replace(/,/g, "")));

/** querySportRecords のテキスト → 活動一覧 */
export function parseSportRecords(text: unknown): Activity[] {
  if (typeof text !== "string") return [];
  const out: Activity[] = [];
  // 各活動は "1. Outdoor Run — 2026-11-03" で始まる
  const blocks = text.split(/\n(?=\s*\d+\.\s+.+?\s+[—-]\s+\d{4}-\d{2}-\d{2})/);
  for (const b of blocks) {
    const head = b.match(/^\s*\d+\.\s+(.+?)\s+[—-]\s+(\d{4}-\d{2}-\d{2})/m);
    const ids = b.match(/LabelId:\s*(\d+)\s*\|\s*SportType:\s*(\d+)/i);
    if (!head || !ids) continue;
    const dist = b.match(/Distance:\s*([\d.,]+)\s*km/i);
    const dur = b.match(/Duration:\s*([\d:]+)/i);
    out.push({
      labelId: ids[1],
      sportType: Number(ids[2]),
      title: head[1].trim(),
      date: head[2],
      startTs: num(b.match(/startTimestamp=(\d+)/)?.[1]),
      distanceKm: num(dist?.[1]) ?? 0,
      durationS: parseDuration(dur?.[1]) ?? 0,
      avgHr: num(b.match(/Avg HR:\s*(\d+)/i)?.[1]),
      location: b.match(/Location:\s*(.+)/)?.[1]?.trim(),
    });
  }
  return out;
}

export function isRun(a: Pick<Activity, "sportType" | "title">): boolean {
  return /run/i.test(a.title) || (a.sportType >= 100 && a.sportType <= 104);
}

export interface FitnessOverview {
  vo2max?: number;
  runningLevel?: number;
  thresholdPaceS?: number; // 秒/km
  predictions: { km5?: number; km10?: number; half?: number; full?: number }; // 秒
}

export function parseFitness(text: unknown): FitnessOverview | null {
  if (typeof text !== "string") return null;
  const t = (re: RegExp) => text.match(re)?.[1];
  const f: FitnessOverview = {
    vo2max: num(t(/VO2max:\s*([\d.]+)/i)),
    runningLevel: num(t(/Running Level:\s*([\d.]+)/i)),
    thresholdPaceS: parseDuration(t(/Threshold Pace:\s*([\d:]+)/i)),
    predictions: {
      km5: parseDuration(t(/5 ?km Prediction:\s*([\d:]+)/i)),
      km10: parseDuration(t(/10 ?km Prediction:\s*([\d:]+)/i)),
      half: parseDuration(t(/Half Marathon Prediction:\s*([\d:]+)/i)),
      full: parseDuration(t(/(?<!Half )Marathon Prediction:\s*([\d:]+)/i)),
    },
  };
  return f.vo2max !== undefined || f.predictions.km10 !== undefined ? f : null;
}

export interface LoadDay {
  date: string;
  comment?: string;
  shortTerm?: number;
  longTerm?: number;
  ratio?: number;
}

/** queryTrainingLoadAssessment → 日ごとの負荷（新しい順） */
export function parseTrainingLoad(text: unknown): LoadDay[] {
  if (typeof text !== "string") return [];
  const out: LoadDay[] = [];
  for (const b of text.split(/\n(?=\d{4}-\d{2}-\d{2}\s*\n)/)) {
    const d = b.match(/^(\d{4}-\d{2}-\d{2})\s*$/m);
    if (!d) continue;
    out.push({
      date: d[1],
      comment: b.match(/Comment:\s*(.+)/)?.[1]?.trim(),
      shortTerm: num(b.match(/Short-Term Load:\s*([\d.]+)/i)?.[1]),
      longTerm: num(b.match(/Long-Term Load:\s*([\d.]+)/i)?.[1]),
      ratio: num(b.match(/Load Ratio:\s*([\d.]+)/i)?.[1]),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function parseRecovery(text: unknown): { percent?: number; level?: string } | null {
  if (typeof text !== "string") return null;
  const percent = num(text.match(/Recovery:\s*([\d.]+)\s*%/i)?.[1]);
  const level = text.match(/Level:\s*(.+)/i)?.[1]?.trim();
  return percent === undefined && !level ? null : { percent, level };
}

export function parseUserInfo(text: unknown): { heightCm?: number; weightKg?: number; birthday?: string; gender?: string } | null {
  if (typeof text !== "string") return null;
  return {
    heightCm: num(text.match(/Height:\s*([\d.]+)/i)?.[1]),
    weightKg: num(text.match(/Weight:\s*([\d.]+)/i)?.[1]),
    birthday: text.match(/Birthday:\s*(\d{4}-\d{2}-\d{2})/)?.[1],
    gender: text.match(/Gender:\s*(\w+)/i)?.[1],
  };
}
