// COROS のデータを読み解いた「気づき」。COROS の画面を見ているだけでは分かりにくいことを、
// 活動・心拍・ラップ・負荷を組み合わせて言葉にする（ルールベース）。
import { isRun, type Activity, type FitnessOverview, type Lap } from "../coros/parse.ts";
import type { Ability } from "../plan/ability.ts";
import { addDays, daysBetween, mondayOf, RACE_DATE, SUB4_SECONDS } from "../plan/calendar.ts";
import { fmtPace, fmtTime } from "../plan/vdot.ts";

export interface Insight {
  id: string;
  icon: string;
  title: string;
  value: string; // ひと目で分かる数字
  text: string; // 何が言えるか・どうするか
  level: "good" | "warn" | "info";
  coach: string; // コーチのセリフ用（ハルヒ風）
}

export interface InsightInput {
  today: string;
  activities: Activity[];
  laps: Record<string, Lap[]>;
  fitness: FitnessOverview | null;
  loadRatio: number | null;
  loadComment: string | null;
  ability: Ability;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const paceOf = (r: { distanceKm: number; durationS: number }) => r.durationS / r.distanceKm;

/** 1. 持久力ギャップ：スピードからの予測と実際のフルの差 */
function enduranceGap(inp: InsightInput): Insight | null {
  const race = inp.ability.race;
  const pred = inp.fitness?.predictions.full;
  if (!race || !pred) return null;
  const gap = race.timeS / pred - 1; // 予測よりどれだけ遅かったか
  const need = SUB4_SECONDS / pred - 1; // サブ4に許される落ち幅
  const ok = gap <= need;
  return {
    id: "endurance",
    icon: "🔋",
    title: "スピードと持久力の差",
    value: `予測 ${fmtTime(pred)} → 実際 ${fmtTime(race.timeS)}（${pct(gap)}）`,
    text: ok
      ? `COROS の予測どおりに走れています。サブ4の力はすでにあります。`
      : `COROS の予測はスピード（5〜10km の力）からの換算です。実際のフルは予測より ${pct(gap)} 遅く、スピードは足りていて持久力が課題です。サブ4には落ち幅を ${pct(need)} 以内に縮めればよく、ロング走・30km走・補給の練習がいちばん効きます。`,
    level: ok ? "good" : "warn",
    coach: ok
      ? "あなた、サブ4の力はもうあるのよ。あとは当日きっちり走るだけ！"
      : `スピードは十分。足りないのはスタミナよ！ 予測より${Math.round(gap * 100)}%も落ちてるんだから、ロング走でそこを埋めるの`,
  };
}

/** 2. 大会の後半の失速（ラップ） */
function raceFade(inp: InsightInput): Insight | null {
  const race = inp.activities.filter(isRun).filter((a) => a.distanceKm >= 40 && daysBetween(a.date, inp.today) <= 120).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!race) return null;
  const laps = (inp.laps[race.labelId] ?? []).filter((l) => l.distanceKm >= 0.5);
  if (laps.length < 10) return null;
  // 距離の累積で前半・後半を分ける
  let cum = 0;
  const pts = laps.map((l) => ({ ...l, at: (cum += l.distanceKm) }));
  const half = race.distanceKm / 2;
  const sum = (xs: typeof pts) => ({ km: xs.reduce((s, x) => s + x.distanceKm, 0), s: xs.reduce((s, x) => s + x.durationS, 0) });
  const h1 = sum(pts.filter((p) => p.at <= half));
  const h2 = sum(pts.filter((p) => p.at > half));
  const p1 = h1.s / h1.km, p2 = h2.s / h2.km;
  const fade = p2 / p1 - 1;
  // 最初の10kmの平均より8%以上遅いラップが続き始めた地点
  const base = sum(pts.filter((p) => p.at <= 10));
  const basePace = base.s / base.km;
  let wall: number | null = null;
  for (let i = 0; i + 2 < pts.length; i++) {
    const w = sum(pts.slice(i, i + 3));
    if (pts[i].at > 10 && paceOf(pts[i]) > basePace * 1.08 && w.s / w.km > basePace * 1.08) {
      wall = Math.round(pts[i].at - pts[i].distanceKm);
      break;
    }
  }
  const hr1 = avg(pts.filter((p) => p.at <= 10 && p.avgHr).map((p) => p.avgHr!));
  const hr2 = avg(pts.filter((p) => p.at > race.distanceKm - 10 && p.avgHr).map((p) => p.avgHr!));
  let why = "";
  if (!Number.isNaN(hr1) && !Number.isNaN(hr2)) {
    why =
      hr2 < hr1 - 3
        ? `心拍は ${Math.round(hr1)} → ${Math.round(hr2)} と下がっていて、心肺より先に脚かエネルギーが尽きた可能性が高いです（脚づくり・補給で改善しやすいタイプ）。`
        : hr2 > hr1 + 5
          ? `心拍は ${Math.round(hr1)} → ${Math.round(hr2)} と上がりながら遅くなっていて、前半のオーバーペースや暑さ・水分不足の可能性があります。`
          : `心拍は ${Math.round(hr1)} → ${Math.round(hr2)} とほぼ同じで、同じ頑張りでも脚が前に出なくなっていました。`;
  }
  const firstFast = basePace < p1 - 5 ? `最初の10km（${fmtPace(basePace)}/km）が前半平均より速く、入りが速すぎたかもしれません。` : "";
  return {
    id: "fade",
    icon: "📉",
    title: `${Number(race.date.slice(5, 7))}/${Number(race.date.slice(8, 10))} の大会の後半`,
    value: `前半 ${fmtPace(p1)} → 後半 ${fmtPace(p2)}/km（${pct(fade)}）`,
    text: `${wall ? `${wall}km 付近からペースが落ち始めています。` : ""}${firstFast}${why}本番では前半を ${fmtPace(SUB4_SECONDS / 42.195 + 5)}/km に抑え、${wall && wall < 30 ? `${wall}km を越えても粘れるよう` : ""}ロング走で後半の脚を作りましょう。`,
    level: fade > 0.05 ? "warn" : "good",
    coach: wall
      ? `この前の大会、${wall}kmあたりから失速してたわよ。そこを越えられる脚を作るのが、これからの課題！`
      : `この前の大会、後半は${pct(fade)}。ペース配分はまずまずね`,
  };
}

