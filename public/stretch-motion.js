// ストレッチの動き（自作キーフレーム。外部のモーション素材は使わない）。
// VRM の正規化ボーン（Tポーズで回転0、体は +Z を向く）に対する回転 [x, y, z]（ラジアン）。
//  - 脚：x がマイナスで前へ上がる、ひざは x プラスで曲がる。足首は「脚の合計の逆」で床に平ら
//  - 体：spine/chest の x プラスで前かがみ、z マイナスで体の左側へ倒れる
//  - 腕：左腕は z マイナスで下がり y マイナスで前へ／右腕は符号が逆
//  - 回転は z → y → x の順にかかる。下ろした腕を後ろへ振るのは x、上げた太ももを内・外にひねるのは y
// 「左側」の姿勢だけ書き、右側は左右を入れ替えて作る。

const BASE = {
  leftUpperArm: [0, 0, -1.25], leftLowerArm: [0, -0.12, 0],
  rightUpperArm: [0, 0, 1.25], rightLowerArm: [0, 0.12, 0],
};

/** 左右を入れ替える（x はそのまま、y・z は符号を反転） */
export function mirror(pose) {
  const out = {};
  for (const [k, v] of Object.entries(pose)) {
    const m = k.startsWith("left") ? "right" + k.slice(4) : k.startsWith("right") ? "left" + k.slice(5) : k;
    out[m] = [v[0], -v[1], -v[2]];
  }
  return out;
}

