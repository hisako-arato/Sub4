// 栄養の目安（体重あたり）。医学的な判断はしない。
// 根拠：持久系アスリート向けのスポーツ栄養の目安（ACSM／IOC の合同声明などでよく引用される値）
//  - 炭水化物：軽い日 3〜5 g/kg、約1時間の練習 5〜7 g/kg、長時間（1〜3時間）6〜10 g/kg、大会前のカーボローディング（36〜48時間）8〜12 g/kg
//  - たんぱく質：1.2〜1.6 g/kg/日。練習後は 0.3 g/kg 程度をこまめに
//  - 90分を超える運動中：30〜60 g/時の炭水化物
//  - 大会の朝：1〜4時間前に 1〜4 g/kg の炭水化物
import type { Session } from "../plan/generate.ts";
import { addDays, RACE_DATE } from "../plan/calendar.ts";

export interface Nutrition {
  weightKg: number;
  weightSource: "coros" | "manual";
  dayType: string;
  carbs: { perKg: [number, number]; grams: [number, number]; riceBowls: [number, number] };
  protein: { perKg: [number, number]; grams: [number, number]; chickenG: [number, number] };
  tips: string[];
  foods: { carbs: string[]; protein: string[] };
}

const round5 = (n: number) => Math.round(n / 5) * 5;
const RICE_BOWL_CARBS = 55; // ご飯茶碗1杯（150g）
const CHICKEN_PROTEIN_PER_100G = 23; // 鶏むね肉（皮なし）100g

const TUNEUPS = ["2026-12-20"]; // 台北マラソン

export function nutritionFor(date: string, session: Session | null, weightKg: number, weightSource: "coros" | "manual"): Nutrition {
  let carbs: [number, number] = [3, 5];
  let protein: [number, number] = [1.2, 1.4];
  let dayType = "休養日";
  const tips: string[] = [];

  const goalRace = date === RACE_DATE;
  const loading = date === addDays(RACE_DATE, -1) || date === addDays(RACE_DATE, -2);
  const tuneup = TUNEUPS.includes(date);
  const beforeTuneup = TUNEUPS.includes(addDays(date, 1));

  if (goalRace || tuneup) {
    dayType = goalRace ? "大会当日" : "大会当日（楽しむレース）";
    carbs = [6, 8];
    protein = [1.2, 1.6];
    tips.push(`スタートの3時間前くらいに、炭水化物を約${round5(weightKg * 2)}g（体重×2g）。おにぎり・餅・バナナなど消化のよいもので`);
    tips.push("レース中は1時間に炭水化物30〜60g（ジェル1〜2個）を目安に、早め早めに");
    tips.push("ゴール後は、たんぱく質と炭水化物を一緒にとって回復を");
  } else if (loading) {
    dayType = "カーボローディング";
    carbs = [8, 10];
    protein = [1.2, 1.4];
    tips.push("大会2日前と前日は、主食を増やして脂っこいもの・食物繊維の多いものは控えめに");
    tips.push("食べ慣れたものだけにする。新しい食べ物は試さない");
  } else if (beforeTuneup) {
    dayType = "大会前日";
    carbs = [7, 8];
    tips.push("前日は主食をいつもより多めに。食べ慣れたものを");
  } else if (session) {
    const longRun = session.category === "distance" && session.distanceKm >= 20;
    if (longRun) {
      dayType = "長時間の練習（ロング走）";
      carbs = [6, 8];
      protein = [1.4, 1.6];
      tips.push("90分を超えるので、走りながら1時間に炭水化物30〜60g（ジェル1〜2個）。本番の補給の練習にもなる");
    } else if (session.hard) {
      dayType = "ポイント練習（約1時間）";
      carbs = [5, 7];
      protein = [1.4, 1.6];
    } else {
      dayType = "軽めの練習（ジョグ）";
      carbs = [5, 6];
      protein = [1.2, 1.4];
    }
    tips.push(`走ったあと1時間以内に、たんぱく質約${round5(weightKg * 0.3)}gと炭水化物をいっしょに`);
  } else {
    tips.push("休養日は主食を控えめにしてOK。たんぱく質は3食に分けて");
  }

  const g = (p: [number, number]): [number, number] => [round5(p[0] * weightKg), round5(p[1] * weightKg)];
  const carbG = g(carbs);
  const protG = g(protein);
  return {
    weightKg,
    weightSource,
    dayType,
    carbs: {
      perKg: carbs,
      grams: carbG,
      riceBowls: [Math.round((carbG[0] / RICE_BOWL_CARBS) * 2) / 2, Math.round((carbG[1] / RICE_BOWL_CARBS) * 2) / 2],
    },
    protein: {
      perKg: protein,
      grams: protG,
      chickenG: [round5((protG[0] / CHICKEN_PROTEIN_PER_100G) * 100), round5((protG[1] / CHICKEN_PROTEIN_PER_100G) * 100)],
    },
    tips,
    foods: {
      carbs: ["ご飯 茶碗1杯（150g）≒ 55g", "おにぎり1個 ≒ 40g", "うどん1玉 ≒ 55g", "食パン6枚切1枚 ≒ 27g", "バナナ1本 ≒ 25g", "エナジージェル1個 ≒ 25g"],
      protein: ["鶏むね肉100g ≒ 23g", "鮭1切れ ≒ 20g", "卵1個 ≒ 6g", "納豆1パック ≒ 7g", "牛乳200ml ≒ 7g", "ギリシャヨーグルト1個 ≒ 10g"],
    },
  };
}
