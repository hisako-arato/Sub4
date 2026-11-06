// コーチのアバター（VRM）。上半身を映し、呼吸・まばたき・表情・口パクで話す。
// 3D 描画に Three.js、VRM の読み込みに three-vrm（どちらも MIT License、vendor/ に同梱）。
import * as THREE from "./vendor/three.module.min.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "./vendor/three-vrm.module.min.js";

const EXPRESSIONS = ["happy", "angry", "sad", "relaxed", "surprised"];
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
        pose(0);
        vrm.update(0);
        // 頭の高さに合わせて、胸から上を映す
        const head = new THREE.Vector3();
        vrm.humanoid.getNormalizedBoneNode("head").getWorldPosition(head);
        camera.position.set(0, head.y - 0.1, 1.35);
        camera.lookAt(0, head.y - 0.16, 0);
        resize();
        if (!lines.length) text.textContent = "";
        else show();
      })
      .catch(() => {
        canvas.hidden = true;
      });
  }

  const bone = (name) => vrm?.humanoid.getNormalizedBoneNode(name);
  const set = (name, x = 0, y = 0, z = 0) => bone(name)?.rotation.set(x, y, z);

  // 立ち姿：腕を下ろし、呼吸と小さな揺れ。話している間は少しうなずく
  function pose(talk) {
    const breath = Math.sin(t * 1.6) * 0.015;
    const sway = Math.sin(t * 0.7) * 0.03;
    const nod = talk * Math.sin(t * 6) * 0.03;
    set("spine", breath, sway * 0.3, sway * 0.2);
    set("chest", -breath * 0.5, 0, 0);
    set("neck", nod * 0.5, Math.sin(t * 0.45) * 0.06, 0);
    set("head", nod + 0.03, Math.sin(t * 0.33) * 0.08, Math.sin(t * 0.5) * 0.03);
    const arm = Math.sin(t * 1.1) * 0.02;
    set("leftUpperArm", 0, 0, -1.25 + arm);
    set("leftLowerArm", 0, -0.12, 0);
    set("rightUpperArm", 0, 0, 1.25 - arm);
    set("rightLowerArm", 0, 0.12, 0);
  }

  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!vrm || !visible || document.hidden) return;
    t += dt;
    const talking = performance.now() < speakingUntil;
    pose(talking ? 1 : 0);

    // まばたき
    blinkAt -= dt;
    if (blinkAt < 0) blinkAt = 2.5 + Math.random() * 3;
    const blink = blinkAt < 0.15 ? Math.sin((blinkAt / 0.15) * Math.PI) : 0;

    // 表情は少しずつ切り替える
    for (const k of EXPRESSIONS) face[k] += ((k === mood ? 0.85 : 0) - face[k]) * Math.min(1, dt * 6);
    face.aa += ((talking ? (Math.sin(t * 22) * 0.5 + 0.5) * 0.6 : 0) - face.aa) * Math.min(1, dt * 18);
    face.blink = mood === "happy" || mood === "relaxed" ? blink * 0.5 : blink;
    const em = vrm.expressionManager;
    if (em) for (const [k, v] of Object.entries(face)) em.setValue(k, v);

    vrm.update(dt);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(tick);

  // 1文字ずつ表示しながら口を動かす
  function show() {
    const line = lines[idx] ?? "";
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
    say(speech) {
      const same = speech && JSON.stringify(speech.lines) === JSON.stringify(lines);
      mood = speech?.expression ?? "neutral";
      if (same) return; // 同じセリフなら言い直さない
      lines = speech?.lines ?? [];
      idx = 0;
      if (lines.length) show();
    },
  };
}
