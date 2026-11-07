// ローカル通しテスト：偽COROS + wrangler dev を起動し、ログイン → OAuth接続 → 取得テスト → トークン更新 まで確認する。
// 実行: npm run test:e2e
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const APP = "http://localhost:8787";
const procs = [];
// wrangler は子プロセス(workerd)を起動するので、プロセスグループごと止める
const cleanup = () =>
  procs.forEach((p) => {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
  });
process.on("exit", cleanup);

function start(cmd, args, readyText, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    procs.push(p);
    let out = "";
    const onData = (d) => {
      out += d;
      if (out.includes(readyText)) resolve(p);
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("exit", (code) => reject(new Error(`${cmd} exited ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`timeout waiting for ${cmd}\n${out}`)), 90_000);
  });
}

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed`))));
  });

// 秘密情報（テスト用）
const devVarsBackup = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : null;
writeFileSync(".dev.vars", "APP_PASSWORD=test-pass\nCOROS_MCP_URL=http://localhost:8788/mcp\n");
process.on("exit", () => (devVarsBackup !== null ? writeFileSync(".dev.vars", devVarsBackup) : rmSync(".dev.vars", { force: true })));

// 毎回まっさらなローカルDBで実行する
const state = mkdtempSync(join(tmpdir(), "sub4-e2e-"));
process.on("exit", () => rmSync(state, { recursive: true, force: true }));
await start("node", ["test/mock-coros.mjs"], "listening");
await start("npx", ["wrangler", "dev", "--port", "8787", "--test-scheduled", "--persist-to", state], "Ready on");

let cookie = "";
async function req(path, opts = {}) {
  const res = await fetch(path.startsWith("http") ? path : APP + path, {
    redirect: "manual",
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers ?? {}) },
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}

// 1. 未ログインは 401
assert.equal((await req("/api/status")).status, 401);
assert.equal((await req("/api/login", { method: "POST", body: JSON.stringify({ password: "wrong" }) })).status, 401);

