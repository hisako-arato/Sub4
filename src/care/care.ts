// ケア・休養のおすすめ。練習の内容に応じて、その日に必要な種目だけを選ぶ（今日）。
// 全種目はいつでも見られる（すべて）。どの種目もアバターが実演する（public/stretch-motion.js）。
import type { Session } from "../plan/generate.ts";

export type StretchId =
  | "legswing" | "hipcircle" | "highknee" // ウォームアップ（動的）
  | "calf" | "quad" | "hamstring" | "hipflexor" | "glute" | "side" | "shoulder" // ストレッチ（静的）
  | "anklecircle" | "armcircle" // 柔軟
  | "calfraise" | "singlesquat" | "splitsquat" | "hiplift" | "plank"; // 補強（筋トレ）

export type CareCategory = "warmup" | "stretch" | "mobility" | "strength";
export const CATEGORY_JA: Record<CareCategory, string> = { warmup: "ウォームアップ", stretch: "ストレッチ", mobility: "柔軟", strength: "補強（筋トレ）" };

export interface Stretch {
  id: StretchId;
  name: string;
  target: string;
  category: CareCategory;
  kind: "dynamic" | "static" | "reps"; // 動的（時間）／静的（保持）／回数
  holdSec: number; // 静的：保持秒数／動的：続ける秒数／回数：1回あたりの秒数×回数の目安
  reps?: number; // 回数の種目：1セットの回数
  sets?: number;
  sides: boolean;
  steps: string[];
}

const BASE_STRETCHES: Partial<Record<StretchId, Stretch>> = {
  legswing: {
    id: "legswing", category: "warmup", name: "レッグスイング", target: "股関節まわり", kind: "dynamic", holdSec: 10, sides: true,
    steps: ["壁や柱に片手をついてまっすぐ立つ", "外側の脚を前後に大きく振る（10回）", "反対の脚も同じように"],
  },
  calf: {
    id: "calf", category: "stretch", name: "ふくらはぎ", target: "ふくらはぎ・アキレス腱", kind: "static", holdSec: 30, sides: true,
    steps: ["壁に両手をついて、片脚を大きく後ろへ引く", "後ろ脚のかかとを床につけたまま、ひざを伸ばす", "前のひざを曲げて体重を前へ。ふくらはぎが伸びたところで止める"],
  },
  quad: {
    id: "quad", category: "stretch", name: "太もも前", target: "大腿四頭筋", kind: "static", holdSec: 30, sides: true,
    steps: ["片手を壁について片脚で立つ", "反対の足首を同じ側の手で持ち、かかとをお尻に近づける", "ひざは真下に向けて、腰を反らさない"],
  },
  hamstring: {
    id: "hamstring", category: "stretch", name: "太もも裏", target: "ハムストリングス", kind: "static", holdSec: 30, sides: true,
    steps: ["片脚を半歩前に出し、かかとを床につけてつま先を上げる", "後ろのひざを軽く曲げ、背すじを伸ばしたまま股関節から前に倒れる", "太もも裏が伸びたところで止める"],
  },
  hipflexor: {
    id: "hipflexor", category: "stretch", name: "股関節前", target: "腸腰筋", kind: "static", holdSec: 30, sides: true,
    steps: ["脚を前後に大きく開く", "上体をまっすぐ起こしたまま、腰を前下へ沈める", "後ろ脚の付け根の前が伸びたところで止める"],
  },
  glute: {
    id: "glute", category: "stretch", name: "お尻（立ったまま4の字）", target: "大殿筋・梨状筋", kind: "static", holdSec: 20, sides: true,
    steps: ["壁や椅子につかまって片脚で立つ", "反対の足首を、立っている脚のひざの上にのせる", "椅子に座るようにお尻を後ろへ引く"],
  },
  side: {
    id: "side", category: "stretch", name: "体側", target: "体側・腸脛靭帯まわり", kind: "static", holdSec: 20, sides: true,
    steps: ["脚を交差させて立つ（右脚を前に）", "両腕を頭の上に伸ばし、上体を左へ倒す", "反対側も同じように"],
  },
  shoulder: {
    id: "shoulder", category: "stretch", name: "肩・背中", target: "肩まわり", kind: "static", holdSec: 20, sides: true,
    steps: ["片腕を胸の前でまっすぐ横に伸ばす", "反対の腕でひじの上あたりを胸に引き寄せる", "肩が上がらないように"],
  },
};

