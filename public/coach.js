// コーチのアバター（VRM）。上半身を映し、呼吸・まばたき・表情・口パクで話す。
// 3D 描画に Three.js、VRM の読み込みに three-vrm（どちらも MIT License、vendor/ に同梱）。
import * as THREE from "./vendor/three.module.min.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "./vendor/three-vrm.module.min.js";
import { STRETCH_MOTION, stretchPose } from "./stretch-motion.js";

const BONES = [
  "spine", "chest", "neck", "head",
  "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot",
];
const FEET = ["leftFoot", "rightFoot", "leftToes", "rightToes"];

const EXPRESSIONS = ["happy", "angry", "sad", "relaxed", "surprised"];
// 表情の強さ。普段（base）は目が開いたままの控えめな強さ、話し始め（peak）ははっきり。
// このモデルの happy は 0.5 を超えると目が細くなり、0.8 で閉じる（「^^」）。褒めるときだけ一瞬使う。
const BASE_W = { happy: 0.3, relaxed: 0.3, angry: 0.55, sad: 0.6, surprised: 0.35, neutral: 0 };
const PEAK_W = { happy: 0.55, relaxed: 0.45, angry: 0.9, sad: 0.85, surprised: 0.8, neutral: 0 };

/** セリフの中身から表情を選ぶ（なければコーチ全体の気分） */
function lineExpression(line, mood) {
  if (/痛|病院|受診|心配|大丈夫？/.test(line)) return "sad";
  if (/ちょっと！|速すぎ|ダメ|許さない|禁止|承知しない|なさい！|古いわよ/.test(line)) return "angry";
  if (/!\?|！？|えっ|まさか|なのに走った/.test(line)) return "surprised";
  if (/えらい|やるじゃない|ばっちり|おめでとう|完了|さすが|やりきった|できた/.test(line)) return "praise";
  if (/休|のんびり|ゆっくり|楽に|キープ/.test(line)) return "relaxed";
  return mood;
}
const TYPE_MS = 45; // 1文字あたり

