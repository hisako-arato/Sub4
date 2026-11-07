// 今日のセリフを話し終えたあとの「おしゃべり」。コーチをタップするたびに1つずつ話す。
// 栄養・いまやるとよいストレッチ（実演つき）・走りのコツ・名ランナーの言葉・雑談・進み具合を混ぜ、
// 日付で並べ替える（同じ日には同じ並び、日が変われば違う並び）。LLM は使わない。
// 名ランナーの言葉は出典のはっきりしたものだけ。訳は意訳で、コーチのひと言を添える。
import type { CoachContext } from "./speech.ts";
import { STRETCHES, type StretchId } from "../care/care.ts";

export interface TalkItem {
  text: string;
  demo?: StretchId; // 話しながらアバターが実演する種目
  topic: "nutrition" | "stretch" | "tip" | "quote" | "chat" | "progress";
}

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** 日付で決まる並べ替え（同じ日は同じ順番） */
function shuffle<T>(seed: string, list: T[]): T[] {
  const a = list.slice();
  let h = hash(seed);
  for (let i = a.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    const j = h % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TIPS = [
  "ジョグは「おしゃべりできるペース」が目安よ。息が上がって話せないなら、それは速すぎ",
  "歩幅を無理に伸ばすより、脚の回転を少し上げるの。着地がやさしくなって、脚が長持ちするわよ",
  "腕は横に振らないで、ひじを後ろに引くの。腕が引ければ、脚は勝手に前に出るんだから",
  "マラソンは前半と後半が同じペースか、後半が少し速いのが理想よ。前半の貯金は、だいたい後半の借金になるの",
  "給水は喉が渇く前に、ひと口ずつ。一気に飲むとお腹がたぷたぷになるわよ",
  "シューズはだいたい500〜800kmでクッションがへたってくるの。COROSで走った距離を見ておきなさい",
  "寝不足だと、せっかくの練習の効果が出にくいの。睡眠も練習メニューの一部よ",
  "上り坂は歩幅を小さく、腕振りを少し強く。上りで頑張りすぎないのがコツよ",
  "本番で新しいものは使わないこと。シューズもウェアもジェルも、練習で試したものだけ！",
  "ロング走は本番の予行演習よ。朝ごはんの時間、ウェア、補給、ぜんぶ本番と同じにしてみなさい",
  "ペースが落ちてきたら、まず姿勢を直すの。頭のてっぺんを上から引っぱられるイメージよ",
  "サブ4のペースは1kmあたり5分41秒。ハーフ地点で2時間を少し切っていれば、計算どおりよ",
  "30kmの壁の原因のひとつは、体の中の糖が減ってくること。だから補給とロング走で備えるのよ",
  "疲れが抜けないときは、休むのがいちばんの近道。走らない勇気も実力のうちよ",
  "スタート直後は周りにつられて速くなりがちなの。最初の5kmは「遅すぎるかな」くらいでちょうどいいわ",
  "苦しくなったら、ゴールじゃなくて次の給水所だけを目指しなさい。目標は小さく刻むのがコツよ",
];

const QUOTES = [
  "キプチョゲの言葉よ。「No human is limited（人間に限界はない）」。ハルキ君の限界だって、まだずっと先なんだから",
  "キプチョゲは「規律ある者だけが自由になれる」って言ってるの。毎日コツコツ続けた人が、最後にいちばん自由に走れるのよ",
  "ザトペックの言葉。「走りたいなら1マイルを走れ。違う人生を味わいたいならマラソンを走れ」。静岡で、違う景色を見に行くわよ",
  "有森裕子さんはアトランタで銅メダルを取ったあと「初めて自分で自分をほめたい」って言ったの。ハルキ君も、ゴールでそう言える準備をするのよ",
  "高橋尚子さんが大切にしていた言葉。「何も咲かない寒い日は、下へ下へと根を伸ばせ。やがて大きな花が咲く」。冬の練習は、まさに根っこの時期よ",
  "村上春樹さんがマラソンの本で紹介してる言葉。「痛みは避けられない。でも苦しみはこちら次第」。同じハルキなんだから、覚えておきなさい",
  "村上春樹さんは、お墓に刻むなら「少なくとも最後まで歩かなかった」がいいって書いてるの。……あたしたちの目標は、それにサブ4を足したものね",
  "プリフォンテーンは「ベストを尽くさないのは、才能を無駄にすることだ」って言ったの。でもジョグの日のベストは、ゆっくり走ることよ。勘違いしないこと！",
  "ジョン・ビンガムの言葉。「奇跡は完走したことじゃない。スタートする勇気を持ったことだ」。ハルキ君はもう、その奇跡を起こしてるのよ",
];

const CHAT = [
  "ねえハルキ君、走ってるとき何考えてる？ あたしは、次にどんな面白い練習をさせようかずっと考えてるわ",
  "静岡マラソンのゴールのあと、何を食べるか決めた？ ご褒美が決まってると、30kmから脚が動くのよ",
  "走るのが好きって、それだけで最強の才能よ。あたしはその才能を、ちゃんと結果につなげてあげるだけ",
  "たまには知らない道を走ってみなさい。景色が変わると、同じ10kmでも全然違うんだから",
  "雨の日は無理に外に出なくていいわ。その日は柔軟と補強の日にすればいいのよ",
  "記録のことばっかり考えてると疲れるでしょ？ 今日の風とか空とか、走ってるときしか分からないものも楽しみなさい",
  "あたしの言うこと、ちゃんと聞いてる？ ……まあ、ここまで続けてるんだから、聞いてるってことにしてあげる",
  "練習の日誌はCOROSが勝手につけてくれるんだから、ハルキ君は走ることだけ考えればいいのよ。楽でしょ？",
];

function seasonal(month: number, daysToRace: number, beforeTaipei: boolean): string[] {
  const out: string[] = [];
  if (beforeTaipei) out.push("台北マラソンが終わったら、小籠包でお祝いね。あ、食べすぎて翌週の回復ジョグがつらくならない程度によ");
  if (month === 11) out.push("11月は走るのにいちばん気持ちいい季節よ。暑くも寒くもない今のうちに、走る習慣を固めておきなさい");
  if (month === 12) out.push("寒くなってきたわね。手袋と耳を温めるだけで、体感がかなり変わるわよ");
  if (month === 1) out.push("お正月で食べすぎた分は、ジョグでゆっくり戻せばいいの。急に走る量を増やすのはダメよ");
  if (month === 2) out.push("2月はいちばん寒いけど、いちばん練習が積める時期よ。ここを越えたら、あとは本番に向けて仕上げるだけ");
  if (month === 3 && daysToRace > 0) out.push("いよいよ3月ね。本番の朝の気温を想像して、ウェアを決めておきなさい");
  if (month >= 12 || month <= 2) out.push("冬の朝は体が温まるまで時間がかかるの。最初の1kmは、いつもよりゆっくりでいいわ");
  return out;
}

export function coachTalk(ctx: CoachContext): TalkItem[] {
  const d = ctx.today;
  const date = d?.date ?? "x";
  const month = Number(date.slice(5, 7)) || 0;
  const pain = ctx.modes.pain;
  const items: TalkItem[] = [];
  const add = (topic: TalkItem["topic"], list: string[]) => list.forEach((text) => items.push({ topic, text }));

  // 栄養（体重から計算。痛みのときも食事の話はしてよい）
  const n = ctx.nutrition;
  if (n) {
    const r5 = (x: number) => Math.round(x / 5) * 5;
    const rng = (a: [number, number]) => `${a[0]}〜${a[1]}`;
    add("nutrition", [
      `今日の炭水化物の目安は${rng(n.carbs.grams)}g。ご飯なら茶碗${rng(n.carbs.riceBowls)}杯分よ。走る人がご飯を抜くなんて、許さないんだから`,
      `たんぱく質は1日${rng(n.protein.grams)}g。一度にじゃなくて、3食に分けて食べるのがコツよ`,
      `走ったあと1時間以内に、たんぱく質${r5(n.weightKg * 0.3)}gと炭水化物を一緒に。牛乳とおにぎりでも十分よ`,
      "走る前と後に体重を量ってみなさい。減った分はほとんど汗。1kg減ってたら、水を1Lくらい取り戻すのよ",
      "ランナーは鉄分が足りなくなりやすいの。赤身のお肉や魚、青菜を意識して食べなさい",
      ...n.tips.map((t) => `それと、${t}。覚えておきなさい`),
    ]);
  }

  // いまやるとよいストレッチ（話しながら実演）。痛みのときは出さない
  if (!pain) {
    const ranToday = !!d?.result && (d.result.state === "ran" || d.result.state === "extra");
    const care = ctx.care;
    if (ranToday && care?.after.length) {
      for (const st of care.after) items.push({ topic: "stretch", demo: st.id, text: `走ったあとの脚、今のうちに${st.name}を${st.holdSec}秒伸ばしておきなさい。ほら、こうよ` });
    } else if (care?.before.length && ctx.hourJst < 20) {
      for (const st of care.before) items.push({ topic: "stretch", demo: st.id, text: `走る前は${st.name}で体を温めるの。こうやって、リズムよくね` });
    }
    items.push({ topic: "stretch", demo: "hipflexor", text: "座りっぱなしだと、股関節の前が縮んで走りが小さくなるの。立ったついでに、こうやって伸ばしなさい" });
    items.push({ topic: "stretch", demo: "anklecircle", text: "テレビを見ながらでいいから、足首を回しなさい。足首がやわらかいと、着地がやさしくなるのよ" });
    items.push({ topic: "stretch", demo: "armcircle", text: "肩が固まってると、腕振りまで小さくなるの。ぐるっと回してほぐしなさい" });
    if (ctx.hourJst >= 20 || ctx.hourJst < 4) items.push({ topic: "stretch", demo: STRETCHES.hamstring.id, text: "寝る前に太もも裏を伸ばしておくと、次の日の脚が軽いわよ。お手本、見せてあげる" });
  }

  add("tip", pain ? TIPS.filter((t) => /休|睡眠|寝/.test(t)) : TIPS);
  add("quote", QUOTES);
  add("chat", CHAT);
  const beforeTaipei = date < "2026-12-20";
  add("chat", seasonal(month, ctx.daysToRace, beforeTaipei));

  // 進み具合（データから）
  if (ctx.daysToRace > 0) add("progress", [`静岡マラソンまであと${ctx.daysToRace}日。1日ずつ、確実に近づいてるわよ`]);
  if (ctx.week.planned > 0)
    add("progress", [ctx.week.done > 0 ? `今週はここまで${ctx.week.done}km走ってるわ。予定はあと${Math.max(0, Math.round((ctx.week.planned - ctx.week.done) * 10) / 10)}kmよ` : `今週の予定は${ctx.week.planned}km。一歩ずつ積み上げるわよ`]);
  if (ctx.phaseLabel) add("progress", [`今は${ctx.phaseLabel}。時期ごとにやることが違うの。全体の流れはコーチのタブで見られるわよ`]);
  for (const x of ctx.insights ?? []) items.push({ topic: "progress", text: x.coach });

  // 話題が偏らないように、話題ごとに順番に並べる（各話題の中は日替わり）
  const groups = new Map<string, TalkItem[]>();
  for (const it of items) groups.set(it.topic, [...(groups.get(it.topic) ?? []), it]);
  const order = shuffle(date + "topics", [...groups.keys()]);
  const queues = order.map((k) => shuffle(date + k, groups.get(k)!));
  // 今やるとよいストレッチと栄養は前のほうに
  queues.sort((a, b) => rank(a[0].topic) - rank(b[0].topic));
  const out: TalkItem[] = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift()!);
  return out;
}

function rank(t: TalkItem["topic"]): number {
  return t === "stretch" ? 0 : t === "nutrition" ? 1 : 2;
}
