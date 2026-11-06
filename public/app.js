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
    ["coros", "probe", "logout"].forEach((id) => show(id, false));
    return;
  }
  show("login", false);
  ["coros", "probe", "logout"].forEach((id) => show(id));

  const c = body.coros;
  if (c.connected) {
    $("coros-state").innerHTML = `<span class="ok">● 接続済み</span><br><small>トークン期限: ${fmtDate(c.access_expires_at)} / 自動更新: ${c.has_refresh_token ? "あり" : "なし"}</small>`;
    $("connect").textContent = "再接続";
    show("disconnect");
  } else {
    $("coros-state").innerHTML = `<span class="ng">● 未接続</span>`;
    $("connect").textContent = "COROSと接続";
    show("disconnect", false);
  }
  if (c.auth_server) {
    show("as-details");
    $("as-log").textContent = JSON.stringify(c.auth_server, null, 2);
  }
  $("run-probe").disabled = !c.connected;

  const latest = await api("/api/probe/latest");
  if (latest.body) renderProbe(latest.body);
}

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
