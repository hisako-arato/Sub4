// 計画ロジックの単体テスト: node --test --experimental-strip-types test/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFitness, parseSportRecords, parseTrainingLoad, type Activity } from "../src/coros/parse.ts";
import { computeAbility } from "../src/plan/ability.ts";
import { buildBaseDays, expectedPaceRange, generatePlan, generateWithHistory } from "../src/plan/generate.ts";
import { addDays, daysBetween, isHoliday, RACE_DATE, weekday, weekSpecFor } from "../src/plan/calendar.ts";

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

// 計画どおりに走った活動を作る（シーズン全体のテスト用）
const A = computeAbility(acts, fitness, "2026-11-07");
function followPlan(until: string, skip: (date: string) => boolean = () => false): Activity[] {
  const out = [...acts];
  for (const d of buildBaseDays(A, acts, "2026-11-07", until, 1.0)) {
    if (!d.main || d.optional || d.date >= until || skip(d.date)) continue;
    const [f, sl] = expectedPaceRange(d.main.steps);
    const km = d.main.distanceKm;
    out.push({ labelId: `sim-${d.date}`, sportType: 100, title: "Outdoor Run", date: d.date, distanceKm: km, durationS: Math.round(((f + sl) / 2) * km) });
  }
  return out;
}

// シーズン全体を2週間ずつ生成して安全原則を確かめる（計画どおり走っている前提）
function season(loadRatio: number | null) {
  const all = new Map<string, ReturnType<typeof generatePlan>[number]>();
  for (let d = "2026-11-07"; d <= RACE_DATE; d = addDays(d, 14)) {
    for (const day of generatePlan(A, followPlan(d), { today: d, loadRatio })) if (!all.has(day.date)) all.set(day.date, day);
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
  const hi = generatePlan(A, followPlan("2027-01-04"), { today: "2027-01-04", loadRatio: 1.6 });
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

// ---- 時計への送信（COROS course 形式） ----
import { toCourse } from "../src/coros/workout.ts";

function checkSection(sec: any, inSets: boolean, where: string) {
  if (sec.intervalGroup) {
    assert.ok(!inSets, `${where}: 繰り返しの入れ子`);
    assert.ok(sec.repeats >= 1 && sec.repeats <= 20, `${where}: repeats`);
    for (const k of ["intensityType", "targetType", "targetValue", "intensityValueStart", "intensityValueEnd"]) {
      assert.ok(!(k in sec), `${where}: 繰り返しの外枠に ${k}`);
    }
    assert.ok(sec.sets.length > 0, `${where}: 空の sets`);
    for (const m of sec.sets) checkSection(m, true, where);
    return;
  }
  assert.ok(inSets ? [2, 3].includes(sec.sectionType) : [1, 2, 3, 4].includes(sec.sectionType), `${where}: sectionType`);
  assert.ok([1, 2].includes(sec.targetType), `${where}: targetType`);
  assert.ok(Number.isInteger(sec.targetValue) && sec.targetValue > 0, `${where}: targetValue`);
  assert.equal(sec.intensityType, 2, `${where}: intensityType`);
  for (const v of [sec.intensityValueStart, sec.intensityValueEnd]) {
    assert.ok(Number.isInteger(v) && v >= 120 && v <= 1499, `${where}: pace ${v}`);
  }
}

test("全シーズンの練習（気分の練習も含む）が COROS の形式を満たす", () => {
  let n = 0;
  for (const day of season(1.0)) {
    for (const s of [day.main, ...day.subs]) {
      if (!s) continue;
      const c = toCourse(s);
      const where = `${day.date} ${s.title}`;
      assert.equal(c.sportType, 1);
      assert.ok(c.courseName.length > 0 && c.courseName.length <= 100, where);
      assert.ok(c.courseDescription.length > 0, where);
      assert.ok(c.sections.length > 0, where);
      for (const sec of c.sections) checkSection(sec, false, where);
      n++;
    }
  }
  assert.ok(n > 100, `確認した練習が少なすぎる: ${n}`);
});

test("インターバルは アップ→繰り返し→ダウン になる", () => {
  const day = season(1.0).find((d) => d.main?.title === "インターバル")!;
  const c = toCourse(day.main!) as any;
  assert.deepEqual(c.sections.map((s: any) => (s.intervalGroup ? "repeat" : s.sectionType)), [1, "repeat", 4]);
  assert.equal(c.sections[1].sets[0].targetValue, 1000);
});


// ---- 段階3：記録・達成度・自動調整 ----
import { evaluate, DEFAULT_SETTINGS } from "../src/plan/adjust.ts";

const TODAY = "2027-01-13"; // 水曜（強化期）
const run = (date: string, km: number, pace: number): Activity => ({ labelId: `x-${date}`, sportType: 100, title: "Outdoor Run", date, distanceKm: km, durationS: Math.round(km * pace) });

test("達成度：距離90%以上かつ目安ペース±10秒で達成", () => {
  const day = buildBaseDays(A, acts, "2027-01-09", "2027-01-09", 1.0)[0]; // 22km ロング走
  const s = day.main!;
  const [f, sl] = expectedPaceRange(s.steps);
  assert.equal(evaluate(s, [run(day.date, 22, (f + sl) / 2)], DEFAULT_SETTINGS).level, "achieved");
  assert.equal(evaluate(s, [run(day.date, 18, (f + sl) / 2)], DEFAULT_SETTINGS).level, "partial");
  assert.equal(evaluate(s, [run(day.date, 8, (f + sl) / 2)], DEFAULT_SETTINGS).level, "missed");
  const fast = evaluate(s, [run(day.date, 22, f - 30)], DEFAULT_SETTINGS);
  assert.ok(fast.flags.includes("fast"));
  // しきい値を変えると判定が変わる
  assert.equal(evaluate(s, [run(day.date, 18, (f + sl) / 2)], { distPct: 80, paceTolS: 10 }).level, "achieved");
});

test("未入力のまま過ぎた日は「走らなかった」扱い、走った日は自動判定", () => {
  const r = generateWithHistory(A, followPlan(TODAY, (d) => d === "2027-01-11"), { today: TODAY, loadRatio: 1.0 });
  const mon = r.past.find((d) => d.date === "2027-01-11")!;
  assert.equal(mon.result?.state, "auto_skipped");
  const sat = r.past.find((d) => d.date === "2027-01-09")!;
  assert.equal(sat.result?.state, "ran");
  assert.equal(sat.result?.achievement?.level, "achieved");
});

test("走らなかった大事な練習は、今週の空いている土日祝に7割で移す（週1回まで）", () => {
  // 今日=土曜 1/16 の MP 走を「走らなかった」→ 日曜に短縮して移す
  const today = "2027-01-17";
  const logs = { "2027-01-16": { status: "skipped" as const, reason: "schedule" as const } };
  const r = generateWithHistory(A, followPlan(today, (d) => d === "2027-01-16"), { today, loadRatio: 1.0, logs });
  const sun = r.days[0];
  assert.equal(sun.date, today);
  assert.equal(sun.main?.category, "pace");
  assert.match(sun.main!.title, /短縮/);
  assert.ok(sun.main!.distanceKm < 16);
  assert.ok(sun.notes.some((n) => n.includes("移しといた")));
});

test("「走る予定はない」日の練習は、短縮せずに移す（ペナルティなし）", () => {
  const today = "2027-01-14"; // 木
  const logs = { "2027-01-16": { status: "off" as const } }; // 土は予定なし
  const r = generateWithHistory(A, followPlan(today), { today, loadRatio: 1.0, logs });
  assert.equal(r.days.find((d) => d.date === "2027-01-16")!.main, null);
  const sun = r.days.find((d) => d.date === "2027-01-17")!;
  assert.equal(sun.main?.title, "マラソンペース走");
});

test("平日にロング走は移さない", () => {
  const today = "2027-01-10"; // 日
  const logs = { "2027-01-09": { status: "skipped" as const } }; // 土の22kmを休んだ
  const r = generateWithHistory(A, followPlan(today, (d) => d === "2027-01-09"), { today, loadRatio: 1.0, logs });
  for (const d of r.days.filter((x) => x.date < "2027-01-11")) {
    if (d.main?.category === "distance") assert.ok([5, 6].includes(weekday(d.date)) || isHoliday(d.date), d.date);
  }
  // 翌週以降の月〜金に 12km 超を入れない（祝日を除く）
  for (const d of r.days) {
    if (d.main && d.main.distanceKm > 12 && weekday(d.date) < 5) assert.ok(isHoliday(d.date), `${d.date} ${d.main.title}`);
  }
});

test("痛み（「痛みがある」ボタン）：2日は休養、その後も短いジョグだけで受診を促す。「治った」で解除", () => {
  const r = generateWithHistory(A, followPlan(TODAY), { today: TODAY, loadRatio: 1.0, painSince: "2027-01-12" });
  assert.ok(r.modes.pain);
  assert.ok(r.alerts.some((x) => x.text.includes("受診")));
  for (const d of r.days.slice(0, 7)) {
    if (daysBetween("2027-01-12", d.date) <= 2) assert.equal(d.main, null, d.date);
    else if (d.main) assert.ok(!d.main.hard && d.main.distanceKm <= 5, d.date);
  }
  const r2 = generateWithHistory(A, followPlan(TODAY), { today: TODAY, loadRatio: 1.0, painSince: null });
  assert.ok(!r2.modes.pain);
  // 1週間以上続くと、受診をより強くすすめる
  const r3 = generateWithHistory(A, followPlan(TODAY), { today: TODAY, loadRatio: 1.0, painSince: "2027-01-03" });
  assert.ok(r3.alerts.some((x) => x.text.includes("1週間以上")));
});

test("疲労は COROS の負荷比・回復状況だけで判断し、直近7日の高強度を下げる", () => {
  for (const opts of [{ loadRatio: 1.6 }, { loadRatio: 1.0, recoveryPercent: 30 }]) {
    const r = generateWithHistory(A, followPlan(TODAY), { today: TODAY, ...opts });
    assert.ok(r.modes.fatigue, JSON.stringify(opts));
    for (const d of r.days.slice(0, 7)) if (d.main?.category === "speed" || d.main?.category === "pace") assert.ok(!d.main.hard, d.date);
  }
  assert.ok(!generateWithHistory(A, followPlan(TODAY), { today: TODAY, loadRatio: 1.0, recoveryPercent: 90 }).modes.fatigue);
});

test("数日空いた後は、次の2回は強度を上げない", () => {
  // 1/4〜1/12 を全部休んだ
  const r = generateWithHistory(A, followPlan(TODAY, (d) => d >= "2027-01-04"), { today: TODAY, loadRatio: 1.0 });
  assert.ok(r.modes.comeback);
  const next2 = r.days.filter((d) => d.main).slice(0, 2);
  for (const d of next2) assert.ok(!d.main!.hard, d.date);
});

test("ロング走は最近の最長距離＋6kmまで", () => {
  // 12月から全く走っていない状態で 1/25 週の 26km は伸ばしすぎない
  const today = "2027-01-25";
  const r = generateWithHistory(A, followPlan("2026-12-01"), { today, loadRatio: 1.0 });
  for (const d of r.days) if (d.main && d.main.category !== "race") assert.ok(d.main.distanceKm <= 12.5 + 6 * 2, `${d.date} ${d.main.distanceKm}`);
});

test("大会の週は大会の距離を練習量に数えない（回復ジョグを短縮しない）", () => {
  const r = generateWithHistory(A, acts, { today: "2026-11-07", loadRatio: 1.0 });
  const sat = r.days[0];
  assert.equal(sat.main?.title, "ゆったりジョグ");
  assert.equal(sat.main?.distanceKm, 5);
});

test("使い始める前の日は「走らなかった」と判定しない", () => {
  const r = generateWithHistory(A, acts, { today: "2026-11-07", loadRatio: 1.0, planStart: "2026-11-06" });
  for (const d of r.past) assert.ok(!["auto_skipped", "skipped"].includes(d.result?.state ?? ""), d.date);
  assert.equal(r.past.find((d) => d.date === "2026-11-03")?.result?.state, "extra");
});

// ---- 台北マラソン（12/20、サブ4は狙わない） ----
test("台北マラソン：前週は調整、当日は楽しむレース、翌日は休養、翌週は回復", () => {
  const days = buildBaseDays(A, acts, "2026-12-14", "2026-12-27", 1.0);
  const at = (d: string) => days.find((x) => x.date === d)!;
  assert.match(at("2026-12-20").main!.title, /台北マラソン/);
  assert.equal(at("2026-12-20").main!.category, "race");
  assert.equal(at("2026-12-19").main, null, "前日は移動・休養");
  assert.equal(at("2026-12-21").main, null, "翌日は休養");
  for (const d of days) assert.ok(!d.optional, `${d.date} に任意ジョグ`);
  for (const d of days.filter((x) => x.date > "2026-12-20")) assert.ok(!d.main?.hard, `${d.date} 回復週に高強度`);
});

test("台北を抑えて走っても、走力の基準は速い方の大会を使う", () => {
  const slowTaipei = run("2026-12-20", 42.2, 420); // 7:00/km で楽しんだ
  const a = computeAbility([...acts, slowTaipei], fitness, "2026-12-25");
  assert.equal(a.race?.date, "2026-11-03");
});

test("平日（祝日以外）の練習は 12km 以下", () => {
  for (const d of buildBaseDays(A, acts, "2026-11-07", RACE_DATE, 1.0)) {
    if (d.main && weekday(d.date) < 5 && !isHoliday(d.date)) assert.ok(d.main.distanceKm <= 12.5, `${d.date} ${d.main.title} ${d.main.distanceKm}`);
  }
});

// ---- 段階4：コーチのセリフ ----
import { coachSpeech, stretchSpeech, type CoachContext } from "../src/coach/speech.ts";

const ctxBase = (today: CoachContext["today"]): CoachContext => ({
  today, daysToRace: 60, phase: "build", phaseLabel: "強化期", connected: true, stale: false,
  modes: { pain: false, fatigue: false, comeback: false }, hourJst: 7, week: { done: 10, planned: 30 }, upcomingTuneup: null,
});

test("セリフ：シーズンのどの日も、名前で呼びかけ、空や undefined がない", () => {
  for (const day of season(1.0)) {
    const sp = coachSpeech(ctxBase(day));
    assert.ok(sp.lines.length >= 2 && sp.lines.length <= 5, day.date);
    assert.match(sp.lines[0], /ハルキ君/);
    for (const l of sp.lines) assert.ok(l && !/undefined|NaN|null/.test(l), `${day.date}: ${l}`);
  }
});

test("セリフ：痛みは心配顔で受診を促す／未接続は怒り顔／休養日はリラックス", () => {
  const day = season(1.0)[0];
  const pain = coachSpeech({ ...ctxBase(day), modes: { pain: true, fatigue: false, comeback: false } });
  assert.equal(pain.expression, "sad");
  assert.ok(pain.lines.some((l) => l.includes("病院")));
  assert.equal(coachSpeech({ ...ctxBase(day), connected: false }).expression, "angry");
  const rest = season(1.0).find((d) => !d.main)!;
  assert.equal(coachSpeech(ctxBase(rest)).expression, "relaxed");
});

test("セリフ：達成した日は笑顔、ジョグが速すぎた日は怒り顔", () => {
  const r = generateWithHistory(A, followPlan("2027-01-10"), { today: "2027-01-09", loadRatio: 1.0 });
  const today = r.days[0]; // 1/9 ロング走を走った
  assert.equal(today.result?.state, "ran");
  assert.equal(coachSpeech(ctxBase(today)).expression, "happy");
  const jogDay = { ...today, main: { ...today.main!, hard: false, category: "jog" as const }, result: { state: "ran" as const, achievement: { level: "achieved" as const, flags: ["fast" as const], avgPace: "5:10" } } };
  assert.equal(coachSpeech(ctxBase(jogDay)).expression, "angry");
});

// ---- 段階5：栄養とケア ----
import { nutritionFor } from "../src/care/nutrition.ts";
import { careFor, STRETCHES } from "../src/care/care.ts";

test("栄養：体重×目安（休養日・ロング走・カーボローディング・大会当日）", () => {
  const rest = nutritionFor("2027-01-05", null, 62, "coros");
  assert.deepEqual(rest.carbs.grams, [185, 310]);
  assert.deepEqual(rest.protein.grams, [75, 85]);
  const longDay = season(1.0).find((d) => d.main?.title === "30km走")!;
  const lr = nutritionFor(longDay.date, longDay.main, 62, "coros");
  assert.deepEqual(lr.carbs.perKg, [6, 8]);
  assert.ok(lr.tips.some((t) => t.includes("30〜60g")));
  for (const d of ["2027-03-12", "2027-03-13"]) assert.deepEqual(nutritionFor(d, null, 62, "coros").carbs.perKg, [8, 10], d);
  const race = nutritionFor(RACE_DATE, null, 62, "coros");
  assert.equal(race.dayType, "大会当日");
  assert.ok(race.tips[0].includes("125g"), race.tips[0]);
  assert.equal(nutritionFor("2026-12-19", null, 62, "manual").dayType, "大会前日");
});

test("ケア：痛みのときはストレッチを出さず受診を促す、ロング走のあとは5種", () => {
  const pain = careFor(null, { pain: true });
  assert.equal(pain.after.length, 0);
  assert.match(pain.caution!, /受診/);
  const longDay = season(1.0).find((d) => d.main?.title === "30km走")!;
  assert.equal(careFor(longDay.main, { pain: false }).after.length, 5);
  for (const day of season(1.0)) {
    const c = careFor(day.main, { pain: false });
    for (const id of [...c.before, ...c.after]) assert.ok(STRETCHES[id], id);
  }
});

test("ケアのセリフ：今日のおすすめストレッチを伝え、種目ごとにやり方を説明する", () => {
  const jogDay = season(1.0).find((d) => d.main?.category === "jog" && !d.optional)!;
  const c = careFor(jogDay.main, { pain: false });
  const care = { title: c.title, before: c.before.map((id) => STRETCHES[id]), after: c.after.map((id) => STRETCHES[id]) };
  const sp = coachSpeech({ ...ctxBase(jogDay), care });
  assert.ok(sp.lines.some((l) => l.includes("ふくらはぎ") && l.includes("30秒")), sp.lines.join("\n"));
  const calf = stretchSpeech(STRETCHES.calf);
  assert.match(calf.lines[0], /ふくらはぎ/);
  assert.equal(calf.lines.length, STRETCHES.calf.steps.length + 2);
  assert.match(calf.lines.at(-1)!, /30秒キープ、反対側も/);
  assert.match(stretchSpeech(STRETCHES.legswing).lines.at(-1)!, /リズム/);
});

// ---- 気づき ----
import { parseLaps } from "../src/coros/parse.ts";
import { computeInsights } from "../src/insight/insights.ts";

test("ラップ：JSON（m・ミリ秒）でもテキストでも、活動全体に合わせて単位をそろえる", () => {
  const json = { laps: Array.from({ length: 42 }, (_, i) => ({ lapIndex: i + 1, distance: 1000, time: 360000 + i * 3000, avgHr: 140 + i })) };
  const laps = parseLaps(json, 42.2, 42 * 360 + 3000 * 861 / 1000);
  assert.equal(laps.length, 42);
  assert.ok(Math.abs(laps[0].distanceKm - 1) < 1e-9);
  assert.ok(Math.abs(laps[0].durationS - 360) < 1e-9);
  const text = Array.from({ length: 5 }, (_, i) => `Lap ${i + 1}\n  Distance: 1.00 km | Time: 0:06:00 | Avg HR: 150 bpm`).join("\n");
  const t = parseLaps(text, 5, 1800);
  assert.equal(t.length, 5);
  assert.equal(t[2].avgHr, 150);
  assert.deepEqual(parseLaps("no laps here", 5, 1800), []);
});

test("気づき：持久力の差・後半の失速・速すぎるジョグを見つける", () => {
  // 前半 6:00/km、25km から 7:00/km に落ちた大会（心拍は下がる）
  const raceId = "900000000000000002";
  const laps = Array.from({ length: 42 }, (_, i) => ({ index: i + 1, distanceKm: 1, durationS: i < 25 ? 360 : 420, avgHr: i < 25 ? 155 : 145 }));
  const jogs = ["2026-10-20", "2026-10-22", "2026-10-27", "2026-10-29"].map((d) => run(d, 8, 320)); // 5:20/km の速いジョグ
  const ins = computeInsights({
    today: "2026-11-07", activities: [...acts, ...jogs], laps: { [raceId]: laps }, fitness, loadRatio: 1.36, loadComment: "Optimized", ability: A,
  });
  const by = Object.fromEntries(ins.map((i) => [i.id, i]));
  assert.equal(by.endurance.level, "warn");
  assert.match(by.fade.text, /25km 付近/);
  assert.match(by.fade.text, /脚かエネルギー/);
  assert.equal(by.easy.level, "warn");
  for (const i of ins) assert.ok(i.coach && !/undefined|NaN/.test(i.text + i.value + i.coach), i.id);
  assert.equal(ins[0].level, "warn", "注意すべき気づきが先頭");
});

// ---- ストレッチの実演（自作キーフレーム） ----
test("ケアで出すストレッチは全部、アバターの動き（左右）がある", async () => {
  const { STRETCH_MOTION, stretchPose, mirror } = await import("../public/stretch-motion.js");
  for (const id of Object.keys(STRETCHES)) {
    assert.ok(STRETCH_MOTION[id], `${id} の動きがない`);
    for (const side of ["left", "right"]) {
      for (const t of [0, 0.7, 3.1]) {
        const p = stretchPose(id, side, t);
        for (const [bone, r] of Object.entries(p as Record<string, number[]>)) {
          assert.ok(r.length === 3 && r.every((v) => Number.isFinite(v) && Math.abs(v) < Math.PI), `${id} ${side} ${bone}`);
        }
      }
    }
  }
  // 左右の入れ替えは2回で元に戻る
  const p = STRETCH_MOTION.quad.pose(1);
  assert.deepEqual(mirror(mirror(p)), p);
  assert.deepEqual(mirror({ leftUpperLeg: [0.1, 0.2, 0.3] }), { rightUpperLeg: [0.1, -0.2, -0.3] });
});

test("ケア：走る日はいつも走る前の準備、休養日は柔軟、すべての種目はカテゴリごとに見られる", async () => {
  const { careLibrary } = await import("../src/care/care.ts");
  const jogDay = season(1.0).find((d) => d.main?.category === "jog" && !d.optional)!;
  assert.ok(careFor(jogDay.main, { pain: false }).before.length >= 2, "ジョグの日も走る前の準備");
  const rest = careFor(null, { pain: false });
  assert.ok(rest.after.some((id) => STRETCHES[id].category === "mobility"), "休養日は柔軟");
  const lib = careLibrary();
  assert.deepEqual(lib.map((g) => g.category), ["warmup", "stretch", "mobility", "strength"]);
  assert.equal(lib.flatMap((g) => g.items).length, Object.keys(STRETCHES).length, "全種目がどこかのカテゴリに入る");
  for (const id of lib.find((g) => g.category === "strength")!.items) {
    const st = STRETCHES[id];
    assert.ok(st.kind === "reps" ? st.reps! > 0 && st.sets! > 0 : st.holdSec > 0, id);
    assert.match(stretchSpeech(st).lines.at(-1)!, /セット/);
  }
});

// ---- 補強（筋トレ）の予定 ----
import { strengthFor, WEEKS } from "../src/plan/calendar.ts";
import { findStrengthWorkoutId } from "../src/coros/workout.ts";

test("補強：時期ごとの回数（基礎・強化は週2、30km走の週・軽めの週は1、テーパーは軽く1、回復・大会週は0）", () => {
  const w = (mon: string) => strengthFor(WEEKS.find((x) => x.monday === mon)!);
  assert.equal(w("2026-11-09"), null, "回復期");
  assert.deepEqual(w("2026-11-16"), { days: [0, 3], sets: 2, light: false }, "基礎期");
  assert.deepEqual(w("2027-01-04"), { days: [0, 3], sets: 3, light: false }, "強化期は3セット");
  assert.deepEqual(w("2027-02-08")?.days, [0], "30km走の週は1回");
  assert.deepEqual(w("2026-12-14"), { days: [0], sets: 1, light: true }, "台北前は軽く1回");
  assert.equal(w("2026-12-21"), null, "台北後の回復週");
  assert.deepEqual(w("2027-03-01"), { days: [0], sets: 1, light: true }, "テーパー");
  assert.equal(w("2027-03-08"), null, "大会週");
  // 補強は月・木だけ（水のポイント練習、金＝ロング走の前日、週末には置かない）
  for (const d of buildBaseDays(A, acts, "2026-11-07", RACE_DATE, 1.0)) if (d.strength) assert.ok([0, 3].includes(weekday(d.date)), d.date);
});

test("補強：COROS の筋トレ記録で✓、痛み・疲れのときはお休み", () => {
  const today = "2026-11-20"; // 金（11/16 月・11/19 木が補強の日）
  const strengthAct: Activity = { labelId: "s1", sportType: 402, title: "Strength", date: "2026-11-16", distanceKm: 0, durationS: 900 };
  const r = generateWithHistory(A, [...followPlan(today), strengthAct], { today, loadRatio: 1.0 });
  assert.equal(r.past.find((d) => d.date === "2026-11-16")!.strength?.done, true);
  assert.equal(r.past.find((d) => d.date === "2026-11-19")!.strength?.done, false);
  const next = r.days.find((d) => d.strength)!;
  assert.ok(!next.strength!.skipped);
  const pain = generateWithHistory(A, followPlan(today), { today, loadRatio: 1.0, painSince: today });
  assert.match(pain.days.find((d) => d.strength)!.strength!.skipped!, /痛み/);
  const tired = generateWithHistory(A, followPlan(today), { today, loadRatio: 1.7 });
  assert.match(tired.days.find((d) => d.strength)!.strength!.skipped!, /疲れ/);
});

test("補強：COROS のワークアウト一覧から「Sub4 補強」を探す（テキストでも JSON でも）", () => {
  const text = "Workout Library (2 workouts)\n========\n\n1. Upper body\n   Workout ID: 111 | Sport: Strength\n\n2. Sub4 補強\n   Workout ID: 222 | Sport: Strength";
  assert.deepEqual(findStrengthWorkoutId(text)?.id, "222");
  assert.deepEqual(findStrengthWorkoutId({ workouts: [{ workoutId: 9, name: "core" }, { workoutId: 10, name: "Sub4補強" }] })?.id, "10");
  assert.equal(findStrengthWorkoutId("1. Upper body\n Workout ID: 111"), null);
});
