// 日々の記録と実績から計画を自動で調整する（ルールベース）。
//
// 安全原則（CLAUDE.md 5.4）
//  - 休んだ分を一度に詰め込まない：組み直すのは週に1回まで、できなかった練習は7割に短縮
//  - 週の総負荷を急に増やさない：週の距離は「直近8週の多かった4週の平均×1.2」か「前週×1.2」まで、ロング走は最近の最長距離＋6kmまで
//  - 高強度を2日続けない
//  - 数日（5日以上）空いた後は、次の2回は強度を上げずに戻す
// 体調：疲労→以降の負荷を下げる／痛み→強度を上げず休養・受診を促す／負荷比・回復状況も見る
import type { Activity } from "../coros/parse.ts";
import { isRun, isStrength } from "../coros/parse.ts";
import type { Ability } from "./ability.ts";
import { addDays, daysBetween, isWeekendOrHoliday, mondayOf, weekday } from "./calendar.ts";
import {
  expectedPaceRange, isKey, jog, scaleSession, stepsKm, subsFor, type DayPlan, type PlanOptions, type Session,
} from "./generate.ts";
import { fmtPace } from "./vdot.ts";

export type SkipReason = "schedule" | "fatigue" | "pain";
export const REASON_JA: Record<SkipReason, string> = { schedule: "予定", fatigue: "疲労", pain: "痛み" };

export interface DayLog {
  status: "off" | "skipped" | "ran" | null; // off=走る予定はない（事前）/ skipped=走らなかった / ran=走った（手動）
  reason?: SkipReason | null;
  km?: number | null;
  choice?: number | null;
}

export interface AchievementSettings {
  distPct: number; // この割合以上の距離で達成
  paceTolS: number; // 目安ペースの範囲から ±この秒数以内で達成
}
export const DEFAULT_SETTINGS: AchievementSettings = { distPct: 90, paceTolS: 10 };

export interface Achievement {
  level: "achieved" | "partial" | "missed" | "done";
  distPct?: number;
  avgPace?: string;
  expected?: string;
  flags: ("short" | "fast" | "slow")[];
}

export interface DayResult {
  state: "ran" | "ran_manual" | "extra" | "off" | "skipped" | "auto_skipped" | "rest";
  reason?: SkipReason | null;
  achievement?: Achievement;
}

const OPTIONAL_LOAD_LIMIT = 1.3;
const DOWNGRADE_LOAD_LIMIT = 1.5;
const LOW_RECOVERY = 40; // 回復がこれ未満なら今日の高強度を軽くする
const COMEBACK_GAP_DAYS = 5; // 通常の間隔（水→土で3日）より長く空いたら
const SKIPPED_FACTOR = 0.7;

const mmdd = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 実績を計画と照合する */
export function evaluate(session: Session, runs: Activity[], st: AchievementSettings): Achievement {
  const km = runs.reduce((s, r) => s + r.distanceKm, 0);
  const sec = runs.reduce((s, r) => s + r.durationS, 0);
  const timeBased = session.steps.length === 1 && session.steps[0].kind === "training" && session.steps[0].timeS !== undefined;
  const plannedSec = timeBased ? (session.steps[0] as { timeS: number }).timeS : 0;
  const distPct = Math.round((timeBased ? sec / plannedSec : km / session.distanceKm) * 100);
  const [fast, slow] = expectedPaceRange(session.steps);
  const avg = km > 0 ? sec / km : 0;
  const flags: Achievement["flags"] = [];
  if (distPct < st.distPct) flags.push("short");
  if (avg && avg < fast - st.paceTolS) flags.push("fast");
  if (avg && avg > slow + st.paceTolS) flags.push("slow");
  const level = distPct < 50 ? "missed" : flags.includes("short") || (session.hard && flags.includes("slow")) ? "partial" : "achieved";
  return {
    level,
    distPct,
    avgPace: avg ? fmtPace(avg) : undefined,
    expected: `${fmtPace(fast)}〜${fmtPace(slow)}`,
    flags,
  };
}