export function createCoach({ canvas, bubble, text, more, url = "/vrm/coach.vrm" }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    canvas.hidden = true; // WebGL が使えない端末ではセリフだけ出す
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
  const light = new THREE.DirectionalLight(0xffffff, 2.2);
  light.position.set(0.6, 1.5, 1.8);
  scene.add(light, new THREE.AmbientLight(0xffffff, 0.9));

  let vrm = null;
  let lines = [];
  let idx = 0;
  let mood = "neutral";
  let typing = null;
  let speakingUntil = 0;
  let blinkAt = 2;
  let visible = true;
  const face = Object.fromEntries([...EXPRESSIONS, "aa", "blink"].map((k) => [k, 0]));
  const clock = new THREE.Clock();
  let t = 0;
  // ストレッチの実演：{ id, side, start }。null のときは立ち姿
  let motion = null;
  let debugFace = null;
  // 話し始めの表情（はっきり出して、少しずつ普段の強さへ）
  let pulse = { name: "neutral", at: 0, praise: false };
  // 視線：カメラを見つつ、ときどき少しそらす
  const gaze = new THREE.Object3D();
  let gazeOff = new THREE.Vector3(), gazeAt = 1.5;
  let baseYaw = 0, yaw = 0, groundY = 0, full = 0;
  const frames = { upper: null, full: null };
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpV = new THREE.Vector3();

  function resize() {
    if (!renderer) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(canvas);

  if (renderer) {
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    loader
      .loadAsync(url, (e) => {
        if (e.total && !lines.length) text.textContent = `コーチを呼んでいます… ${Math.round((e.loaded / e.total) * 100)}%`;
      })
      .then((g) => {
        vrm = g.userData.vrm;
        VRMUtils.removeUnnecessaryVertices(g.scene);
        VRMUtils.combineSkeletons(g.scene);
        VRMUtils.rotateVRM0(vrm); // VRM 0.x はこちらを向くように回す
        vrm.scene.traverse((o) => o.isMesh && (o.frustumCulled = false));
        scene.add(vrm.scene);
        scene.add(gaze);
        if (vrm.lookAt) {
          vrm.lookAt.target = gaze;
          vrm.lookAt.autoUpdate = true;
        }
        baseYaw = vrm.scene.rotation.y;
        applyPose(idlePose(0), 1);
        vrm.update(0);
        groundY = lowestFoot();
        // 頭の高さに合わせて、普段は胸から上・実演では全身を映す
        const head = new THREE.Vector3();
        vrm.humanoid.getNormalizedBoneNode("head").getWorldPosition(head);
        frames.upper = { pos: new THREE.Vector3(0, head.y - 0.1, 1.35), look: new THREE.Vector3(0, head.y - 0.16, 0) };
        // 全身：上に吹き出しが来るので、体は少し下寄せに
        frames.full = { pos: new THREE.Vector3(0, head.y * 0.66, head.y * 3.0), look: new THREE.Vector3(0, head.y * 0.62, 0) };
        camPos.copy(frames.upper.pos);
        camLook.copy(frames.upper.look);
        resize();
        if (!lines.length) text.textContent = "";
        else show();
      })
      .catch(() => {
        canvas.hidden = true;
      });
  }

  const bone = (name) => vrm?.humanoid.getNormalizedBoneNode(name);

  // 立ち姿：腕を下ろし、呼吸と小さな揺れ。話している間は少しうなずく
  function idlePose(talk) {
    const breath = Math.sin(t * 1.6) * 0.015;
    const sway = Math.sin(t * 0.7) * 0.03;
    const nod = talk * Math.sin(t * 6) * 0.03;
    const arm = Math.sin(t * 1.1) * 0.02;
    return {
      spine: [breath, sway * 0.3, sway * 0.2],
      chest: [-breath * 0.5, 0, 0],
      neck: [nod * 0.5, Math.sin(t * 0.45) * 0.06, 0],
      head: [nod + 0.03, Math.sin(t * 0.33) * 0.08, Math.sin(t * 0.5) * 0.03],
      leftUpperArm: [0, 0, -1.25 + arm], leftLowerArm: [0, -0.12, 0],
      rightUpperArm: [0, 0, 1.25 - arm], rightLowerArm: [0, 0.12, 0],
    };
  }

  // 目標の姿勢へなめらかに近づける（k=1 で即座に）
  function applyPose(pose, k) {
    for (const name of BONES) {
      const b = bone(name);
      if (!b) continue;
      const r = pose[name] ?? [0, 0, 0];
      tmpQ.setFromEuler(tmpE.set(r[0], r[1], r[2]));
      b.quaternion.slerp(tmpQ, k);
    }
  }

  function lowestFoot() {
    let min = Infinity;
    for (const f of FEET) {
      const n = vrm.humanoid.getRawBoneNode(f);
      if (n) min = Math.min(min, n.getWorldPosition(tmpV).y);
    }
    return Number.isFinite(min) ? min : 0;
  }

  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!vrm || !visible || document.hidden) return;
    t += dt;
    const talking = performance.now() < speakingUntil;
    const m = motion && STRETCH_MOTION[motion.id];
    const target = m ? stretchPose(motion.id, motion.side, Math.max(0, (performance.now() - motion.start) / 1000)) : idlePose(talking ? 1 : 0);
    applyPose(target, Math.min(1, dt * (m ? 4 : 6)));
    // 体の向き・カメラ（実演では全身）
    yaw += ((m ? (motion.side === "right" ? -m.yaw : m.yaw) : 0) - yaw) * Math.min(1, dt * 3);
    vrm.scene.rotation.y = baseYaw + yaw;
    full += ((m ? 1 : 0) - full) * Math.min(1, dt * 3);
    if (frames.upper) {
      camPos.lerpVectors(frames.upper.pos, frames.full.pos, full);
      camLook.lerpVectors(frames.upper.look, frames.full.look, full);
      camera.position.copy(camPos);
      camera.lookAt(camLook);
    }

    // まばたき
    blinkAt -= dt;
    if (blinkAt < 0) blinkAt = 2.5 + Math.random() * 3;
    const blink = blinkAt < 0.15 ? Math.sin((blinkAt / 0.15) * Math.PI) : 0;

    // 表情：話し始めに強く出し、2秒ほどで普段の強さへ。褒めるときは一瞬「^^」
    const since = (performance.now() - pulse.at) / 1000;
    const decay = Math.max(0, 1 - since / 2.2);
    for (const k of EXPRESSIONS) {
      let w = k === mood ? BASE_W[k] : 0;
      if (k === pulse.name) w = Math.max(w, BASE_W[k] + (PEAK_W[k] - BASE_W[k]) * decay);
      if (pulse.praise && k === "happy") w = Math.max(w, since < 0.9 ? 0.9 : BASE_W.happy + 0.25 * decay);
      face[k] += (w - face[k]) * Math.min(1, dt * 8);
    }
    // 視線：カメラの少し手前をみる。数秒ごとに少しだけそらす
    gazeAt -= dt;
    if (gazeAt < 0) {
      gazeAt = 1.5 + Math.random() * 3;
      gazeOff.set((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.12, 0);
      if (Math.random() < 0.5) gazeOff.set(0, 0, 0);
    }
    gaze.position.copy(camera.position).add(gazeOff);
    face.aa += ((talking ? (Math.sin(t * 22) * 0.5 + 0.5) * 0.6 : 0) - face.aa) * Math.min(1, dt * 18);
    face.blink = face.happy > 0.6 ? 0 : blink; // 「^^」のときはまばたきしない
    const em = vrm.expressionManager;
    if (debugFace) for (const k of Object.keys(face)) face[k] = k === debugFace.name ? debugFace.w : 0;
    if (em) for (const [k, v] of Object.entries(face)) em.setValue(k, v);

    vrm.update(dt);
    // 足を床につける（ひざを曲げた分だけ体を下げる）
    vrm.scene.position.y += (groundY - lowestFoot()) * Math.min(1, dt * 10);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(tick);

  // 1文字ずつ表示しながら口を動かす
  function show() {
    const line = lines[idx] ?? "";
    const ex = lineExpression(line, mood);
    pulse = { name: ex === "praise" ? "happy" : ex, at: performance.now(), praise: ex === "praise" };
    clearInterval(typing);
    let n = 0;
    text.textContent = "";
    more.hidden = true;
    speakingUntil = performance.now() + line.length * TYPE_MS + 200;
    typing = setInterval(() => {
      n++;
      text.textContent = line.slice(0, n);
      if (n >= line.length) {
        clearInterval(typing);
        typing = null;
        more.hidden = idx >= lines.length - 1;
      }
    }, TYPE_MS);
  }

  function next() {
    if (!lines.length) return;
    if (typing) {
      // 表示中なら最後まで出す
      clearInterval(typing);
      typing = null;
      text.textContent = lines[idx];
      speakingUntil = 0;
      more.hidden = idx >= lines.length - 1;
      return;
    }
    idx = (idx + 1) % lines.length;
    show();
  }
  canvas.addEventListener("click", next);
  bubble.addEventListener("click", next);

  return {
    /** 動作確認用：表情を固定する（null で解除） */
    debugFace(name, w) {
      debugFace = name ? { name, w } : null;
    },
    /** ストレッチを実演する（id, side）。null で立ち姿に戻る */
    demo(id, side = "left") {
      motion = id ? { id, side, start: performance.now() } : null;
    },
    get demoing() {
      return !!motion;
    },
    say(speech, { restart = false } = {}) {
      const same = speech && JSON.stringify(speech.lines) === JSON.stringify(lines);
      mood = speech?.expression ?? "neutral";
      if (same && !restart) return; // 計画の読み直しで同じセリフなら言い直さない
      lines = speech?.lines ?? [];
      idx = 0;
      if (lines.length) show();
    },
  };
}
