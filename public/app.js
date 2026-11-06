const $ = (id) => document.getElementById(id);
const RACE_DAY = new Date("2027-03-14T00:00:00+09:00");

function updateCountdown() {
  const days = Math.ceil((RACE_DAY - Date.now()) / 86400000);
  $("countdown").textContent = String(Math.max(days, 0));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function show(id, on = true) {
  $(id).hidden = !on;
}

function fmtDate(sec) {
  return sec ? new Date(sec * 1000).toLocaleString("ja-JP") : "不明";
}

let lastProbe = null;

async function refresh() {
  const { status, body } = await api("/api/status");
  if (status === 401) {
    show("login");
    show("app", false);
    return;
  }
  show("login", false);
  show("app");

  const c = body.coros;
  if (c.connected) {
    $("coros-state").innerHTML = `<span class="ok">● 接続済み</span><br><small>トークン期限: ${fmtDate(c.access_expires_at)} / 自動更新: ${c.has_refresh_token ? "あり" : "なし"}</small>`;
    $("connect").textContent = "再接続";
    show("disconnect");
  } else {
    $("coros-state").innerHTML = `<span class="ng">● 未接続</span>`;
    $("connect").textContent = "COROSと接続";
    show("disconnect", false);
    $("settings").open = true;
  }
  if (c.auth_server) {
    show("as-details");
    $("as-log").textContent = JSON.stringify(c.auth_server, null, 2);
  }
  $("run-probe").disabled = !c.connected;
  $("sync").disabled = !c.connected;

  await loadPlan(c.connected);
  const latest = await api("/api/probe/latest");
  if (latest.body) renderProbe(latest.body);
}

// ---- 練習計画 ----
const CAT = {
  speed: { icon: "⚡", label: "スピード" },
  pace: { icon: "🎯", label: "ペース" },
  distance: { icon: "🛣️", label: "距離" },
  jog: { icon: "🌿", label: "ジョグ" },
  race: { icon: "🏁", label: "大会" },
  rest: { icon: "💤", label: "休養" },
};
const badge = (cat) => `<span class="cat cat-${cat}">${CAT[cat].icon} ${CAT[cat].label}</span>`;
const mmdd = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const fmtDur = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}時間${m}分` : `${m}分`;
};

// サブの練習を選んだら端末に覚えておく（段階3で記録と連携予定）
const choiceKey = (date) => `sub4-choice-${date}`;
function getChoice(date) {
  try { return Number(localStorage.getItem(choiceKey(date)) ?? -1); } catch { return -1; }
}
function setChoice(date, i) {
  try { localStorage.setItem(choiceKey(date), String(i)); } catch {}
}

function sessionDetail(s) {
  return `<div class="sess">
    <div class="sess-head">${badge(s.category)} <strong>${esc(s.title)}</strong> <span class="km">${s.distanceKm}km</span></div>
    <div class="pace">ペース ${esc(s.pace)}</div>
    <ul class="menu">${s.menu.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
  </div>`;
}

function pushButton(day) {
  if (!day.main) return "";
  const done = day.pushed ? `<span class="pushed">⌚ 送信済み：${esc(day.pushed.title)}</span>` : "";
  return `<div class="push">${done}<button class="small ghost push-btn" data-date="${day.date}">${day.pushed ? "選んだ練習で送り直す" : "⌚ 時計に送る"}</button><span class="msg push-msg" id="push-msg-${day.date}"></span></div>`;
}

function chosen(day) {
  const i = getChoice(day.date);
  return i >= 0 && day.subs[i] ? day.subs[i] : day.main;
}

function renderChoices(day) {
  if (!day.main || !day.subs.length) return "";
  const i = getChoice(day.date);
  const opts = [day.main, ...day.subs]
    .map((s, k) => `<button class="choice ${i === k - 1 ? "on" : ""}" data-date="${day.date}" data-i="${k - 1}">${k === 0 ? "メイン：" : "気分で："}${esc(s.title)}</button>`)
    .join("");
  return `<div class="choices">${opts}</div>`;
}

function actualLine(day) {
  if (!day.actual.length) return "";
  return day.actual
    .map((a) => `<div class="actual">✓ 走った：${a.distanceKm}km / ${fmtDur(a.durationS)}${a.avgHr ? ` / 心拍 ${a.avgHr}` : ""}</div>`)
    .join("");
}

function renderToday(plan) {
  const day = plan.days[0];
  if (!day) {
    $("today").innerHTML = "<p>計画の期間外です。</p>";
    return;
  }
  const s = chosen(day);
  let html = `<div class="today-date">今日 ${mmdd(day.date)}（${day.weekday}）${day.holiday ? ` <span class="hol">${esc(day.holiday)}</span>` : ""}</div>`;
  if (!s) {
    html += `<div class="rest">${badge("rest")} <strong>今日は休養日</strong><p class="hint">しっかり休むのも練習のうち。軽いストレッチだけでもOK。</p></div>`;
  } else {
    if (day.optional) html += `<p class="opt">任意：余裕があれば。走らなくても計画には影響しません。</p>`;
    html += sessionDetail(s) + renderChoices(day) + pushButton(day);
  }
  html += day.notes.map((n) => `<p class="note">💬 ${esc(n)}</p>`).join("");
  html += actualLine(day);
  $("today").innerHTML = html;
}

function renderDays(plan) {
  $("days").innerHTML = plan.days
    .slice(1)
    .map((day) => {
      const s = chosen(day);
      const wk = day.weekday === "土" ? "sat" : day.weekday === "日" || day.holiday ? "sun" : "";
      const head = `<span class="d ${wk}">${mmdd(day.date)}<small>${day.weekday}</small></span>`;
      if (!s) return `<li class="day rest-day">${head}<span class="t muted">休養</span>${actualLine(day)}</li>`;
      return `<li class="day${day.optional ? " optional" : ""}"><details data-date="${day.date}"${openDays.has(day.date) ? " open" : ""}>
        <summary>${head}${badge(s.category)}<span class="t">${day.optional ? "（任意）" : ""}${esc(s.title)}</span><span class="km">${s.distanceKm}km${day.pushed ? " ⌚" : ""}</span></summary>
        ${day.holiday ? `<p class="hol">${esc(day.holiday)}</p>` : ""}
        ${sessionDetail(s)}${renderChoices(day)}${pushButton(day)}
        ${day.notes.map((n) => `<p class="note">💬 ${esc(n)}</p>`).join("")}
      </details>${actualLine(day)}</li>`;
    })
    .join("");
}

function renderAbility(plan) {
  const a = plan.ability;
  const p = a.paces;
  const h = a.history;
  const race = a.race
    ? `<p>直近の大会：${mmdd(a.race.date)} ${a.race.km}km <strong>${a.race.time}</strong>（${a.race.pace}/km${a.race.avgHr ? `、心拍 ${a.race.avgHr}` : ""}）</p>`
    : `<p class="muted">直近120日にフルマラソンの記録が見つかりません。</p>`;
  $("ability").innerHTML = `${race}
    <p>COROS の予測：フル ${a.predictedFull}／練習の基準にする走力（VDOT）${a.vdotSpeed}${a.vdotRace ? `（大会実績 ${a.vdotRace}）` : ""}</p>
    <table class="paces">
      <tr><th>ジョグ</th><td>${p.jog}/km</td></tr>
      <tr><th>ロング走</th><td>${p.long}/km</td></tr>
      <tr><th>マラソンペース</th><td>強化期 ${p.mpBuild} → ピーク ${p.mpPeak}/km</td></tr>
      <tr><th>閾値走</th><td>${p.tempo}/km</td></tr>
      <tr><th>インターバル</th><td>${p.interval}/km</td></tr>
      <tr><th>サブ4の平均</th><td>${p.goal}/km</td></tr>
    </table>
    <p>大会前8週：週平均 ${h.avgWeeklyKm}km・${h.avgRunsPerWeek}回、最長 ${h.longestKm}km</p>
    <div class="bars">${h.weeks
      .map((w) => `<div class="bar" title="${w.monday} ${w.km}km"><i style="height:${Math.min(100, w.km * 1.6)}%"></i><small>${mmdd(w.monday)}</small></div>`)
      .join("")}</div>`;
}

async function loadPlan(connected) {
  const { status, body } = await api("/api/plan");
  if (status !== 200) {
    $("today").innerHTML = `<p class="ng">計画を読み込めませんでした（${esc(body?.message || status)}）</p>`;
    return;
  }
  const plan = body;
  lastPlan = plan;
  $("phase").textContent = plan.phase ? `・${plan.phase.label}${plan.phase.down ? "（軽めの週）" : ""}` : "";
  const st = plan.sync;
  $("sync-state").className = `pill ${st.stale ? "warn" : "okp"}`;
  $("sync-state").textContent = st.syncedAt ? (st.stale ? `未同期（最終 ${fmtDate(st.syncedAt)}）` : `同期 ${fmtDate(st.syncedAt)}`) : "未同期";
  const rec = plan.condition.recovery;
  if (rec?.percent != null) {
    show("cond-recovery");
    $("cond-recovery").textContent = `回復 ${rec.percent}%`;
  }
  if (plan.condition.loadRatio != null) {
    show("cond-load");
    const r = plan.condition.loadRatio;
    $("cond-load").className = `pill ${r > 1.5 ? "warn" : ""}`;
    $("cond-load").textContent = `負荷比 ${r.toFixed(2)}`;
  }
  renderToday(plan);
  renderDays(plan);
  renderAbility(plan);
  // まだ一度も同期していなければ自動で同期する
  if (connected && !st.syncedAt && !autoSynced) {
    autoSynced = true;
    doSync();
  }
}
let autoSynced = false;
let lastPlan = null;

async function doSync() {
  $("sync").disabled = true;
  $("sync-msg").textContent = "COROSと同期中…";
  const { status, body } = await api("/api/sync", { method: "POST" });
  $("sync").disabled = false;
  if (status === 200) {
    $("sync-msg").textContent = body.errors?.length ? `一部取得できませんでした：${body.errors.join(" / ")}` : "";
    await loadPlan(true);
  } else {
    $("sync-msg").textContent = `同期に失敗しました：${body?.message || body?.error || status}（「未同期」のまま表示しています）`;
  }
}

$("sync").addEventListener("click", doSync);

// 再描画しても開いている日を閉じない
const openDays = new Set();
document.addEventListener("toggle", (e) => {
  const d = e.target.dataset?.date;
  if (d) e.target.open ? openDays.add(d) : openDays.delete(d);
}, true);

document.addEventListener("click", async (e) => {
  const pb = e.target.closest(".push-btn");
  if (pb) {
    const date = pb.dataset.date;
    const msg = $(`push-msg-${date}`);
    pb.disabled = true;
    msg.textContent = "送信中…";
    const { status, body } = await api("/api/push", { method: "POST", body: JSON.stringify({ date, choice: getChoice(date) }) });
    pb.disabled = false;
    if (status === 200) {
      await loadPlan(false);
      const m = $(`push-msg-${date}`);
      if (m) m.textContent = `${body.updated ? "時計の予定を書き換えました" : "時計の予定に登録しました"}。COROS アプリで同期すると時計に入ります。${body.message ? `（${body.message}）` : ""}`;
    } else {
      msg.textContent = `送れませんでした：${body?.message || status}`;
    }
    return;
  }
  const b = e.target.closest(".choice");
  if (!b) return;
  setChoice(b.dataset.date, Number(b.dataset.i));
  if (lastPlan) {
    renderToday(lastPlan);
    renderDays(lastPlan);
  }
});

function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

function renderProbe(r) {
  lastProbe = r;
  show("download");
  const okCount = r.calls.filter((c) => c.ok).length;
  const writes = r.write_tools_available;
  let html = `<p class="summary">${new Date(r.ran_at).toLocaleString("ja-JP")} 実行 / 成功 ${okCount} / ${r.calls.length}（${(r.duration_ms / 1000).toFixed(1)}秒）</p>`;
  html += `<p class="summary">書き込み（時計への送信）ツール: ${
    writes.length ? `<span class="ok">${writes.length}個あり</span> <small>${esc(writes.join(", "))}</small>` : `<span class="ng">なし</span>`
  }</p>`;
  html += `<ul class="calls">`;
  for (const c of r.calls) {
    const mark = c.ok ? `<span class="ok">✓</span>` : `<span class="ng">✗</span>`;
    const size = c.bytes != null ? `${(c.bytes / 1024).toFixed(1)}KB` : "";
    const detail = c.error ? esc(c.error) : esc(JSON.stringify(c.data, null, 2).slice(0, 20000));
    html += `<li><details><summary>${mark} <code>${esc(c.tool)}</code> <small>${size}</small></summary>
      <div class="args">引数: <code>${esc(JSON.stringify(c.args))}</code></div><pre>${detail}</pre></details></li>`;
  }
  html += `</ul><details><summary>使えるツール一覧（${r.tools.length}個）</summary><ul class="tools">${r.tools
    .map((t) => `<li><code>${esc(t.name)}</code>${t.write ? ' <span class="tag">書込</span>' : ""}</li>`)
    .join("")}</ul></details>`;
  $("probe-result").innerHTML = html;
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = String(new FormData(e.target).get("password") ?? "").trim();
  $("login-msg").textContent = "確認中…";
  const { status, body } = await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
  if (status !== 200) {
    const detail = body?.message ? `（${body.message}）` : "";
    $("login-msg").textContent = `${body?.error || "ログインに失敗しました"}${detail} [HTTP ${status}]`;
    return;
  }
  $("login-msg").textContent = "";
  await refresh();
  if (!$("login").hidden) {
    $("login-msg").textContent = "パスワードは正しいのに、ログイン状態を保存できませんでした（Cookie がブロックされている可能性）。";
  }
});

$("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  refresh();
});

$("disconnect").addEventListener("click", async () => {
  if (!confirm("COROSとの接続を解除しますか？")) return;
  await api("/api/coros/disconnect", { method: "POST" });
  refresh();
});

$("run-probe").addEventListener("click", async () => {
  $("run-probe").disabled = true;
  $("probe-msg").textContent = "取得中…（数十秒かかることがあります）";
  const { status, body } = await api("/api/probe", { method: "POST" });
  $("run-probe").disabled = false;
  if (status === 200) {
    $("probe-msg").textContent = "";
    renderProbe(body);
  } else {
    $("probe-msg").textContent = `失敗: ${body?.message || body?.error || status}`;
  }
});

$("download").addEventListener("click", () => {
  if (!lastProbe) return;
  const blob = new Blob([JSON.stringify(lastProbe, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `coros-probe-${lastProbe.ran_at.slice(0, 10)}.json`;
  a.click();
});

// OAuth から戻ってきたときのメッセージ
const params = new URLSearchParams(location.search);
if (params.get("connected")) $("coros-msg").textContent = "COROSと接続しました。";
if (params.get("oauth_error")) $("coros-msg").textContent = `接続に失敗しました: ${params.get("oauth_error")}`;
if (params.get("login_required")) $("login-msg").textContent = "先にログインしてください。";
if ([...params.keys()].length) history.replaceState(null, "", "/");

updateCountdown();
refresh();