// 2. ログイン
assert.equal((await req("/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }) })).status, 200);
let status = await (await req("/api/status")).json();
assert.equal(status.coros.connected, false);

// 3. OAuth: /oauth/start → 偽COROS /authorize → /oauth/callback
let res = await req("/oauth/start");
assert.equal(res.status, 302);
const authorizeUrl = res.headers.get("location");
assert.match(authorizeUrl, /code_challenge_method=S256/);
res = await req(authorizeUrl);
assert.equal(res.status, 302, "authorize should redirect back");
res = await req(res.headers.get("location"));
assert.equal(res.status, 302);
assert.match(res.headers.get("location"), /connected=1/, `callback failed: ${res.headers.get("location")}`);

status = await (await req("/api/status")).json();
assert.equal(status.coros.connected, true);
assert.equal(status.coros.has_refresh_token, true);
console.log("discovery log:", status.coros.auth_server.discovered_via);

// 4. 取得テスト
res = await req("/api/probe", { method: "POST" });
const probe = await res.json();
assert.equal(res.status, 200, JSON.stringify(probe));
const byTool = Object.fromEntries(probe.calls.map((c) => [c.tool, c]));
assert.equal(byTool.queryUserInfo.ok, true);
assert.equal(byTool.getActivityDetail.ok, true, "race activity should be detected via labelId/sportType");
assert.deepEqual(byTool.getActivityDetail.args, { labelId: "481490330831585282", sportType: 100 });
assert.equal(byTool.queryRecoveryStatus.ok, false, "isError results are reported as failures");
assert.deepEqual(probe.write_tools_available.sort(), ["createScheduledWorkout", "createTrainingPlan"]);
assert.ok(!probe.calls.some((c) => c.tool.startsWith("create")), "write tools must never be called");
const latest = await (await req("/api/probe/latest")).json();
assert.equal(latest.id, probe.id);

// 4b. 同期 → 計画
res = await req("/api/sync", { method: "POST" });
const sync = await res.json();
assert.equal(res.status, 200, JSON.stringify(sync));
assert.ok(sync.activities >= 1);
res = await req("/api/plan");
const plan = await res.json();
assert.equal(res.status, 200, JSON.stringify(plan));
assert.equal(plan.sync.stale, false);
assert.equal(plan.ability.race.date, "2026-11-03");
assert.equal(plan.condition.loadRatio, 1.36);
assert.ok(plan.days.length > 0 && plan.days.length <= 14);
console.log(`plan: today=${plan.today} phase=${plan.phase?.label} first=${plan.days.find((d) => d.main)?.main.title}`);

// 4c. 時計に送る → 同じ日をもう一度送ると「更新」になる
const target = plan.days.find((d) => d.main);
res = await req("/api/push", { method: "POST", body: JSON.stringify({ date: target.date, choice: -1 }) });
let push = await res.json();
assert.equal(res.status, 200, JSON.stringify(push));
assert.equal(push.updated, false);
assert.ok(!/777/.test(push.message), "内部IDは見せない");
res = await req("/api/push", { method: "POST", body: JSON.stringify({ date: target.date, choice: 0 }) });
push = await res.json();
assert.equal(res.status, 200, JSON.stringify(push));
assert.equal(push.updated, true);
const plan2 = await (await req("/api/plan")).json();
assert.ok(plan2.days.find((d) => d.date === target.date).pushed, "送信済みが計画に出る");
const restDay = plan.days.find((d) => !d.main);
if (restDay) {
  res = await req("/api/push", { method: "POST", body: JSON.stringify({ date: restDay.date }) });
  assert.equal(res.status, 400);
}

// 4d. 記録は COROS の参照のみ（手入力の口はない）。痛みだけはボタンで受け付ける
for (const path of ["/api/day", "/api/body"]) {
  res = await req(path, { method: "POST", body: JSON.stringify({}) });
  assert.equal(res.status, 404, `${path} は廃止`);
}
await req("/api/pain", { method: "POST", body: JSON.stringify({ active: true }) });
let p3 = await (await req("/api/plan")).json();
assert.ok(p3.pain && p3.alerts.some((a) => a.text.includes("受診")), "痛みで受診を促す");
await req("/api/pain", { method: "POST", body: JSON.stringify({ active: false }) });
p3 = await (await req("/api/plan")).json();
assert.ok(!p3.pain && !p3.alerts.some((a) => a.text.includes("受診")), "治ったら解除");
res = await req("/api/settings", { method: "POST", body: JSON.stringify({ distPct: 85, paceTolS: 15 }) });
assert.deepEqual(await res.json(), { distPct: 85, paceTolS: 15 });
const withSubs = p3.days.find((d) => d.subs.length);
await req("/api/choice", { method: "POST", body: JSON.stringify({ date: withSubs.date, choice: 1 }) });
p3 = await (await req("/api/plan")).json();
assert.equal(p3.days.find((d) => d.date === withSubs.date).choice, 1, "気分の練習の選択を保存");

// 4e. 体重は COROS の値だけ。気づき（ラップから後半の失速）・大会までの流れ
assert.equal(p3.nutrition.weightKg, 62);
assert.equal(p3.nutrition.weightSource, "coros");
const ids = p3.insights.map((i) => i.id);
assert.ok(ids.includes("endurance") && ids.includes("fade"), ids.join(","));
assert.match(p3.insights.find((i) => i.id === "fade").text, /25km 付近/);
assert.ok(p3.season.segments.some((g) => g.label === "台北"));

// 5. Cron（期限が近いのでトークン更新される: 偽COROSは expires_in=3600）
const before = status.coros.obtained_at;
await new Promise((r) => setTimeout(r, 1100));
res = await fetch(`${APP}/__scheduled?cron=0+20+*+*+*`);
assert.equal(res.status, 200);
await new Promise((r) => setTimeout(r, 500));
status = await (await req("/api/status")).json();
assert.ok(status.coros.obtained_at > before, "token should be refreshed by cron");

// 更新後も MCP 呼び出しが通る
res = await req("/api/probe", { method: "POST" });
assert.equal(res.status, 200);

console.log(`\nE2E OK: ${probe.calls.filter((c) => c.ok).length}/${probe.calls.length} calls ok, tools=${probe.tools.length}`);
cleanup();
process.exit(0);
