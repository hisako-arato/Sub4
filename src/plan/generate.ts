// 練習計画の生成（ルールベース）。
// 基本は週3回（月・水・週末）。土日祝に長い／きつい練習、平日は短め・軽め。
// 余裕のある週だけ「任意の4回目ジョグ」を出す（金曜は使わない）。
import type { Activity } from "../coros/parse.ts";
import { isRun } from "../coros/parse.ts";
import type { Ability } from "./ability.ts";
import {
  addDays, HOLIDAYS, isHoliday, mondayOf, PHASE_JA, RACE_DATE, weekday, weekSpecFor, WEEKDAY_JA, type Phase, type WeekSpec,
} from "./calendar.ts";
import { fmtPace } from "./vdot.ts";
import { adjustPlan, type AchievementSettings, type DayLog, type DayResult } from "./adjust.ts";

export type Category = "speed" | "pace" | "distance" | "jog" | "race";

export interface Session {
  category: Category;
  title: string;
  distanceKm: number;
  pace: string; // 表示用 "5:40/km" や "6:03〜6:39/km"
  menu: string[];
  hard: boolean;
  steps: Step[]; // 時計に送るための構造（ペースは秒/km の [速い側, 遅い側]）
}

export type Step =
  | { kind: "warmup" | "training" | "recovery" | "cooldown"; distanceM?: number; timeS?: number; pace: [number, number] }
  | { kind: "repeat"; times: number; steps: Step[] };

/** 目標ペース ±5秒 */
const around = (t: number): [number, number] => [Math.round(t - 5), Math.round(t + 5)];
const WALK = 1499; // COROS が受け付ける最も遅いペース
const dist = (kind: "warmup" | "training" | "recovery" | "cooldown", km: number, pace: [number, number]): Step =>
  ({ kind, distanceM: Math.round(km * 1000), pace: [Math.round(pace[0]), Math.round(pace[1])] });
const time = (kind: "warmup" | "training" | "recovery" | "cooldown", sec: number, pace: [number, number]): Step =>
  ({ kind, timeS: Math.round(sec), pace: [Math.round(pace[0]), Math.round(pace[1])] });

export interface DayPlan {
  date: string;
  planned: Session | null; // 調整前の練習（達成度の判定・組み直しに使う）
  choice: number; // 選んだ気分の練習（-1 はメイン）
  log: DayLog | null;
  result: DayResult | null; // 過去と今日の結果
  weekday: string;
  holiday?: string;
  phase: Phase | null;
  phaseLabel: string | null;
  main: Session | null; // null は休養
  subs: Session[]; // 気分で選べる代わりの練習
  optional: boolean; // 任意の4回目ジョグ
  notes: string[]; // 調整の理由（コーチのひと言の材料）
  actual: { distanceKm: number; durationS: number; avgHr?: number; title: string }[];
}

export interface PlanOptions {
  today: string;
  days?: number;
  loadRatio?: number | null; // COROS のトレーニング負荷比（短期/長期）
  recoveryPercent?: number | null;
  logs?: Record<string, DayLog>;
  settings?: AchievementSettings;
  painClearedAt?: string | null;
  planStart?: string | null; // アプリを使い始めた日。これより前は「走らなかった」と判定しない
}

const OPTIONAL_LOAD_LIMIT = 1.3; // これ以下なら4回目ジョグを出す

const range = (p: [number, number]) => `${fmtPace(p[0])}〜${fmtPace(p[1])}/km`;
const r1 = (n: number) => Math.round(n * 10) / 10;

function jog(a: Ability, km: number, title = "ジョグ"): Session {
  return {
    category: "jog", title, distanceKm: km, pace: range(a.paces.jog), menu: [`${km}km を会話できる楽さで`], hard: false,
    steps: [dist("training", km, a.paces.jog)],
  };
}