const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
/** 2つの姿勢を混ぜる（b の割合 k） */
export function blend(a, b, k) {
  const out = {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[name] ?? [0, 0, 0], y = b[name] ?? [0, 0, 0];
    out[name] = [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
  }
  return out;
}

/** 呼吸に合わせて少し深く（d：深める方向の差分） */
const deepen = (pose, d, t) => {
  const k = (Math.sin(t * 1.6) * 0.5 + 0.5);
  const out = { ...pose };
  for (const [n, v] of Object.entries(d)) out[n] = add(pose[n] ?? [0, 0, 0], v, k);
  return out;
};

// 各種目：yaw（体の向き。横から見せる種目は横向き）、pose(t)（構えた後の時間 t 秒）
export const STRETCH_MOTION = {
  // レッグスイング（動的）：壁に右手、左脚を前後に振る
  legswing: {
    yaw: -Math.PI / 2,
    pose: (t) => {
      const s = Math.sin(t * (Math.PI * 2) / 1.4);
      return {
        ...BASE,
        rightUpperArm: [0, 0, 0.35], rightLowerArm: [0, 0.1, 0],
        leftUpperArm: [0, s * 0.35, -1.2],
        leftUpperLeg: [-0.35 - s * 0.5, 0, 0], leftLowerLeg: [0.15 + Math.max(0, s) * 0.25, 0, 0], leftFoot: [0.2, 0, 0],
        spine: [0.04, 0, 0],
      };
    },
  },
  // ふくらはぎ：両手を壁、左脚を後ろに引いてかかとを床に
  calf: {
    yaw: -Math.PI / 2,
    pose: (t) =>
      deepen(
        {
          leftUpperArm: [0, -1.45, -0.25], leftLowerArm: [0, -0.25, 0],
          rightUpperArm: [0, 1.45, 0.25], rightLowerArm: [0, 0.25, 0],
          rightUpperLeg: [-0.55, 0, 0], rightLowerLeg: [0.8, 0, 0], rightFoot: [-0.25, 0, 0],
          leftUpperLeg: [0.5, 0, 0], leftLowerLeg: [0, 0, 0], leftFoot: [-0.5, 0, 0],
          spine: [0.28, 0, 0], chest: [0.08, 0, 0], neck: [-0.2, 0, 0], head: [-0.1, 0, 0],
        },
        { rightLowerLeg: [0.12, 0, 0], rightFoot: [-0.06, 0, 0], spine: [0.04, 0, 0] },
        t,
      ),
  },
  // 太もも前：右手を壁、左足首を左手で持ってかかとをお尻へ
  quad: {
    yaw: -Math.PI / 2,
    pose: (t) =>
      deepen(
        {
          rightUpperArm: [0, 0.6, 0.35], rightLowerArm: [0, 0.2, 0],
          leftUpperArm: [0.55, 0, -1.3], leftLowerArm: [0, 0, 0],
          leftUpperLeg: [0.05, 0, 0], leftLowerLeg: [2.7, 0, 0], leftFoot: [0.45, 0, 0],
          rightUpperLeg: [0, 0, 0], rightLowerLeg: [0.05, 0, 0], rightFoot: [-0.05, 0, 0],
          spine: [-0.02, 0, 0],
        },
        { leftUpperLeg: [0.1, 0, 0], leftUpperArm: [0, 0.08, 0] },
        t,
      ),
  },
  // 太もも裏：左脚を前に出してつま先を上げ、股関節から前へ
  hamstring: {
    yaw: -Math.PI / 2,
    pose: (t) =>
      deepen(
        {
          leftUpperLeg: [-0.45, 0, 0], leftLowerLeg: [0, 0, 0], leftFoot: [-0.35, 0, 0],
          rightUpperLeg: [0.25, 0, 0], rightLowerLeg: [0.55, 0, 0], rightFoot: [-0.8, 0, 0],
          spine: [0.45, 0, 0], chest: [0.15, 0, 0], neck: [-0.25, 0, 0], head: [-0.15, 0, 0],
          leftUpperArm: [0, -0.55, -1.05], leftLowerArm: [0, -0.2, 0],
          rightUpperArm: [0, 0.55, 1.05], rightLowerArm: [0, 0.2, 0],
        },
        { spine: [0.08, 0, 0], leftUpperArm: [0, -0.08, 0], rightUpperArm: [0, 0.08, 0] },
        t,
      ),
  },
  // 股関節前：脚を前後に大きく開き、上体を起こしたまま腰を沈める（左脚が後ろ）
  hipflexor: {
    yaw: -Math.PI / 2,
    pose: (t) =>
      deepen(
        {
          rightUpperLeg: [-1.15, 0, 0], rightLowerLeg: [1.15, 0, 0], rightFoot: [0, 0, 0],
          leftUpperLeg: [0.8, 0, 0], leftLowerLeg: [0.25, 0, 0], leftFoot: [0.25, 0, 0],
          spine: [-0.08, 0, 0], chest: [-0.04, 0, 0],
          leftUpperArm: [0, 0.35, -1.05], leftLowerArm: [0, -1.5, 0],
          rightUpperArm: [0, -0.35, 1.05], rightLowerArm: [0, 1.5, 0],
        },
        { rightUpperLeg: [-0.08, 0, 0], rightLowerLeg: [0.1, 0, 0], leftUpperLeg: [0.08, 0, 0] },
        t,
      ),
  },
  // お尻（立ったまま4の字）：右脚で立って腰を引き、左足首を右ひざにのせる
  glute: {
    yaw: -0.5,
    pose: (t) =>
      deepen(
        {
          rightUpperLeg: [-0.75, 0, 0], rightLowerLeg: [1.0, 0, 0], rightFoot: [-0.25, 0, 0],
          leftUpperLeg: [-1.4, 1.2, 0], leftLowerLeg: [1.5, 0, 0], leftFoot: [0, 0, 0],
          spine: [0.4, 0, 0], chest: [0.1, 0, 0], neck: [-0.25, 0, 0], head: [-0.1, 0, 0],
          leftUpperArm: [0, -1.35, -0.35], leftLowerArm: [0, -0.2, 0],
          rightUpperArm: [0, 1.35, 0.35], rightLowerArm: [0, 0.2, 0],
        },
        { spine: [0.07, 0, 0], rightLowerLeg: [0.08, 0, 0] },
        t,
      ),
  },
  // 体側：右脚を前に交差させ、両腕を上に伸ばして左へ倒す
  side: {
    yaw: 0,
    pose: (t) =>
      deepen(
        {
          rightUpperLeg: [-0.06, 0, 0.16], leftUpperLeg: [0.04, 0, -0.04],
          leftUpperArm: [0, 0, 1.3], leftLowerArm: [0, 0, 0.1],
          rightUpperArm: [0, 0, -1.3], rightLowerArm: [0, 0, -0.1],
          spine: [0, 0, -0.28], chest: [0, 0, -0.14], neck: [0, 0, 0.1],
        },
        { spine: [0, 0, -0.06], chest: [0, 0, -0.04] },
        t,
      ),
  },
  // 肩・背中：左腕を胸の前で横へ伸ばし、右腕で引き寄せる
  shoulder: {
    yaw: 0.35,
    pose: (t) =>
      deepen(
        {
          leftUpperArm: [0, -2.1, -0.15], leftLowerArm: [0, 0, 0],
          rightUpperArm: [0, 1.0, 0.55], rightLowerArm: [0, 1.7, 0],
          neck: [0, 0.2, 0],
        },
        { leftUpperArm: [0, -0.08, 0] },
        t,
      ),
  },
};

const HANDS_ON_HIPS = { leftUpperArm: [0, 0.35, -1.05], leftLowerArm: [0, -1.5, 0], rightUpperArm: [0, -0.35, 1.05], rightLowerArm: [0, 1.5, 0] };
const ARMS_FORWARD = { leftUpperArm: [0, -1.45, -0.25], leftLowerArm: [0, -0.2, 0], rightUpperArm: [0, 1.45, 0.25], rightLowerArm: [0, 0.2, 0] };
const cyc = (t, period) => 0.5 - 0.5 * Math.cos((t * Math.PI * 2) / period); // 0→1→0 を繰り返す

Object.assign(STRETCH_MOTION, {
  // 股関節回し：片脚で立ち、ひざを前→外へ円を描く
  hipcircle: {
    yaw: -0.5,
    pose: (t) => {
      const a = (t * Math.PI * 2) / 2.4;
      return {
        ...BASE, rightUpperArm: [0, 0, 0.35],
        leftUpperLeg: [-0.6 - 0.5 * Math.cos(a), 0, 0.35 + 0.35 * Math.sin(a)], leftLowerLeg: [1.4, 0, 0], leftFoot: [0.2, 0, 0],
      };
    },
  },
  // もも上げ：その場で左右交互に
  highknee: {
    yaw: -0.7,
    pose: (t) => {
      const s = Math.sin((t * Math.PI * 2) / 0.9);
      const l = Math.max(0, s), r = Math.max(0, -s);
      return {
        leftUpperLeg: [-1.3 * l, 0, 0], leftLowerLeg: [1.7 * l, 0, 0], leftFoot: [0.3 * l, 0, 0],
        rightUpperLeg: [-1.3 * r, 0, 0], rightLowerLeg: [1.7 * r, 0, 0], rightFoot: [0.3 * r, 0, 0],
        leftUpperArm: [0.7 * s, 0, -1.3], leftLowerArm: [0, -1.2, 0],
        rightUpperArm: [-0.7 * s, 0, 1.3], rightLowerArm: [0, 1.2, 0],
      };
    },
  },
  // 足首回し：右脚で立ち、左のつま先を床につけて足首で円を描く
  anklecircle: {
    yaw: -0.6,
    pose: (t) => {
      const a = (t * Math.PI * 2) / 1.6;
      return {
        ...BASE, rightUpperArm: [0, 0, 0.35],
        leftUpperLeg: [-0.3, 0, 0.08], leftLowerLeg: [0.25, 0, 0], leftFoot: [0.45 + 0.25 * Math.sin(a), 0, 0.3 * Math.cos(a)],
      };
    },
  },
  // 肩回し：両腕を伸ばして前から後ろへ大きく回す
  armcircle: {
    yaw: -1.1,
    pose: (t) => {
      // 回し続ける角度を -π〜π に収める（同じ向きなので見た目は変わらない）
      const raw = -(t * Math.PI * 2) / 1.8;
      const a = ((((raw + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
      return { leftUpperArm: [a, 0, -1.5], leftLowerArm: [0, 0, 0], rightUpperArm: [a, 0, 1.5], rightLowerArm: [0, 0, 0] };
    },
  },
  // カーフレイズ：壁に手をついて、かかとを上げ下げ
  calfraise: {
    yaw: -Math.PI / 2,
    pose: (t) => {
      const k = cyc(t, 2.5);
      return { ...ARMS_FORWARD, leftFoot: [0.6 * k, 0, 0], rightFoot: [0.6 * k, 0, 0], spine: [0.05, 0, 0] };
    },
  },
  // 片脚スクワット：左脚で立ち、右足を少し前に浮かせて腰を沈める
  singlesquat: {
    yaw: -Math.PI / 2,
    pose: (t) => {
      const k = cyc(t, 3);
      return {
        ...ARMS_FORWARD,
        leftUpperLeg: [-0.85 * k, 0, 0], leftLowerLeg: [1.4 * k, 0, 0], leftFoot: [-0.55 * k, 0, 0],
        rightUpperLeg: [-0.45 - 0.2 * k, 0, 0], rightLowerLeg: [0.35, 0, 0], rightFoot: [0.1, 0, 0],
        spine: [0.1 + 0.3 * k, 0, 0],
      };
    },
  },
  // スプリットスクワット：脚を前後に開いて、後ろのひざを床に近づける（左脚が前）
  splitsquat: {
    yaw: -Math.PI / 2,
    pose: (t) => {
      // 深いとき：前は太もも水平・すね垂直、後ろは太もも垂直・すね水平（両足が床に届く形）
      // 深さは 6 割まで（この範囲なら両足が床に届く）
      const k = cyc(t, 3) * 0.6;
      return {
        ...HANDS_ON_HIPS,
        leftUpperLeg: [-0.35 - 1.05 * k, 0, 0], leftLowerLeg: [0.35 + 1.05 * k, 0, 0], leftFoot: [0, 0, 0],
        rightUpperLeg: [0.4 - 0.4 * k, 0, 0], rightLowerLeg: [0.1 + 1.3 * k, 0, 0], rightFoot: [0.6 + 0.3 * k, 0, 0],
        spine: [-0.04, 0, 0],
      };
    },
  },
  // ヒップリフト：あお向けでひざを立て、お尻を持ち上げる（床の種目）
  hiplift: {
    yaw: Math.PI / 2,
    floor: true,
    pose: (t) => {
      const k = cyc(t, 3);
      return {
        hips: [-Math.PI / 2 + 0.55 * k, 0, 0],
        spine: [0.25 * k, 0, 0], chest: [0.15 * k, 0, 0], neck: [0.15, 0, 0],
        leftUpperLeg: [-0.85 - 0.5 * k, 0, 0], leftLowerLeg: [1.75, 0, 0], leftFoot: [-0.9 + 0.5 * k, 0, 0],
        rightUpperLeg: [-0.85 - 0.5 * k, 0, 0], rightLowerLeg: [1.75, 0, 0], rightFoot: [-0.9 + 0.5 * k, 0, 0],
        leftUpperArm: [0, 0, -1.45], leftLowerArm: [0, 0, 0], rightUpperArm: [0, 0, 1.45], rightLowerArm: [0, 0, 0],
      };
    },
  },
  // プランク：ひじと前腕、つま先で体を一直線に支える（床の種目）
  plank: {
    yaw: Math.PI / 2,
    floor: true,
    pose: (t) => {
      const b = Math.sin(t * 1.6) * 0.015;
      return {
        hips: [Math.PI / 2 - 0.08, 0, 0],
        spine: [b, 0, 0], neck: [-0.5, 0, 0], head: [-0.3, 0, 0],
        leftUpperArm: [0, -1.5, -0.1], leftLowerArm: [0, 0, 1.5],
        rightUpperArm: [0, 1.5, 0.1], rightLowerArm: [0, 0, -1.5],
        leftFoot: [0.9, 0, 0], rightFoot: [0.9, 0, 0],
      };
    },
  },
});

/** 種目 id・側（"left"|"right"）・時間 t から姿勢を返す */
export function stretchPose(id, side, t) {
  const m = STRETCH_MOTION[id];
  if (!m) return null;
  const p = m.pose(t);
  return side === "right" ? mirror(p) : p;
}
