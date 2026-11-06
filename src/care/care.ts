// ケア・休養のおすすめ。練習の内容に応じてストレッチとセルフケアを選ぶ。
// ストレッチはすべて立ったままできる種目（アバターが見本を見せやすいように）。
import type { Session } from "../plan/generate.ts";

export type StretchId = "legswing" | "calf" | "quad" | "hamstring" | "hipflexor" | "glute" | "side" | "shoulder";

export interface Stretch {
  id: StretchId;
  name: string;
  target: string;
  kind: "dynamic" | "static";
  holdSec: number; // 静的：保持秒数／動的：回数の目安に使う
  sides: boolean;
  steps: string[];
}

export const STRETCHES: Record<StretchId, Stretch> = {
  legswing: {
    id: "legswing", name: "レッグスイング", target: "股関節まわり", kind: "dynamic", holdSec: 10, sides: true,
    steps: ["壁や柱に片手をついてまっすぐ立つ", "外側の脚を前後に大きく振る（10回）", "反対の脚も同じように"],
  },
  calf: {
    id: "calf", name: "ふくらはぎ", target: "ふくらはぎ・アキレス腱", kind: "static", holdSec: 30, sides: true,
    steps: ["壁に両手をついて、片脚を大きく後ろへ引く", "後ろ脚のかかとを床につけたまま、ひざを伸ばす", "前のひざを曲げて体重を前へ。ふくらはぎが伸びたところで止める"],
  },
  quad: {
    id: "quad", name: "太もも前", target: "大腿四頭筋", kind: "static", holdSec: 30, sides: true,
    steps: ["片手を壁について片脚で立つ", "反対の足首を同じ側の手で持ち、かかとをお尻に近づける", "ひざは真下に向けて、腰を反らさない"],
  },
  hamstring: {
    id: "hamstring", name: "太もも裏", target: "ハムストリングス", kind: "static", holdSec: 30, sides: true,
    steps: ["片脚を半歩前に出し、かかとを床につけてつま先を上げる", "後ろのひざを軽く曲げ、背すじを伸ばしたまま股関節から前に倒れる", "太もも裏が伸びたところで止める"],
  },
  hipflexor: {
    id: "hipflexor", name: "股関節前", target: "腸腰筋", kind: "static", holdSec: 30, sides: true,
    steps: ["脚を前後に大きく開く", "上体をまっすぐ起こしたまま、腰を前下へ沈める", "後ろ脚の付け根の前が伸びたところで止める"],
  },
  glute: {
    id: "glute", name: "お尻（立ったまま4の字）", target: "大殿筋・梨状筋", kind: "static", holdSec: 20, sides: true,
    steps: ["壁や椅子につかまって片脚で立つ", "反対の足首を、立っている脚のひざの上にのせる", "椅子に座るようにお尻を後ろへ引く"],
  },
  side: {
    id: "side", name: "体側", target: "体側・腸脛靭帯まわり", kind: "static", holdSec: 20, sides: true,
    steps: ["脚を交差させて立つ（右脚を前に）", "両腕を頭の上に伸ばし、上体を左へ倒す", "反対側も同じように"],
  },
  shoulder: {
    id: "shoulder", name: "肩・背中", target: "肩まわり", kind: "static", holdSec: 20, sides: true,
    steps: ["片腕を胸の前でまっすぐ横に伸ばす", "反対の腕でひじの上あたりを胸に引き寄せる", "肩が上がらないように"],
  },
};

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
      title: "休養日のケア",
      before: [],
      after: ["side", "shoulder", "hipflexor", "glute"],
      selfCare: ["ゆっくり湯船につかる", "15〜30分の散歩もおすすめ", "睡眠は7時間以上を目安に"],
    };
  }
  if (session.category === "race") {
    return {
      title: "レースの日",
      before: ["legswing"],
      after: ["calf", "quad", "hamstring"],
      selfCare: ["スタート前は動的ストレッチと軽いジョグで体を温める", "ゴール後はまず歩いて、水分と補給を", "当日は湯船は短めに、早めに休む"],
    };
  }
  if (session.category === "distance" && session.distanceKm >= 16) {
    return {
      title: "ロング走のあと",
      before: ["legswing"],
      after: ["calf", "quad", "hamstring", "hipflexor", "glute"],
      selfCare: ["走り終えたら5分歩いてクールダウン", "1時間以内に補給（下の栄養を参照）", "湯船につかって、いつもより早めに寝る"],
    };
  }
  if (session.hard) {
    return {
      title: "ポイント練習のあと",
      before: ["legswing"],
      after: ["calf", "hamstring", "hipflexor"],
      selfCare: ["走る前は動的ストレッチ、走ったあとは静的ストレッチ", "ダウンのジョグは省略しない", "睡眠をしっかり"],
    };
  }
  return {
    title: "ジョグのあと",
    before: [],
    after: ["calf", "quad", "hamstring"],
    selfCare: ["各30秒、反動をつけずにゆっくり伸ばす", "気持ちいい程度で止める（痛いまで伸ばさない）"],
  };
}