function weekendSession(spec: WeekSpec, a: Ability): Session {
  const p = a.paces;
  const k = spec.key;
  if (k.kind === "jog") return jog(a, k.km, "ゆったりジョグ");
  if (k.kind === "long") {
    return {
      category: "distance",
      title: k.km >= 30 ? "30km走" : "ロング走",
      distanceKm: k.km,
      pace: range(p.long),
      menu: [`${k.km}km を一定のペースで`, k.km >= 20 ? "5kmごとに給水・補給の練習も" : "最後まで余裕を残して終える"],
      hard: k.km >= 16,
      steps: [dist("training", k.km, p.long)],
    };
  }
  if (k.kind === "mp") {
    const mp = spec.phase === "build" ? p.mpBuild : p.mpPeak;
    return {
      category: "pace",
      title: "マラソンペース走",
      distanceKm: k.km + 4,
      pace: `${fmtPace(mp)}/km`,
      menu: ["アップ 2km ジョグ", `${k.km}km を ${fmtPace(mp)}/km で`, "ダウン 2km ジョグ"],
      hard: true,
      steps: [dist("warmup", 2, p.jog), dist("training", k.km, around(mp)), dist("cooldown", 2, p.jog)],
    };
  }
  return {
    category: "race",
    title: "静岡マラソン",
    distanceKm: 42.2,
    pace: `${fmtPace(p.goal)}/km`,
    menu: [`前半は ${fmtPace(p.goal + 5)}/km で入り、30km まで我慢`, "30km 以降に余力があれば少しずつ上げる", "サブ4 達成のタイム目安：中間点 1:59:30"],
    hard: true,
    steps: [dist("training", 42.195, around(p.goal))],
  };
}

function wedSession(spec: WeekSpec, a: Ability): Session {
  const p = a.paces;
  switch (spec.wed) {
    case "jog":
      return jog(a, 5);
    case "strides":
      return {
        ...jog(a, 6, "ジョグ＋流し"),
        menu: ["6km ジョグ", "最後に 100m の流し × 5（全力の8割、間は歩き）"],
        steps: [
          dist("training", 6, p.jog),
          { kind: "repeat", times: 5, steps: [dist("training", 0.1, [p.interval - 20, p.interval]), time("recovery", 60, [p.jog[1], WALK])] },
        ],
      };
    case "buildup":
      return {
        category: "pace",
        title: "ビルドアップ走",
        distanceKm: 8,
        pace: `${fmtPace(p.jog[1])}→${fmtPace(p.mpBuild)}/km`,
        menu: ["8km を 2km ごとに少しずつペースアップ", `最後の 2km は ${fmtPace(p.mpBuild)}/km`],
        hard: true,
        steps: [0, 1, 2, 3].map((i) => dist("training", 2, around(p.jog[1] + ((p.mpBuild - p.jog[1]) * i) / 3))),
      };
    case "interval": {
      const n = spec.intervalReps ?? 5;
      return {
        category: "speed",
        title: "インターバル",
        distanceKm: r1(4 + n * 1.4),
        pace: `${fmtPace(p.interval)}/km`,
        menu: ["アップ 2km ジョグ", `1000m × ${n}本（${fmtPace(p.interval)}/km、間は 400m ジョグ）`, "ダウン 2km ジョグ"],
        hard: true,
        steps: [
          dist("warmup", 2, p.jog),
          { kind: "repeat", times: n, steps: [dist("training", 1, around(p.interval)), dist("recovery", 0.4, [p.jog[1], WALK])] },
          dist("cooldown", 2, p.jog),
        ],
      };
    }
    case "tempo": {
      const m = spec.tempoMin ?? 20;
      return {
        category: "pace",
        title: "閾値走",
        distanceKm: r1(4 + (m * 60) / p.tempo),
        pace: `${fmtPace(p.tempo)}/km`,
        menu: ["アップ 2km ジョグ", `${m}分 を ${fmtPace(p.tempo)}/km（きついけど続けられる強さ）`, "ダウン 2km ジョグ"],
        hard: true,
        steps: [dist("warmup", 2, p.jog), time("training", m * 60, around(p.tempo)), dist("cooldown", 2, p.jog)],
      };
    }
    case "sharpen":
      return {
        category: "pace",
        title: "刺激入れ",
        distanceKm: 7,
        pace: `${fmtPace(p.goal)}/km`,
        menu: ["アップ 2km ジョグ", `2km × 2（${fmtPace(p.goal)}/km、間 3分ジョグ）`, "ダウン 1km ジョグ", "脚を使い切らない"],
        hard: false,
        steps: [
          dist("warmup", 2, p.jog),
          { kind: "repeat", times: 2, steps: [dist("training", 2, around(p.goal)), time("recovery", 180, [p.jog[1], WALK])] },
          dist("cooldown", 1, p.jog),
        ],
      };
  }
}