/** 3. ジョグの強度（速すぎるジョグはロング走の疲れにつながる） */
function easyDiscipline(inp: InsightInput): Insight | null {
  const since = addDays(inp.today, -42);
  const runs = inp.activities.filter(isRun).filter((a) => a.date >= since && a.distanceKm < 40);
  const short = runs.filter((a) => a.distanceKm < 15);
  const long = runs.filter((a) => a.distanceKm >= 15);
  if (short.length < 3) return null;
  const limit = inp.ability.paces.jog[0] - 10; // ジョグの速い側より10秒以上速い
  const fast = short.filter((a) => paceOf(a) < limit);
  const share = fast.length / short.length;
  const hrShort = avg(short.filter((a) => a.avgHr).map((a) => a.avgHr!));
  const hrLong = avg(long.filter((a) => a.avgHr).map((a) => a.avgHr!));
  const hrNote =
    !Number.isNaN(hrShort) && !Number.isNaN(hrLong) && hrShort > hrLong + 2
      ? `短いジョグの平均心拍（${Math.round(hrShort)}）が、ロング走（${Math.round(hrLong)}）より高くなっています。`
      : "";
  return {
    id: "easy",
    icon: "🐢",
    title: "ジョグの強さ",
    value: `短いランの ${Math.round(share * 100)}% が設定より速い`,
    text:
      share >= 0.5
        ? `${hrNote}ジョグがポイント練習に近い強さになっていて、疲れが抜けにくく、ロング走や大会の後半に響きやすい状態です。ジョグは ${fmtPace(inp.ability.paces.jog[0])}〜${fmtPace(inp.ability.paces.jog[1])}/km、会話できる楽さを守るのが近道です。`
        : `${hrNote}ジョグはおおむね楽なペースを守れています。`,
    level: share >= 0.5 ? "warn" : "good",
    coach:
      share >= 0.5
        ? `ちょっと聞きなさい。ジョグの${Math.round(share * 10)}割が速すぎ！ 楽に走るのも立派な練習なんだから`
        : "ジョグのペース、ちゃんと守れてるじゃない。その調子よ",
  };
}

/** 4. 心拍効率（同じ心拍でどれだけ速く走れるか）の変化 */
function aerobicEfficiency(inp: InsightInput): Insight | null {
  const runs = inp.activities.filter(isRun).filter((a) => a.avgHr && a.distanceKm >= 5 && a.distanceKm < 40);
  const eff = (a: Activity) => (a.distanceKm * 1000) / (a.durationS / 60) / a.avgHr!; // 1拍あたりの距離（m）
  const recent = runs.filter((a) => a.date > addDays(inp.today, -28));
  const before = runs.filter((a) => a.date <= addDays(inp.today, -28) && a.date > addDays(inp.today, -56));
  if (recent.length < 3 || before.length < 3) return null;
  const e1 = avg(before.map(eff)), e2 = avg(recent.map(eff));
  const ch = e2 / e1 - 1;
  return {
    id: "efficiency",
    icon: "❤️",
    title: "心拍あたりの速さ",
    value: `1拍で ${e2.toFixed(2)}m（4週前比 ${pct(ch)}）`,
    text:
      ch > 0.02
        ? "同じ心拍でより速く走れるようになっています。有酸素の力（土台）が伸びているサインです。"
        : ch < -0.03
          ? "同じ心拍で走れる速さが落ちています。疲れ・暑さ・練習量の減少などが考えられます。続くようなら量より回復を優先しましょう。"
          : "有酸素の力は横ばいです。ジョグを楽に、ロング走を積み重ねると伸びてきます。",
    level: ch > 0.02 ? "good" : ch < -0.03 ? "warn" : "info",
    coach:
      ch > 0.02
        ? "同じ心拍でも速く走れるようになってるわ。ちゃんと強くなってるじゃない！"
        : ch < -0.03
          ? "同じ心拍で走れる速さがちょっと落ちてるわね。疲れてない？ 今は回復を大事にしなさい"
          : "心拍あたりの速さは横ばいね。焦らず積み上げていくわよ",
  };
}

