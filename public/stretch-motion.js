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

/** 種目 id・側（"left"|"right"）・時間 t から姿勢を返す */
export function stretchPose(id, side, t) {
  const m = STRETCH_MOTION[id];
  if (!m) return null;
  const p = m.pose(t);
  return side === "right" ? mirror(p) : p;
}