function monKm(spec: WeekSpec): number {
  const base: Record<Phase, number> = { recovery: 4, base: 6, build: 7, peak: 8, taper: 6, race: 5 };
  return base[spec.phase] - (spec.down ? 1 : 0);
}

/** ファルトレク：アップ・ダウン以外は「インターバルのペース〜ジョグ」の幅で自由に */
function fartlek(totalKm: number, a: Ability): Step[] {
  const p = a.paces;
  return [dist("warmup", 2, p.jog), dist("training", Math.max(totalKm - 4, 2), [p.interval, p.jog[1]]), dist("cooldown", 2, p.jog)];
}

/** メイン練習と同じくらいの負荷で、気分で選べる代わりの練習 */
function subsFor(main: Session, a: Ability): Session[] {
  const p = a.paces;
  if (main.category === "race") return [];
  if (main.category === "distance") {
    const min = Math.round((main.distanceKm * (p.long[0] + p.long[1])) / 2 / 60 / 10) * 10;
    return [
      { ...main, title: "旅ラン", menu: [`知らない町や景色のよい道で ${main.distanceKm}km`, "写真休憩OK・ペースは気にしない"], hard: main.hard },
      {
        ...main, title: "LSD（時間走）", pace: `${fmtPace(p.long[1])}/km より遅くてOK`, menu: [`距離ではなく ${min}分 走り続ける`],
        steps: [time("training", min * 60, [p.long[1], p.long[1] + 60])],
      },
    ];
  }
  if (main.category === "pace") {
    return [
      { ...main, title: "景色のよいコースでペース走", menu: [...main.menu, "川沿い・海沿いなど気持ちのいい道で"] },
      {
        ...main, title: "ファルトレク", pace: "気分で緩急", menu: [`${main.distanceKm}km の間に、電柱・信号・曲がり角を目印に速い／ゆっくりを自由に`],
        steps: fartlek(main.distanceKm, a),
      },
    ];
  }
  if (main.category === "speed") {
    return [
      { ...main, title: "ファルトレク", pace: "気分で緩急", menu: ["アップ 2km", "1〜3分の速い区間 × 6〜8（目印は自由）", "ダウン 2km"], steps: fartlek(main.distanceKm, a) },
      {
        ...main, title: "坂ダッシュ", pace: "坂を力強く", menu: ["アップ 2km", "60〜80m の上り坂ダッシュ × 8（下りは歩き）", "ダウン 2km"],
        steps: [
          dist("warmup", 2, p.jog),
          { kind: "repeat", times: 8, steps: [dist("training", 0.07, [p.interval - 30, p.interval]), time("recovery", 90, [p.jog[1], WALK])] },
          dist("cooldown", 2, p.jog),
        ],
      },
    ];
  }
  return [
    { ...main, title: "寄り道ジョグ", menu: [`気になるお店や公園まで ${main.distanceKm}km くらい`] },
    { ...main, title: "音楽ジョグ", menu: ["好きなアルバム1枚ぶん、気ままに"] },
  ];
}

interface WeekPlan {
  sessions: Map<string, { main: Session; optional: boolean; notes: string[] }>;
}

function pickWeekendDay(a: Ability): 5 | 6 {
  const c = a.history.longRunWeekdayCounts;
  return c[6] > c[5] ? 6 : 5;
}

function pickOptionalDay(monday: string, weekendDay: number, a: Ability): number {
  const otherWeekend = weekendDay === 5 ? 6 : 5;
  // 木・火・もう一方の週末（金曜は使わない）。翌日が祝日（＝長めの練習）になる日は避ける
  const candidates = [3, 1, otherWeekend].filter((d) => !isHoliday(addDays(monday, d + 1)));
  const holiday = candidates.find((d) => isHoliday(addDays(monday, d)));
  if (holiday !== undefined) return holiday;
  const c = a.history.weekdayCounts;
  return candidates.reduce((best, d) => (c[d] > c[best] ? d : best), candidates[0]);
}

