// コーチ（涼宮ハルヒ風の口調）のセリフ。ルールベースで定型文を組み合わせる（LLM は使わない）。
// 話し方の特徴（一人称「あたし」、強気な命令口調、面白いこと好き、面倒見がいい）をまねたオリジナルの文。
// 作品中のセリフはそのまま使わない。安全に関わる内容（痛み・受診）ははっきり伝える。
import type { DayPlan, Session } from "../plan/generate.ts";
import type { Phase } from "../plan/calendar.ts";
import type { Stretch } from "../care/care.ts";

export type Expression = "neutral" | "happy" | "angry" | "sad" | "relaxed" | "surprised";

export interface CoachContext {
  today: DayPlan | null;
  daysToRace: number;
  phase: Phase | null;
  phaseLabel: string | null;
  connected: boolean;
  stale: boolean;
  modes: { pain: boolean; fatigue: boolean; comeback: boolean };
  hourJst: number;
  week: { done: number; planned: number };
  upcomingTuneup: { name: string; inDays: number } | null;
  care?: { title: string; before: Stretch[]; after: Stretch[] } | null;
  insights?: { level: string; coach: string }[];
  name?: string;
}

export interface Speech {
  expression: Expression;
  lines: string[];
}

/** 日付ごとに変わり、同じ日には同じ言い回しを選ぶ */
function pick<T>(seed: string, list: T[]): T {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

const PHASE_TALK: Record<Phase, string[]> = {
  recovery: ["今は回復期。焦らずのんびり走りなさい", "回復期なんだから、物足りないくらいでちょうどいいのよ"],
  base: ["今は土台作りの時期よ。距離に慣れるのが今の仕事", "基礎期は地味だけど、ここをサボると後で泣くわよ"],
  build: ["ここからはスピードとペースも鍛えていくわよ", "強化期突入！ 面白くなってきたじゃない"],
  peak: ["いちばんきつい時期。でもいちばん伸びる時期でもあるの", "ピーク期よ。30km走を乗り越えたら、サブ4はもう目の前なんだから"],
  taper: ["量を減らして疲れを抜く時期。走り足りなくても我慢よ", "テーパー期は休むのが仕事。余計なことしちゃダメよ"],
  race: ["いよいよ大会週！ あとは体調を整えるだけ", "大会週よ。ここまで来たら、あたしたちの勝ちは決まったようなものね"],
};

function sessionLine(s: Session, seed: string, optional: boolean): string {
  const km = `${s.distanceKm}km`;
  if (optional) {
    return pick(seed, [
      `今日は走っても走らなくてもいい日。走りたいなら${km}、のんびりね`,
      `余裕があるなら${km}だけ走ってもいいわよ。無理ならパス！`,
    ]);
  }
  if (s.category === "race") {
    if (/台北/.test(s.title)) return "台北マラソンよ！ 今日は記録じゃなくて、思いっきり楽しむこと。それが今日のメニュー！";
    return "今日が本番よ、ハルキ君！ 前半は抑えて、30kmからが勝負。サブ4、取りに行くわよ！";
  }
  const t = s.title.replace(/（短縮）$/, "");
  switch (true) {
    case t === "30km走":
      return pick(seed, [`いよいよ30km走よ！ ${s.pace}で、給水と補給の練習も忘れないこと`, `30km走！ これを越えたら本番の景色が変わるわよ。ペースは${s.pace}`]);
    case s.category === "distance":
      return pick(seed, [`今日は${km}の${t}！ ${s.pace}で最後まで同じペースを守るのよ`, `${t}${km}よ。速く走る日じゃないの、長く走る日なんだから`]);
    case t === "マラソンペース走":
      return pick(seed, [`マラソンペース走よ。${s.pace}を体に叩き込みなさい！`, `本番のペースは${s.pace}。今日はそれを覚える日よ`]);
    case t === "閾値走":
      return pick(seed, [`閾値走！ ${s.pace}で、きついけど続けられる境目を攻めるのよ`, `今日は閾値走。苦しくなってからが本番よ`]);
    case s.category === "speed":
      return pick(seed, [`${t}よ！ 苦しいときこそ面白くなるんだから`, `今日はスピード練習！ ${s.pace}で、脚に速さを思い出させてあげなさい`]);
    case t === "ビルドアップ走":
      return `ビルドアップ走！ だんだん速くして、最後は${s.pace.split("→").at(-1)}まで上げるのよ`;
    case t === "ジョグ＋流し":
      return pick(seed, [`${km}ジョグのあとに流しを5本。最後にちょっと速く走るの、気持ちいいわよ`, `ジョグと流しね。流しは全力じゃなくて8割よ、8割！`]);
    case t === "刺激入れ":
      return "大会前の刺激入れよ。脚を使い切らないこと！";
    default:
      return pick(seed, [`今日は${km}の${t}。${s.pace}で、おしゃべりできるくらいの楽さよ`, `${t}${km}！ のんびり楽しく走りなさい`]);
  }
}

export function coachSpeech(ctx: CoachContext): Speech {
  const name = ctx.name ?? "ハルキ君";
  const d = ctx.today;
  const seed = d?.date ?? "x";
  const lines: string[] = [];
  let expression: Expression = "happy";

  const h = ctx.hourJst;
  lines.push(
    h >= 5 && h < 10
      ? pick(seed + "g", [`おはよう、${name}！`, `${name}、朝よ！ 起きてる？`])
      : h >= 10 && h < 17
        ? pick(seed + "g", [`${name}、来たわね！`, `待ってたわよ、${name}！`])
        : h >= 17 && h < 23
          ? pick(seed + "g", [`おつかれ、${name}。`, `${name}、今日も一日よく頑張ったわね。`])
          : `こんな時間まで起きてるの？ ${name}、寝るのも練習のうちよ。`,
  );

  if (!ctx.connected) {
    lines.push("まずはCOROSとつなぎなさい！ データがないと何も始まらないじゃない");
    return { expression: "angry", lines };
  }
  if (ctx.stale) {
    lines.push("ちょっと、データが古いわよ！ 同期ボタンを押しなさい");
    expression = "angry";
  }

  if (ctx.modes.pain) {
    lines.push("痛みがあるなら絶対に無理しちゃダメ。今は休むのがいちばんの練習よ");
    lines.push("痛みが続いたり強くなったりしたら、ちゃんと病院で診てもらいなさい。これは命令よ");
    return { expression: "sad", lines };
  }

  const r = d?.result;
  const chosen = d ? (d.choice >= 0 && d.subs[d.choice]) || d.main : null;
  if (r && r.state !== "rest") {
    const a = r.achievement;
    if (r.state === "ran" && a) {
      if (a.flags.includes("fast") && chosen && !chosen.hard) {
        lines.push(`ちょっと！ ジョグなのに${a.avgPace}/kmは速すぎよ。ゆっくり走るのも練習なの！`);
        expression = "angry";
      } else if (a.level === "achieved") {
        lines.push(pick(seed + "r", [`今日の${chosen?.title ?? "練習"}、ばっちりよ！ さすがあたしが見込んだだけのことはあるわね`, `やるじゃない、${name}！ 今日のメニューは完璧よ`]));
        expression = "happy";
      } else if (a.level === "partial") {
        lines.push("今日はちょっと足りなかったわね。でも走っただけ偉いわ。次で取り返すわよ");
        expression = "relaxed";
      } else {
        lines.push("走ったのは偉いけど、メニューには届かなかったわね。体調は大丈夫？");
        expression = "neutral";
      }
    } else if (r.state === "ran_manual") {
      lines.push("記録したわね。よしよし、ちゃんと報告できるのは偉いわ");
    } else if (r.state === "extra") {
      lines.push(d?.actual.some((x) => x.distanceKm >= 40) ? "完走おめでとう！ 今日はとにかく休んで、美味しいものを食べなさい" : "休みの日なのに走ったの!? 好きなのは分かるけど、休むのも大事なのよ");
      expression = "surprised";
    } else if (r.state === "skipped") {
      lines.push(r.reason === "fatigue" ? "疲れてるのね。今日はゆっくり休みなさい。計画はあたしが直しとくから" : "今日は走らないのね。分かったわ、次で取り返せばいいのよ");
      expression = "relaxed";
    } else if (r.state === "off") {
      lines.push("今日は予定があるのね。了解、計画はあたしが組み直しといてあげる");
      expression = "relaxed";
    }
  } else if (d?.log?.status === "off") {
    lines.push("今日は予定があるのね。了解、計画はあたしが組み直しといてあげる");
    expression = "relaxed";
  } else if (chosen) {
    lines.push(sessionLine(chosen, seed + "s", d!.optional));
    if (d!.choice >= 0) lines.push(`気分で「${chosen.title}」にしたのね。いいじゃない、面白そう！`);
    if (ctx.modes.fatigue) expression = "relaxed";
    else if (ctx.modes.comeback) lines.push(`おかえり、${name}。しばらく空いたから、まずは軽めから戻していくわよ`);
  } else if (d) {
    lines.push(pick(seed + "rest", ["今日は休養日！ 休むのも練習のうちなんだから、ちゃんと休みなさい", "今日は走っちゃダメよ。脚を休ませて、次の練習に備えるの"]));
    expression = expression === "angry" ? "angry" : "relaxed";
  }

  // 計画を調整した理由（コーチのひと言）
  if (d?.notes.length) lines.push(d.notes[0]);

  // データから分かったこと（気づき）。注意すべきものを優先し、日替わりで1つ
  const ins = ctx.insights ?? [];
  const pool = ins.filter((x) => x.level === "warn").length ? ins.filter((x) => x.level === "warn") : ins;
  if (pool.length) lines.push(pick(seed + "i", pool).coach);

  // おすすめのストレッチ（動作の見本はまだないので、言葉で伝える）
  const c = ctx.care;
  if (c && c.after.length) {
    const names = c.after.map((x) => x.name).join("・");
    const hold = Math.max(...c.after.map((x) => x.holdSec));
    const pre = c.before.length ? `走る前は${c.before.map((x) => x.name).join("・")}で体を温めて、` : "";
    lines.push(
      chosen
        ? `${pre}走ったあとは${names}を${hold}秒ずつ伸ばしなさい。やり方は下の「今日のケア」から聞いてね`
        : `休みの日は${names}で体をゆるめるのがおすすめよ。やり方は下の「今日のケア」から聞いてね`,
    );
  }

  // 最後にもうひと言
  if (ctx.daysToRace <= 7 && ctx.daysToRace > 0) {
    lines.push(`静岡マラソンまであと${ctx.daysToRace}日！ ここまで来たら、あとは疲れを抜くだけよ`);
  } else if (ctx.upcomingTuneup && ctx.upcomingTuneup.inDays > 0 && ctx.upcomingTuneup.inDays <= 7) {
    lines.push(`${ctx.upcomingTuneup.name}まであと${ctx.upcomingTuneup.inDays}日ね。楽しむ準備はできてる？`);
  } else if (ctx.phase) {
    lines.push(
      pick(seed + "p", [
        pick(seed + "pp", PHASE_TALK[ctx.phase]),
        `静岡マラソンまであと${ctx.daysToRace}日。サブ4、絶対に取るわよ！`,
        ctx.week.done > 0 ? `今週はここまで${ctx.week.done}km。あと${ctx.week.planned}kmよ` : `今週の予定は${ctx.week.planned}km。一緒に積み上げていくわよ`,
      ]),
    );
  }
  return { expression, lines: lines.slice(0, 7) };
}

/** ストレッチのやり方を、コーチが順番に説明するセリフ */
export function stretchSpeech(st: Stretch, name = "ハルキ君"): Speech {
  const order = ["まず、", "次に、", "それから、", "最後に、"];
  const steps = st.steps.map((x, i) => `${i === st.steps.length - 1 && i > 0 ? "最後に、" : order[Math.min(i, 2)]}${x}`);
  const finish =
    st.kind === "dynamic"
      ? "反動は大きくしすぎないで、リズムよくね。走る前に体を温めるためのものよ"
      : `そのまま${st.holdSec}秒キープ${st.sides ? "、反対側も同じように" : ""}。反動はつけないで、気持ちいいところで止めるのよ。痛いまで伸ばしたら承知しないんだから`;
  return {
    expression: "happy",
    lines: [`${st.name}ね、${name}。${st.target}に効くわよ`, ...steps, finish],
  };
}