/** 5. 継続性（週ごとの距離の波） */
function consistency(inp: InsightInput): Insight | null {
  const runs = inp.activities.filter(isRun).filter((a) => a.distanceKm < 40);
  const mon = mondayOf(inp.today);
  const weeks = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
    const m = addDays(mon, -7 * i);
    return runs.filter((r) => r.date >= m && r.date < addDays(m, 7)).reduce((s, r) => s + r.distanceKm, 0);
  });
  if (weeks.filter((w) => w > 0).length < 4) return null;
  const mean = avg(weeks);
  const sd = Math.sqrt(avg(weeks.map((w) => (w - mean) ** 2)));
  const cv = sd / mean;
  const lo = Math.round(Math.min(...weeks)), hi = Math.round(Math.max(...weeks));
  return {
    id: "consistency",
    icon: "📊",
    title: "週ごとの距離の波",
    value: `直近8週 ${lo}〜${hi}km（平均 ${Math.round(mean)}km）`,
    text:
      cv > 0.45
        ? "週によって距離の差が大きく、多い週に疲れや故障のリスクがたまりやすい状態です。少ない週を減らして、毎週同じくらい走る方が持久力は伸びます。"
        : "毎週の距離が安定しています。この安定がいちばんの武器です。",
    level: cv > 0.45 ? "warn" : "good",
    coach: cv > 0.45 ? "週ごとの距離、波がありすぎ！ 毎週コツコツの方がずっと強くなれるのよ" : "毎週ちゃんと積み上げてるわね。えらいわ",
  };
}

/** 6. ロング走の備え */
function longReadiness(inp: InsightInput): Insight | null {
  const runs = inp.activities.filter(isRun).filter((a) => a.distanceKm < 40 && daysBetween(a.date, inp.today) <= 56);
  const longest = Math.max(0, ...runs.map((a) => a.distanceKm));
  const n25 = runs.filter((a) => a.distanceKm >= 25).length;
  const toRace = daysBetween(inp.today, RACE_DATE);
  return {
    id: "long",
    icon: "🛣️",
    title: "長い距離への備え",
    value: longest > 0 ? `直近8週の最長 ${Math.round(longest * 10) / 10}km・25km以上 ${n25}回` : "直近8週に記録なし",
    text:
      longest >= 30
        ? "30km を走れています。本番まで、この距離を間隔をあけて維持しましょう。"
        : `本番の後半を支えるのは 25〜30km のロング走です。計画では2月に 30km走を2回入れています（大会まで${toRace}日）。`,
    level: longest >= 25 ? "good" : "info",
    coach: longest >= 30 ? "30kmも走れたなら、もう怖いものなしね" : "30km走は2月に2回。それまでに少しずつ距離を伸ばしていくわよ",
  };
}

/** 7. 負荷比（COROS の数字の意味） */
function loadMeaning(inp: InsightInput): Insight | null {
  const r = inp.loadRatio;
  if (r == null) return null;
  const [level, text]: [Insight["level"], string] =
    r > 1.5
      ? ["warn", "直近の負荷が普段の1.5倍を超えていて、故障しやすい状態です。数日は軽めにしています。"]
      : r > 1.3
        ? ["info", "普段よりやや負荷が高めです。きつい練習は詰め込まないようにしています。"]
        : r >= 0.8
          ? ["good", "普段の練習量に対して、ちょうどよい負荷です。"]
          : ["info", "普段より負荷が低めです。回復期や軽めの週なら問題ありません。続くと走力が落ちていきます。"];
  return {
    id: "load",
    icon: "⚖️",
    title: "いまの負荷",
    value: `負荷比 ${r.toFixed(2)}${inp.loadComment ? `（${inp.loadComment}）` : ""}`,
    text: `負荷比は「直近1週間の負荷 ÷ 普段（約1か月）の負荷」。0.8〜1.3 が目安です。${text}`,
    level,
    coach: r > 1.5 ? "負荷が高すぎ！ 今は休むのも作戦よ" : r > 1.3 ? "負荷はちょっと高めね。張り切りすぎないこと" : r >= 0.8 ? "負荷はちょうどいい感じね" : "負荷は軽め。回復期ならこれでいいのよ",
  };
}

export function computeInsights(inp: InsightInput): Insight[] {
  const all = [enduranceGap, raceFade, easyDiscipline, aerobicEfficiency, consistency, longReadiness, loadMeaning]
    .map((f) => f(inp))
    .filter((x): x is Insight => !!x);
  const order = { warn: 0, good: 1, info: 2 } as const;
  return all.sort((a, b) => order[a.level] - order[b.level]);
}