function buildWeek(spec: WeekSpec, a: Ability, loadRatio: number | null | undefined): WeekPlan {
  const sessions: WeekPlan["sessions"] = new Map();
  const at = (d: number) => addDays(spec.monday, d);
  const weekendDay = spec.key.kind === "race" ? 6 : pickWeekendDay(a);

  // 月
  let mon = jog(a, monKm(spec));
  const monNotes: string[] = [];
  if (isHoliday(at(0)) && spec.phase !== "recovery") {
    const km = Math.max(mon.distanceKm + 4, 10);
    mon = {
      category: "distance", title: "ミドル走", distanceKm: km, pace: range(a.paces.jog), menu: [`祝日なので少し長めに ${km}km`], hard: false,
      steps: [dist("training", km, a.paces.jog)],
    };
    monNotes.push(`${HOLIDAYS[at(0)]}なので月曜を少し長めにしたよ`);
  }
  sessions.set(at(0), { main: mon, optional: false, notes: monNotes });

  // 水
  sessions.set(at(2), { main: wedSession(spec, a), optional: false, notes: [] });

  // 週末
  if (spec.key.kind === "race") {
    const pre: Session = {
      ...jog(a, 3, "前日ジョグ"),
      menu: ["3km ジョグ＋流し × 2", "早めに寝る"],
      steps: [
        dist("training", 3, a.paces.jog),
        { kind: "repeat", times: 2, steps: [dist("training", 0.1, [a.paces.goal - 30, a.paces.goal]), time("recovery", 60, [a.paces.jog[1], WALK])] },
      ],
    };
    sessions.set(at(5), { main: pre, optional: false, notes: [] });
  }
  sessions.set(at(weekendDay), {
    main: weekendSession(spec, a),
    optional: false,
    notes: spec.down ? ["今週は疲れを抜く軽めの週"] : [],
  });

  // 任意の4回目ジョグ（余裕のある週だけ）
  const roomy = !spec.down && (spec.phase === "base" || spec.phase === "build" || spec.phase === "peak");
  const loadOk = loadRatio == null || loadRatio <= OPTIONAL_LOAD_LIMIT;
  if (roomy && loadOk) {
    const d = pickOptionalDay(spec.monday, weekendDay, a);
    const km = spec.phase === "peak" ? 6 : 5;
    sessions.set(at(d), {
      main: { ...jog(a, km, "任意ジョグ"), menu: [`余裕があれば ${km}km`, "走らなくても計画には影響しない"] },
      optional: true,
      notes: [],
    });
  }
  return { sessions };
}

/** 計画のもと（調整前）を from〜to で作る */
export function buildBaseDays(a: Ability, activities: Activity[], from: string, to: string, loadRatio: number | null | undefined): DayPlan[] {
  const weekCache = new Map<string, WeekPlan | null>();
  const runsByDate = new Map<string, Activity[]>();
  for (const act of activities.filter(isRun)) runsByDate.set(act.date, [...(runsByDate.get(act.date) ?? []), act]);
  const getWeek = (date: string) => {
    const mon = mondayOf(date);
    if (!weekCache.has(mon)) {
      const spec = weekSpecFor(date);
      weekCache.set(mon, spec ? buildWeek(spec, a, loadRatio) : null);
    }
    return weekCache.get(mon)!;
  };
  const out: DayPlan[] = [];
  for (let date = from; date <= to && date <= RACE_DATE; date = addDays(date, 1)) {
    const spec = weekSpecFor(date);
    const entry = getWeek(date)?.sessions.get(date);
    const main = entry?.main ?? null;
    out.push({
      date,
      weekday: WEEKDAY_JA[weekday(date)],
      holiday: HOLIDAYS[date],
      phase: spec?.phase ?? null,
      phaseLabel: spec ? PHASE_JA[spec.phase] + (spec.down ? "（軽めの週）" : "") : null,
      main,
      planned: main,
      subs: main ? subsFor(main, a) : [],
      optional: !!entry?.optional,
      notes: [...(entry?.notes ?? [])],
      actual: (runsByDate.get(date) ?? []).map((r) => ({ distanceKm: r.distanceKm, durationS: r.durationS, avgHr: r.avgHr, title: r.title })),
      choice: -1,
      log: null,
      result: null,
    });
  }
  return out;
}

// ---- 調整で使う部品 ----

