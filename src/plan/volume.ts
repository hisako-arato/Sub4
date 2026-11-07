// 走行距離の見込み：今週・月ごと（実績＋残りの計画）。
import { isRun, type Activity } from "../coros/parse.ts";
import type { Ability } from "./ability.ts";
import { addDays, mondayOf, RACE_DATE } from "./calendar.ts";
import { buildBaseDays, type DayPlan } from "./generate.ts";

// サブ4を狙う人の月間走行距離のよくある目安（大会前2〜3か月）
export const MONTHLY_TARGET = { min: 150, max: 200 };

export interface MonthVolume {
  month: string; // YYYY-MM
  actual: number; // 走った距離（今日まで）
  planned: number; // これからの計画（基本の練習）
  optional: number; // これからの任意ジョグ
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function computeVolume(a: Ability, activities: Activity[], adjusted: DayPlan[], today: string) {
  const runs = activities.filter(isRun);
  const ranToday = runs.some((r) => r.date === today);
  const end = RACE_DATE;
  const windowEnd = adjusted.at(-1)?.date ?? today;
  // 2週間より先は調整前の計画で見積もる
  const later = windowEnd < end ? buildBaseDays(a, activities, addDays(windowEnd, 1), end, null) : [];
  const futureDays = [...adjusted.filter((d) => d.date > today || (d.date === today && !ranToday)), ...later];

  const months: MonthVolume[] = [];
  for (const m of ["2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]) {
    const inM = (d: string) => d.startsWith(m);
    const actual = runs.filter((r) => inM(r.date) && r.date <= today).reduce((s, r) => s + r.distanceKm, 0);
    let planned = 0, optional = 0;
    for (const d of futureDays.filter((x) => inM(x.date) && x.main)) {
      if (d.optional) optional += d.main!.distanceKm;
      else planned += d.main!.distanceKm;
    }
    months.push({ month: m, actual: r1(actual), planned: r1(planned), optional: r1(optional) });
  }

  const mon = mondayOf(today);
  const sun = addDays(mon, 6);
  const inW = (d: string) => d >= mon && d <= sun;
  const weekDays = [...adjusted, ...later].filter((d) => inW(d.date));
  const strengthPlanned = weekDays.filter((d) => d.strength && !d.strength.skipped).length;
  const strengthDone = weekDays.filter((d) => d.strength?.done).length;
  const week = {
    strength: { done: strengthDone, planned: strengthPlanned },
    done: r1(runs.filter((r) => inW(r.date) && r.date <= today).reduce((s, r) => s + r.distanceKm, 0)),
    planned: r1(futureDays.filter((d) => inW(d.date) && d.main && !d.optional).reduce((s, d) => s + d.main!.distanceKm, 0)),
    optional: r1(futureDays.filter((d) => inW(d.date) && d.main && d.optional).reduce((s, d) => s + d.main!.distanceKm, 0)),
  };
  return { week, months, target: MONTHLY_TARGET };
}