// ---- 追加の種目 ----
const EXTRA_STRETCHES: Partial<Record<StretchId, Stretch>> = {
  hipcircle: {
    id: "hipcircle", category: "warmup", name: "股関節回し", target: "股関節", kind: "dynamic", holdSec: 12, sides: true,
    steps: ["手を腰に当てて片脚で立つ（ふらつくなら壁に手を）", "反対のひざを前に上げ、外へ大きく円を描くように回す（5回）", "逆回しも5回。反対の脚も同じように"],
  },
  highknee: {
    id: "highknee", category: "warmup", name: "もも上げ", target: "股関節・ふくらはぎ", kind: "dynamic", holdSec: 15, sides: false,
    steps: ["背すじを伸ばして立つ", "その場で、ももを腰の高さまで交互に上げる", "腕も大きく振って、リズムよく15秒"],
  },
  anklecircle: {
    id: "anklecircle", category: "mobility", name: "足首回し", target: "足首", kind: "dynamic", holdSec: 12, sides: true,
    steps: ["壁や椅子につかまって片脚で立つ", "反対のつま先を床につけ、足首で大きく円を描く（右回り10回）", "左回りも10回。反対の足も同じように"],
  },
  armcircle: {
    id: "armcircle", category: "mobility", name: "肩回し", target: "肩・肩甲骨", kind: "dynamic", holdSec: 15, sides: false,
    steps: ["足を腰幅に開いて立つ", "両腕を伸ばして、前から後ろへ大きく回す（10回）", "肩甲骨が動くのを感じながら、後ろから前へも10回"],
  },
  calfraise: {
    id: "calfraise", category: "strength", name: "カーフレイズ", target: "ふくらはぎ（後半の蹴り出し）", kind: "reps", holdSec: 2.5, reps: 15, sets: 2, sides: false,
    steps: ["壁に軽く手をついて、足を腰幅に開いて立つ", "かかとをできるだけ高く上げて、1秒止める", "ゆっくり下ろす。かかとは床につくギリギリまで"],
  },
  singlesquat: {
    id: "singlesquat", category: "strength", name: "片脚スクワット", target: "太もも・お尻（着地を支える力）", kind: "reps", holdSec: 3, reps: 8, sets: 2, sides: true,
    steps: ["片脚で立ち、反対の足は少し前に浮かせる（壁に手をついてもOK）", "お尻を後ろに引きながら、ひざを軽く曲げる（ひざがつま先より内に入らないように）", "ゆっくり立ち上がる"],
  },
  splitsquat: {
    id: "splitsquat", category: "strength", name: "スプリットスクワット", target: "太もも・お尻", kind: "reps", holdSec: 3, reps: 10, sets: 2, sides: true,
    steps: ["脚を前後に大きく開いて立つ", "上体をまっすぐにしたまま、後ろのひざを床に近づけるように腰を沈める", "前の脚で床を押して戻る"],
  },
  hiplift: {
    id: "hiplift", category: "strength", name: "ヒップリフト", target: "お尻・太もも裏（後半の失速対策）", kind: "reps", holdSec: 3, reps: 12, sets: 2, sides: false,
    steps: ["あお向けに寝て、ひざを立てる（足は腰幅）", "お尻を持ち上げ、肩からひざまで一直線で1秒止める", "ゆっくり下ろす。腰は反らさない"],
  },
  plank: {
    id: "plank", category: "strength", name: "プランク", target: "体幹（フォームの安定）", kind: "static", holdSec: 30, sets: 2, sides: false,
    steps: ["うつ伏せになり、ひじを肩の真下について体を持ち上げる", "頭からかかとまで一直線にする（お尻を上げすぎない・下げない）", "お腹に力を入れたまま、呼吸は止めない"],
  },
};

export const STRETCHES = { ...BASE_STRETCHES, ...EXTRA_STRETCHES } as Record<StretchId, Stretch>;

/** 「すべて」：カテゴリごとの全種目 */
export function careLibrary() {
  const cats: CareCategory[] = ["warmup", "stretch", "mobility", "strength"];
  return cats.map((c) => ({ category: c, label: CATEGORY_JA[c], items: Object.values(STRETCHES).filter((x) => x.category === c).map((x) => x.id) }));
}

export interface CarePlan {
  title: string;
  before: StretchId[];
  after: StretchId[];
  selfCare: string[];
  caution?: string;
}

/** 今日のおすすめケア */
export function careFor(session: Session | null, opts: { pain: boolean; raceDayAfter?: boolean }): CarePlan {
  if (opts.pain) {
    return {
      title: "痛みがあるとき",
      before: [],
      after: [],
      selfCare: ["痛む場所はストレッチしない・もまない", "痛む場所は冷やして休ませる", "ぐっすり眠る"],
      caution: "痛みが続く・強くなる・腫れがあるときは、無理をせず医療機関を受診してください。",
    };
  }
  if (opts.raceDayAfter) {
    return {
      title: "大会の翌日",
      before: [],
      after: ["calf", "quad", "shoulder"],
      selfCare: ["軽く歩いて血のめぐりをよくする", "強いマッサージは数日待つ", "いつもより長く眠る"],
    };
  }
  if (!session) {
    return {
      title: "休養日のケア（柔軟）",
      before: [],
      after: ["hipcircle", "anklecircle", "armcircle", "side", "glute"],
      selfCare: ["ゆっくり湯船につかる", "15〜30分の散歩もおすすめ", "睡眠は7時間以上を目安に"],
    };
  }
  if (session.category === "race") {
    return {
      title: "レースの日",
      before: ["legswing", "hipcircle", "highknee"],
      after: ["calf", "quad", "hamstring"],
      selfCare: ["スタート前は動的ストレッチと軽いジョグで体を温める", "ゴール後はまず歩いて、水分と補給を", "当日は湯船は短めに、早めに休む"],
    };
  }
  if (session.category === "distance" && session.distanceKm >= 16) {
    return {
      title: "ロング走のあと",
      before: ["legswing", "hipcircle"],
      after: ["calf", "quad", "hamstring", "hipflexor", "glute"],
      selfCare: ["走り終えたら5分歩いてクールダウン", "1時間以内に補給（下の栄養を参照）", "湯船につかって、いつもより早めに寝る"],
    };
  }
  if (session.hard) {
    return {
      title: "ポイント練習のあと",
      before: ["legswing", "hipcircle", "highknee"],
      after: ["calf", "hamstring", "hipflexor"],
      selfCare: ["走る前は動的ストレッチ、走ったあとは静的ストレッチ", "ダウンのジョグは省略しない", "睡眠をしっかり"],
    };
  }
  return {
    title: "ジョグのあと",
    before: ["legswing", "hipcircle"],
    after: ["calf", "quad", "hamstring"],
    selfCare: ["各30秒、反動をつけずにゆっくり伸ばす", "気持ちいい程度で止める（痛いまで伸ばさない）"],
  };
}