/** 練習が「大事な練習」（休んだら組み直す対象）か */
export const isKey = (s: Session | null) => !!s && s.category !== "race" && (s.hard || (s.category === "distance" && s.distanceKm >= 12));

type Plain = Extract<Step, { pace: [number, number] }>;
const flat = (steps: Step[]): { step: Plain; times: number }[] =>
  steps.flatMap((st) => (st.kind === "repeat" ? st.steps.flatMap((x) => flat([x]).map((f) => ({ step: f.step, times: f.times * st.times }))) : [{ step: st, times: 1 }]));
const slowOf = (st: Plain) => Math.min(st.pace[1], st.pace[0] + 90); // 歩き（1499）はジョグ程度に見積もる
const kmOf = (st: Plain) => (st.distanceM !== undefined ? st.distanceM / 1000 : st.timeS! / ((st.pace[0] + slowOf(st)) / 2));

export function stepsKm(steps: Step[]): number {
  return r1(flat(steps).reduce((s, f) => s + kmOf(f.step) * f.times, 0));
}

/** 練習全体の平均ペースの見込み（速い側, 遅い側）秒/km */
export function expectedPaceRange(steps: Step[]): [number, number] {
  let km = 0, fast = 0, slow = 0;
  for (const f of flat(steps)) {
    const k = kmOf(f.step) * f.times;
    km += k;
    fast += f.step.pace[0] * k;
    slow += slowOf(f.step) * k;
  }
  return km ? [fast / km, slow / km] : [0, 0];
}

const paceText = (p: [number, number]) =>
  p[1] >= 1400 ? "歩き〜ジョグ" : Math.abs(p[1] - p[0]) <= 10 ? `${fmtPace((p[0] + p[1]) / 2)}/km` : `${fmtPace(p[0])}〜${fmtPace(p[1])}/km`;
const amount = (st: Plain) => (st.distanceM !== undefined ? (st.distanceM >= 1000 ? `${r1(st.distanceM / 1000)}km` : `${st.distanceM}m`) : `${Math.round(st.timeS! / 60)}分`);

/** 区間から説明文を作る */
export function describeSteps(steps: Step[]): string[] {
  return steps.map((st) => {
    if (st.kind === "repeat") {
      const [work, ...rest] = st.steps as Plain[];
      const rec = rest.length ? `（つなぎ ${amount(rest[0])}）` : "";
      return `${amount(work)} × ${st.times}本（${paceText(work.pace)}）${rec}`;
    }
    const label = st.kind === "warmup" ? "アップ " : st.kind === "cooldown" ? "ダウン " : "";
    return `${label}${amount(st)}（${paceText(st.pace)}）`;
  });
}

/** 練習を f 倍の量にする（アップ・ダウンはそのまま、繰り返しは本数を減らす） */
export function scaleSession(s: Session, f: number): Session {
  const steps: Step[] = s.steps.map((st) => {
    if (st.kind === "repeat") return { ...st, times: Math.max(2, Math.round(st.times * f)) };
    if (st.kind !== "training") return st;
    return st.distanceM !== undefined
      ? { ...st, distanceM: Math.max(1000, Math.round((st.distanceM * f) / 500) * 500) }
      : { ...st, timeS: Math.max(600, Math.round((st.timeS! * f) / 60) * 60) };
  });
  const km = stepsKm(steps);
  return {
    ...s,
    title: s.title.replace(/（短縮）$/, "") + "（短縮）",
    steps,
    distanceKm: km,
    menu: describeSteps(steps),
    hard: s.hard && (s.category !== "distance" || km >= 16),
  };
}

export { jog, subsFor };

export function generatePlan(a: Ability, activities: Activity[], opts: PlanOptions): DayPlan[] {
  return generateWithHistory(a, activities, opts).days;
}

/** 過去の記録を踏まえて調整した計画（先頭が今日）と、過去の結果 */
export function generateWithHistory(a: Ability, activities: Activity[], opts: PlanOptions) {
  const days = opts.days ?? 14;
  const from = addDays(mondayOf(opts.today), -7);
  const base = buildBaseDays(a, activities, from, addDays(opts.today, days - 1), opts.loadRatio);
  return adjustPlan(base, a, activities, opts);
}
