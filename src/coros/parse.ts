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

// ---- ラップ（queryActivityLapData） ----
export interface Lap {
  index: number;
  distanceKm: number;
  durationS: number;
  avgHr?: number;
}

/**
 * ラップを読み取る。公式ドキュメントでは JSON（lapIndex, distance, time, avgHr…）だが、
 * 単位（m / km / cm、秒 / ミリ秒）が書かれていないため、活動全体の距離・時間との比で単位を決める。
 * テキストで返ってきた場合も、行ごとの「Distance」「Time」「Avg HR」から読む。読めなければ空配列。
 */
export function parseLaps(data: unknown, totalKm: number, totalS: number): Lap[] {
  type Raw = { distance?: number; time?: number; hr?: number };
  let raws: Raw[] = [];
  const pickNum = (o: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "") {
        const d = parseDuration(v);
        if (/:/.test(v) && d !== undefined) return d;
        const n = Number(v.replace(/[^\d.]/g, ""));
        if (!Number.isNaN(n)) return n;
      }
    }
    return undefined;
  };
  // JSON：ラップらしい配列を探す
  const stack: unknown[] = [data];
  while (stack.length && !raws.length) {
    const v = stack.shift();
    if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && ("lapIndex" in v[0] || "distance" in v[0])) {
      raws = v.map((o) => ({
        distance: pickNum(o, ["distance", "lapDistance", "dist"]),
        time: pickNum(o, ["time", "duration", "lapTime", "totalTime"]),
        hr: pickNum(o, ["avgHr", "avgHeartRate", "heartRate", "avgHR"]),
      }));
    } else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object") stack.push(...Object.values(v));
  }
  // テキスト：ラップごとのブロック
  if (!raws.length && typeof data === "string") {
    for (const b of data.split(/\n(?=\s*(?:Lap\s*\d+|#?\d+[.:)]\s))/i)) {
      const dist = b.match(/Distance:\s*([\d.,]+)\s*(km|m)?/i);
      const time = b.match(/(?:Time|Duration):\s*([\d:.]+)/i);
      if (!dist || !time) continue;
      const km = Number(dist[1].replace(/,/g, "")) / (dist[2]?.toLowerCase() === "m" ? 1000 : 1);
      raws.push({ distance: km, time: parseDuration(time[1].split(".")[0]), hr: num(b.match(/(?:Avg\.? ?HR|Avg(?:erage)? Heart Rate):\s*(\d+)/i)?.[1]) });
    }
  }
  raws = raws.filter((r) => r.distance && r.distance > 0 && r.time && r.time > 0);
  if (raws.length < 3) return [];
  // 単位合わせ：合計が活動全体に近くなる 10 のべき乗を選ぶ
  const fit = (sum: number, total: number) => {
    let best = 1;
    for (const k of [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1, 10, 100, 1000]) if (Math.abs(Math.log(sum * k / total)) < Math.abs(Math.log(sum * best / total))) best = k;
    return best;
  };
  const dk = fit(raws.reduce((s, r) => s + r.distance!, 0), totalKm);
  const tk = fit(raws.reduce((s, r) => s + r.time!, 0), totalS);
  const laps = raws.map((r, i) => ({ index: i + 1, distanceKm: r.distance! * dk, durationS: r.time! * tk, avgHr: r.hr && r.hr > 40 && r.hr < 230 ? r.hr : undefined }));
  // 合計が活動と大きくずれるなら信用しない
  const sumKm = laps.reduce((s, l) => s + l.distanceKm, 0);
  return Math.abs(sumKm / totalKm - 1) < 0.15 ? laps : [];
}