const easy = (a: Ability, s: Session, maxKm: number, title?: string): Session => jog(a, Math.min(Math.max(s.distanceKm, 3), maxKm), title);

export function adjustPlan(base: DayPlan[], a: Ability, activities: Activity[], opts: PlanOptions) {
  const today = opts.today;
  const logs = opts.logs ?? {};
  const st = opts.settings ?? DEFAULT_SETTINGS;
  const runs = activities.filter(isRun);
  const runsOn = (d: string) => runs.filter((r) => r.date === d);
  const byDate = new Map(base.map((d) => [d.date, d]));
  const alerts: { level: "info" | "warn"; text: string }[] = [];

  // 1. 記録・選択を反映し、過去（と今日）の結果を出す
  for (const day of base) {
    if (day.strength) day.strength.done = activities.some((a) => a.date === day.date && isStrength(a));
    const log = logs[day.date] ?? null;
    day.log = log;
    day.choice = log?.choice ?? -1;
    const chosen = (day.choice >= 0 && day.subs[day.choice]) || day.main;
    const ran = runsOn(day.date);
    if (day.date > today) continue;
    const beforeStart = !!opts.planStart && day.date < opts.planStart;
    if (ran.length && beforeStart) {
      day.result = { state: "extra" }; // 使い始める前の活動は達成度を判定しない
    } else if (ran.length) {
      day.result = chosen ? { state: "ran", achievement: evaluate(chosen, ran, st) } : { state: "extra" };
    } else if (log?.status === "ran") {
      day.result = { state: "ran_manual", achievement: { level: "done", flags: [] } };
    } else if (log?.status === "off") {
      day.result = { state: "off" };
    } else if (log?.status === "skipped") {
      day.result = { state: "skipped", reason: log.reason ?? null };
    } else if (day.date < today && day.main && !day.optional && !beforeStart) {
      day.result = { state: "auto_skipped" }; // 未入力のまま過ぎた日は「走らなかった」扱い
    } else if (day.date < today) {
      day.result = { state: "rest" };
    }
  }

  const todayDone = !!byDate.get(today)?.result && byDate.get(today)!.result!.state !== "rest";
  const future = base.filter((d) => d.date > today || (d.date === today && !todayDone));
  const isFuture = (d: DayPlan) => future.includes(d);
  const changed = new Set<DayPlan>();
  const set = (d: DayPlan, s: Session | null, note?: string) => {
    d.main = s;
    if (note && !d.notes.includes(note)) d.notes.push(note);
    changed.add(d);
  };

  // 2. 体調モード
  // 痛み：COROS からは分からないので、利用者の「痛みがある」ボタン（opts.painSince）だけで判断する
  // 疲労：COROS の負荷比・回復状況から判断する（手入力はしない）
  const lastPain = opts.painSince ?? null;
  const pain = !!lastPain && lastPain <= today;
  const fatigue = !pain && ((opts.loadRatio ?? 0) > DOWNGRADE_LOAD_LIMIT || (opts.recoveryPercent ?? 100) < LOW_RECOVERY);
  const ranDates = [...runs.map((r) => r.date), ...Object.entries(logs).filter(([, l]) => l.status === "ran").map(([d]) => d)]
    .filter((d) => d <= today)
    .sort();
  const lastRun = ranDates.at(-1);
  const comeback = !pain && !!lastRun && daysBetween(lastRun, todayDone ? addDays(today, 1) : today) >= COMEBACK_GAP_DAYS;

  if (pain) {
    const days = daysBetween(lastPain!, today) + 1;
    alerts.push({
      level: "warn",
      text:
        days > 7
          ? `痛みがある状態が${days}日続いています。強度を上げずに休養を優先しています。1週間以上続く痛みは、医療機関を受診してください。`
          : "痛みがあるので、強度を上げずに休養を優先しています。痛みが続く・強くなるときは無理をせず医療機関を受診してください。",
    });
  } else if (fatigue) alerts.push({ level: "info", text: "COROS の負荷比・回復状況から疲れがたまっていると判断し、数日は負荷を下げています。" });
  if (comeback) alerts.push({ level: "info", text: `${daysBetween(lastRun!, today)}日空いたので、強度を上げずに軽めから戻します。` });

  // 3. 「走る予定はない」日は休みにする（あとで組み直す）
  const missed: { day: DayPlan; factor: number }[] = [];
  for (const d of future) {
    if (d.log?.status === "off") {
      if (isKey(d.main)) missed.push({ day: d, factor: 1 });
      set(d, null, "走る予定なしの日");
    }
  }
  // 今週の過去で、できなかった大事な練習
  const weekStart = mondayOf(today);
  for (const d of base) {
    if (d.date < weekStart || d.date >= today || !isKey(d.planned)) continue;
    if (d.result?.state === "off") missed.push({ day: d, factor: 1 });
    if (d.result?.state === "skipped" || d.result?.state === "auto_skipped") missed.push({ day: d, factor: SKIPPED_FACTOR });
  }

  const hardAt = (date: string): boolean => {
    const d = byDate.get(date);
    if (!d) return false;
    if (d.date < today || (d.date === today && todayDone)) {
      return d.result?.state === "ran" && !!d.planned?.hard && d.result.achievement?.level !== "missed";
    }
    return !!d.main?.hard;
  };

  // 4. 痛み：最初の2日は休養、その後も短いジョグだけ
  if (pain) {
    for (const d of future) {
      if (!d.main) continue;
      const within2 = daysBetween(lastPain!, d.date) <= 2;
      if (within2) set(d, null, "痛いのに走るなんて許さないわよ。今日はしっかり休みなさい");
      else set(d, easy(a, d.main, 5, "様子見ジョグ"), "様子見のジョグよ。少しでも痛んだらすぐやめること。いいわね？");
    }
  } else {
    // 5. 組み直し（週に1回まで。大事な順：距離 → ペース → スピード）
    if (!fatigue && !comeback && missed.length) {
      const order = { distance: 0, pace: 1, speed: 2, jog: 3, race: 4 } as const;
      const m = missed.sort((x, y) => order[x.day.planned!.category] - order[y.day.planned!.category])[0];
      const src = m.day.planned!;
      const moved = m.factor < 1 ? scaleSession(src, m.factor) : src;
      const long = src.category === "distance" || moved.distanceKm >= 12;
      const sunday = addDays(weekStart, 6);
      const slot = future.find(
        (d) =>
          d.date > m.day.date &&
          d.date <= sunday &&
          weekday(d.date) !== 4 &&
          d.log?.status !== "off" &&
          (!d.main || (!d.main.hard && d.main.category === "jog")) &&
          (!long || isWeekendOrHoliday(d.date)) &&
          (!moved.hard || (!hardAt(addDays(d.date, -1)) && !hardAt(addDays(d.date, 1)))),
      );
      if (slot) {
        set(slot, moved, m.factor < 1
            ? `${mmdd(m.day.date)}の「${src.title}」、少し短くしてここに移しといたわ。取り返すのは一部だけ、欲張っちゃダメよ`
            : `${mmdd(m.day.date)}の「${src.title}」はここに移しといたわ。予定があるなら仕方ないものね`);
        slot.optional = false;
      } else {
        const t = future[0];
        if (t) t.notes.push(`${mmdd(m.day.date)}の「${src.title}」は今回は見送りよ。詰め込んで故障なんて、あたしが許さないんだから`);
      }
    }

    // 6. 疲労：直近7日の高強度を軽く、ロング走は8割
    if (fatigue) {
      for (const d of future.filter((x) => daysBetween(today, x.date) < 7)) {
        if (!d.main?.hard || d.main.category === "race") continue;
        if (d.main.category === "distance") set(d, scaleSession(d.main, 0.8), "疲れてるんでしょ？ 今日は8割で十分よ");
        else set(d, easy(a, d.main, 8), "疲れてるなら今日はジョグにしなさい。無理は禁止！");
      }
    }

    // 7. 数日空いた後：次の2回は強度を上げない
    if (comeback) {
      for (const d of future.filter((x) => x.main && !x.optional).slice(0, 2)) {
        if (d.main!.hard && d.main!.category !== "race") set(d, easy(a, d.main!, 10), "久しぶりなんだから、いきなり飛ばすのは禁止よ。軽めから戻すの");
      }
    }

    // 8. ロング走は「最近の最長距離＋6km」まで（予定どおり走れた前提で先の週も見積もる）
    for (const d of future) {
      if (!d.main || d.main.category === "race" || d.main.distanceKm <= 12) continue;
      const since = addDays(d.date, -21);
      // 大会（42km）も「長く走れた」証拠として数える（ただし 30km 相当まで）
      const actual = runs.filter((r) => r.date >= since && r.date < d.date && r.date <= today).map((r) => Math.min(r.distanceKm, 30));
      const planned = future.filter((x) => x.date >= since && x.date < d.date && x.main).map((x) => Math.min(x.main!.distanceKm, 30));
      const recent = Math.max(0, ...actual, ...planned);
      const cap = Math.max(12, recent + 6);
      if (d.main.distanceKm > cap + 0.5) {
        set(d, scaleSession(d.main, cap / d.main.distanceKm), `最近の最長は${recent}kmでしょ？ いきなり伸ばしすぎないよう、ちょっと短くしといたわ`);
      }
    }

    // 9. 週の距離が急に増えないように（今週・来週）。大会（40km以上）は練習量に数えない
    const trainKm = (rs: Activity[]) => rs.filter((r) => r.distanceKm < 40).reduce((x, r) => x + r.distanceKm, 0);
    const weekKm = (mon: string, useActual: boolean) =>
      base
        .filter((d) => d.date >= mon && d.date < addDays(mon, 7))
        .reduce((s, d) => {
          if (useActual && (d.date < today || (d.date === today && todayDone))) return s + trainKm(runsOn(d.date));
          return s + (d.main && !d.optional && d.main.category !== "race" ? d.main.distanceKm : 0);
        }, 0);
    const actualWeekKm = (mon: string) => trainKm(runs.filter((r) => r.date >= mon && r.date < addDays(mon, 7)));
    for (const mon of [weekStart, addDays(weekStart, 7)]) {
      const prevMon = addDays(mon, -7);
      const prev = mon === weekStart ? actualWeekKm(prevMon) : weekKm(prevMon, true);
      // 基準は「直近8週のうち多かった4週の平均」。回復週・調整週で基準が下がりすぎないように
      const last8 = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => actualWeekKm(addDays(weekStart, -7 * i))).sort((x, y) => y - x);
      const best4 = last8.slice(0, 4).reduce((x, y) => x + y, 0) / 4;
      const cap = Math.max(best4 * 1.2, prev * 1.2, 20);
      const total = weekKm(mon, true);
      if (total <= cap + 0.5) continue;
      const key = future
        .filter((d) => d.date >= mon && d.date < addDays(mon, 7) && d.main && d.main.category !== "race" && d.main.distanceKm > 8)
        .sort((x, y) => y.main!.distanceKm - x.main!.distanceKm)[0];
      if (!key) continue;
      const f = Math.max(0.7, (key.main!.distanceKm - (total - cap)) / key.main!.distanceKm);
      if (f < 0.97) set(key, scaleSession(key.main!, f), `今週は距離が増えすぎね。${Math.round(cap)}kmくらいに収まるよう、少し削っといたわ`);
    }

    // 10. 負荷比・回復状況
    if (opts.loadRatio != null && opts.loadRatio > DOWNGRADE_LOAD_LIMIT) {
      for (const d of future.filter((x) => daysBetween(today, x.date) < 7)) {
        if (d.main?.hard && d.main.category !== "race") set(d, easy(a, d.main, 8), `負荷比${opts.loadRatio.toFixed(2)}って、張り切りすぎよ。今は軽めのジョグにしなさい`);
      }
    }
    const t = future[0];
    if (t?.date === today && t.main?.hard && t.main.category !== "race" && opts.recoveryPercent != null && opts.recoveryPercent < LOW_RECOVERY) {
      set(t, easy(a, t.main, 8), `回復${opts.recoveryPercent}%じゃまだまだね。今日は軽めにしときなさい`);
    }
  }

  // 補強：痛み・疲れのときはお休み（できなかった補強は取り返さない）
  for (const d of future) {
    if (!d.strength || d.strength.done) continue;
    if (pain) d.strength = { ...d.strength, skipped: "痛みがある間は補強もお休み" };
    else if (fatigue) d.strength = { ...d.strength, skipped: "疲れがたまっているので補強はお休み" };
  }

  // 11. 任意ジョグは「余裕のある週」だけ
  const lastWeekMissedKey = base.some(
    (d) => d.date >= addDays(weekStart, -7) && d.date < weekStart && isKey(d.planned) && ["skipped", "auto_skipped"].includes(d.result?.state ?? ""),
  );
  const noRoom = pain || fatigue || comeback || lastWeekMissedKey || (opts.loadRatio != null && opts.loadRatio > OPTIONAL_LOAD_LIMIT);
  for (const d of future) {
    if (d.optional && noRoom) {
      d.optional = false;
      set(d, null);
    }
  }

  // 12. 高強度を2日続けない
  for (const d of future) {
    if (d.main?.hard && d.main.category !== "race" && hardAt(addDays(d.date, -1))) {
      set(d, easy(a, d.main, 6), "昨日きつい練習したばっかりでしょ。今日は軽めよ");
    }
  }

  // 13. 前回の結果をふまえたひと言・調整
  const pastRuns = base.filter((d) => d.date < today && d.result?.state === "ran" && d.result.achievement);
  const lastQuality = [...pastRuns].reverse().find((d) => d.planned && (d.planned.category === "speed" || d.planned.category === "pace"));
  if (!pain && lastQuality?.result?.achievement?.level === "partial" && daysBetween(lastQuality.date, today) <= 10) {
    const next = future.find((d) => d.main && (d.main.category === "speed" || d.main.category === "pace") && d.main.hard);
    if (next) set(next, scaleSession(next.main!, 0.85), `この前の「${lastQuality.planned!.title}」はちょっとバテてたわね。今回は少し短めにしてあげる`);
  }
  const lastEasy = [...pastRuns].reverse().find((d) => d.planned && !d.planned.hard);
  if (lastEasy?.result?.achievement?.flags.includes("fast") && daysBetween(lastEasy.date, today) <= 7) {
    const next = future.find((d) => d.main && !d.main.hard);
    if (next) next.notes.push(`この前のジョグ、${lastEasy.result.achievement.avgPace}/kmって速すぎ！ ジョグはのんびり走るものなの。分かった？`);
  }
  const lastKey = [...pastRuns].reverse().find((d) => isKey(d.planned));
  if (lastKey?.result?.achievement?.level === "achieved" && daysBetween(lastKey.date, today) <= 3 && future[0]) {
    future[0].notes.unshift(`${mmdd(lastKey.date)}の「${lastKey.planned!.title}」、ちゃんとやりきったじゃない！ やるわね`);
  }

  // 調整した日は気分の練習を作り直す（選択はリセット）
  for (const d of changed) {
    d.subs = d.main ? subsFor(d.main, a) : [];
    if (d.choice >= d.subs.length) d.choice = -1;
    if (d.main) d.main = { ...d.main, distanceKm: d.main.distanceKm || stepsKm(d.main.steps) };
  }

  const idx = base.findIndex((d) => d.date === today);
  return {
    past: base.slice(0, Math.max(idx, 0)),
    days: idx >= 0 ? base.slice(idx) : [],
    alerts,
    modes: { pain, fatigue, comeback },
  };
}
