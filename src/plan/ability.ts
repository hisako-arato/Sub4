// 走力の把握：COROS の活動履歴と走力評価から自動で算出する（ユーザー入力なし）。
import { isRun, type Activity, type FitnessOverview } from "../coros/parse.ts";
import { addDays, daysBetween, mondayOf, RACE_KM, SUB4_SECONDS, weekday } from "./calendar.ts";
import { INTENSITY, paceAt, vdotFromRace } from "./vdot.ts";

export interface Ability {
  race: { date: string; km: number; timeS: number; paceS: number; avgHr?: number; vdot: number } | null;
  vdotRace: number | null;
  vdotPredicted: number | null;
  vdotSpeed: number; // スピード練習のペースに使う（控えめ）
  paces: {
    jog: [number, number]; // 秒/km（速い側, 遅い側）
    long: [number, number];
    mpBuild: number;
    mpPeak: number;
    tempo: number;
    interval: number;
    goal: number; // サブ4の平均ペース
  };
  history: {
    weeks: { monday: string; km: number; runs: number }[];
    avgWeeklyKm: number;
    avgRunsPerWeek: number;
    longestKm: number;
    weekdayCounts: number[]; // 月〜日の走った回数
    longRunWeekdayCounts: number[]; // 12km以上を走った曜日
  };
}

const SUB4_VDOT_FALLBACK = 38;

export function computeAbility(all: Activity[], fitness: FitnessOverview | null, today: string): Ability {
  const runs = all.filter(isRun).sort((a, b) => (a.date < b.date ? -1 : 1));

  // 直近120日のうち最新の 40km 以上を「大会」とみなす
  const raceAct = [...runs].reverse().find((a) => a.distanceKm >= 40 && daysBetween(a.date, today) <= 120);
  const race = raceAct
    ? {
        date: raceAct.date,
        km: raceAct.distanceKm,
        timeS: raceAct.durationS,
        paceS: raceAct.durationS / raceAct.distanceKm,
        avgHr: raceAct.avgHr,
        vdot: vdotFromRace(raceAct.distanceKm, raceAct.durationS),
      }
    : null;

  let vdotPredicted: number | null = null;
  if (fitness?.predictions.km10) vdotPredicted = vdotFromRace(10, fitness.predictions.km10);
  else if (fitness?.predictions.full) vdotPredicted = vdotFromRace(RACE_KM, fitness.predictions.full);

  const vdotRace = race?.vdot ?? null;
  // スピードは COROS の予測より 2 控えめ。ただし大会実績より遅くはしない
  const vdotSpeed =
    vdotPredicted !== null ? Math.max(vdotRace ?? 0, vdotPredicted - 2) : vdotRace !== null ? vdotRace + 2 : SUB4_VDOT_FALLBACK;

  const goal = SUB4_SECONDS / RACE_KM;
  const jogFast = paceAt(vdotSpeed, INTENSITY.easyFast);
  const jogSlow = paceAt(vdotSpeed, INTENSITY.easySlow);
  // ロング走は「持久力は実績ベース」：大会の実ペースより速くしない
  const longFast = Math.max(race?.paceS ?? jogFast, jogFast);

  // 履歴：大会の前（大会がなければ今日の前）の 8 週
  const end = mondayOf(race?.date ?? today);
  const weeks: { monday: string; km: number; runs: number }[] = [];
  const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
  const longRunWeekdayCounts = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 8; i >= 1; i--) {
    const mon = addDays(end, -7 * i);
    const inWeek = runs.filter((r) => r.date >= mon && r.date < addDays(mon, 7) && r !== raceAct);
    weeks.push({ monday: mon, km: round1(inWeek.reduce((s, r) => s + r.distanceKm, 0)), runs: inWeek.length });
    for (const r of inWeek) {
      weekdayCounts[weekday(r.date)]++;
      if (r.distanceKm >= 12) longRunWeekdayCounts[weekday(r.date)]++;
    }
  }
  const active = weeks.filter((w) => w.runs > 0);
  const longest = runs.filter((r) => r !== raceAct && daysBetween(r.date, today) <= 120).reduce((m, r) => Math.max(m, r.distanceKm), 0);

  return {
    race,
    vdotRace,
    vdotPredicted,
    vdotSpeed,
    paces: {
      jog: [jogFast, jogSlow],
      long: [longFast, Math.max(jogSlow, longFast + 25)],
      mpBuild: goal + 10,
      mpPeak: goal,
      tempo: paceAt(vdotSpeed, INTENSITY.threshold),
      interval: paceAt(vdotSpeed, INTENSITY.interval),
      goal,
    },
    history: {
      weeks,
      avgWeeklyKm: round1(active.reduce((s, w) => s + w.km, 0) / Math.max(active.length, 1)),
      avgRunsPerWeek: round1(active.reduce((s, w) => s + w.runs, 0) / Math.max(active.length, 1)),
      longestKm: round1(longest),
      weekdayCounts,
      longRunWeekdayCounts,
    },
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
