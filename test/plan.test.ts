// 計画ロジックの単体テスト: node --test --experimental-strip-types test/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFitness, parseSportRecords, parseTrainingLoad, type Activity } from "../src/coros/parse.ts";
import { computeAbility } from "../src/plan/ability.ts";
import { generatePlan } from "../src/plan/generate.ts";
import { addDays, isHoliday, RACE_DATE, weekday, weekSpecFor } from "../src/plan/calendar.ts";

// COROS の実際の書式に合わせた架空データ
const RECORDS = `Sport Records — 2026-09-01 to 2026-11-06 (3 records)
========================

1. Outdoor Run — 2026-11-03
   Location: テスト市 ラン
   Time Window: startTimestamp=1793663757 | endTimestamp=1793679738
   Duration: 4:20:00 | Distance: 42.20 km
   Average Pace: 6:10 /km | Avg HR: 150 bpm | Calories: 3000 kcal
   LabelId: 900000000000000002 | SportType: 100

2. Outdoor Run — 2026-10-17
   Duration: 2:30:00 | Distance: 24.00 km
   Average Pace: 6:15 /km | Avg HR: 145 bpm | Calories: 1700 kcal
   LabelId: 900000000000000001 | SportType: 100

3. Outdoor Run — 2026-10-14
   Duration: 30:00 | Distance: 5.50 km
   Average Pace: 5:27 /km | Avg HR: 150 bpm | Calories: 380 kcal
   LabelId: 900000000000000000 | SportType: 100`;

const FITNESS = `Fitness Assessment Overview
========================

VO2max: 54
Running Level: 75
Threshold Pace: 4:50 /km
5 km Prediction: 23:10
10 km Prediction: 48:00
Half Marathon Prediction: 1:48:00
Marathon Prediction: 3:52:00`;

const LOAD = `Training Load Assessment
========================

2026-11-06
Comment: Optimized
Short-Term Load: 79
Long-Term Load: 58
Load Ratio: 1.36

2026-11-05
Comment: Excessive
Short-Term Load: 92
Long-Term Load: 59
Load Ratio: 1.55`;

const acts: Activity[] = parseSportRecords(RECORDS);
const fitness = parseFitness(FITNESS);

test("活動テキストを解析できる（labelId は文字列のまま）", () => {
  assert.equal(acts.length, 3);
  assert.deepEqual(
    { labelId: acts[0].labelId, date: acts[0].date, km: acts[0].distanceKm, s: acts[0].durationS, hr: acts[0].avgHr },
    { labelId: "900000000000000002", date: "2026-11-03", km: 42.2, s: 15600, hr: 150 },
  );
  assert.equal(acts[2].durationS, 1800);
});

test("走力評価と負荷を解析できる", () => {
  assert.equal(fitness?.vo2max, 54);
  assert.equal(fitness?.thresholdPaceS, 290);
  assert.equal(fitness?.predictions.km10, 2880);
  assert.equal(fitness?.predictions.full, 3 * 3600 + 52 * 60);
  const load = parseTrainingLoad(LOAD);
  assert.equal(load[0].date, "2026-11-06");
  assert.equal(load[0].ratio, 1.36);
});

test("大会を検出し、ペースを控えめに設定する", () => {
  const a = computeAbility(acts, fitness, "2026-11-07");
  assert.equal(a.race?.date, "2026-11-03");
  assert.ok(a.vdotSpeed < a.vdotPredicted!, "スピードは予測より控えめ");
  assert.ok(a.paces.long[0] >= a.race!.paceS, "ロング走は大会の実ペースより速くしない");
  assert.ok(Math.abs(a.paces.goal - 340) < 1, "サブ4目標ペースは約5:40/km");
});

// シーズン全体を2週間ずつ生成して安全原則を確かめる
function season(loadRatio: number | null) {
  const a = computeAbility(acts, fitness, "2026-11-07");
  const all = new Map<string, ReturnType<typeof generatePlan>[number]>();
  for (let d = "2026-11-07"; d <= RACE_DATE; d = addDays(d, 14)) {
    for (const day of generatePlan(a, acts, { today: d, loadRatio })) if (!all.has(day.date)) all.set(day.date, day);
  }
  return [...all.values()];
}

test("金曜日には練習を入れない", () => {
  for (const day of season(1.0)) if (weekday(day.date) === 4) assert.equal(day.main, null, day.date);
});

test("高強度を2日続けない", () => {
  const days = season(1.0);
  for (let i = 1; i < days.length; i++) {
    assert.ok(!(days[i].main?.hard && days[i - 1].main?.hard && days[i].main?.category !== "race"), days[i].date);
  }
});

test("基本は月・水・週末、任意ジョグは余裕のある週だけ", () => {
  for (const day of season(1.0)) {
    const wd = weekday(day.date);
    const spec = weekSpecFor(day.date)!;
    if (day.optional) {
      assert.ok(!spec.down && ["base", "build", "peak"].includes(spec.phase), `${day.date} は軽めの週なのに任意ジョグ`);
      assert.ok(!isHoliday(addDays(day.date, 1)), `${day.date} 翌日が祝日`);
    } else if (day.main) {
      assert.ok([0, 2, 5, 6].includes(wd), `${day.date} は基本の曜日ではない`);
    }
  }
});

test("負荷比が高いと任意ジョグを出さず、直近の高強度を軽くする", () => {
  const a = computeAbility(acts, fitness, "2026-11-07");
  const hi = generatePlan(a, acts, { today: "2027-01-04", loadRatio: 1.6 });
  assert.ok(!hi.some((d) => d.optional));
  assert.ok(!hi.slice(0, 7).some((d) => d.main?.hard), "7日以内に高強度が残っている");
  assert.ok(hi.slice(7).some((d) => d.main?.hard), "8日目以降は通常どおり");
});

test("祝日の月曜は少し長めにする", () => {
  const day = season(1.0).find((d) => d.date === "2026-11-23")!;
  assert.equal(day.main?.category, "distance");
});

test("大会日はレース、ピーク期に30km走が2回", () => {
  const days = season(1.0);
  assert.equal(days.find((d) => d.date === RACE_DATE)?.main?.category, "race");
  assert.equal(days.filter((d) => d.main?.title === "30km走").length, 2);
});
