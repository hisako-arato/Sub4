import { createCoach } from "./coach.js";
const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const show = (id, on = true) => ($(id).hidden = !on);
const fmtDate = (sec) => (sec ? new Date(sec * 1000).toLocaleString("ja-JP") : "不明");
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const mmdd = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const fmtDur = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}時間${m}分` : `${m}分`;
};

let lastPlan = null;
let lastProbe = null;
let autoSynced = false;
let coach = null;
try {
  coach = createCoach({ canvas: $("coach-canvas"), bubble: $("coach-bubble"), text: $("coach-text"), more: $("coach-more") });
} catch (e) {
  console.warn("coach unavailable", e);
}

// ---- タブ・切り替え ----
function setTab(name) {
  for (const b of document.querySelectorAll(".tabbar button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".panel")) p.hidden = p.id !== `tab-${name}`;
}
document.querySelector(".tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) setTab(b.dataset.tab);
});
document.addEventListener("click", (e) => {
  const s = e.target.closest(".seg button");
  if (!s) return;
  const group = s.parentElement;
  for (const b of group.querySelectorAll("button")) {
    b.classList.toggle("on", b === s);
    $(b.dataset.seg).hidden = b !== s;
  }
});

// ---- 詳細シート（下から出す） ----
let sheet = null; // { kind, key }
function openSheet(kind, key) {
  sheet = { kind, key };
  renderSheet();
  show("sheet");
  show("sheet-bg");
}
function closeSheet() {
  sheet = null;
  show("sheet", false);
  show("sheet-bg", false);
}
$("sheet-bg").addEventListener("click", closeSheet);
$("sheet-close").addEventListener("click", closeSheet);

// ---- 表示の部品 ----
const CAT = {
  speed: { icon: "⚡", label: "スピード" },
  pace: { icon: "🎯", label: "ペース" },
  distance: { icon: "🛣️", label: "距離" },
  jog: { icon: "🌿", label: "ジョグ" },
  race: { icon: "🏁", label: "大会" },
  rest: { icon: "💤", label: "休養" },
};
const badge = (cat) => `<span class="cat cat-${cat}">${CAT[cat].icon} ${CAT[cat].label}</span>`;
const dot = (cat) => `<span class="cat cat-${cat} icon" title="${CAT[cat].label}">${CAT[cat].icon}</span>`;
const wkClass = (day) => (day.weekday === "土" ? "sat" : day.weekday === "日" || day.holiday ? "sun" : "");
const dateCell = (day) => `<span class="d ${wkClass(day)}">${mmdd(day.date)}<small>${day.weekday}</small></span>`;

function chosen(day) {
  const i = day.choice ?? -1;
  return i >= 0 && day.subs[i] ? day.subs[i] : day.main;
}
const findDay = (date) => [...(lastPlan?.days ?? []), ...(lastPlan?.past ?? [])].find((d) => d.date === date);

function sessionDetail(s) {
  return `<div class="sess">
    <div class="sess-head">${badge(s.category)} <strong>${esc(s.title)}</strong> <span class="km">${s.distanceKm}km</span></div>
    <div class="pace">ペース ${esc(s.pace)}</div>
    <ul class="menu">${s.menu.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
  </div>`;
}

function renderChoices(day) {
  if (!day.main || !day.subs.length) return "";
  const i = day.choice ?? -1;
  return `<div class="choices">${[day.main, ...day.subs]
    .map((s, k) => `<button class="choice ${i === k - 1 ? "on" : ""}" data-date="${day.date}" data-i="${k - 1}">${k === 0 ? "メイン" : "気分で"}：${esc(s.title)}</button>`)
    .join("")}</div>`;
}

function pushButton(day) {
  if (!day.main) return "";
  return `<button class="small push-btn" data-date="${day.date}">${day.pushed ? "⌚ 送り直す" : "⌚ 時計に送る"}</button>`;
}

function actualLine(day) {
  return day.actual
    .map((a) => `<div class="actual">✓ ${a.distanceKm}km / ${fmtDur(a.durationS)}${a.avgHr ? ` / 心拍 ${a.avgHr}` : ""}</div>`)
    .join("");
}

const REASON = { schedule: "予定", fatigue: "疲労", pain: "痛み" };
const LEVEL = {
  achieved: { cls: "lv-ok", text: "◎ 達成" },
  partial: { cls: "lv-mid", text: "△ 一部" },
  missed: { cls: "lv-ng", text: "✗ 未達" },
  done: { cls: "lv-ok", text: "✓ 走った" },
};
const FLAG = { short: "距離が短め", fast: "ペースが速め", slow: "ペースが遅め" };

/** 結果のラベル（detail=true で数値も） */
function resultChip(day, detail = false) {
  const r = day.result;
  if (!r) return "";
  switch (r.state) {
    case "ran":
    case "ran_manual": {
      const a = r.achievement;
      const lv = LEVEL[a.level];
      const more =
        detail && a.distPct != null
          ? `<div class="hint">距離 ${a.distPct}%・平均 ${a.avgPace ?? "-"}/km（目安 ${a.expected}）${a.flags.length ? "・" + a.flags.map((f) => FLAG[f]).join("・") : ""}</div>`
          : "";
      return `<span class="lv ${lv.cls}">${lv.text}${r.state === "ran_manual" ? "（手動）" : ""}</span>${more}`;
    }
    case "extra":
      return day.actual.some((a) => a.distanceKm >= 40) ? `<span class="lv lv-ok">🏁 大会</span>` : `<span class="lv lv-ok">＋ 予定外</span>`;
    case "off":
      return `<span class="lv lv-rest">予定なし</span>`;
    case "skipped":
      return `<span class="lv lv-ng">走らず${r.reason ? `（${REASON[r.reason]}）` : ""}</span>`;
    case "auto_skipped":
      return `<span class="lv lv-ng">走らず（未入力）</span>`;
    default:
      return "";
  }
}

/** 記録ボタン（今日・過去） */
function logButtons(day, isToday) {
  if (day.actual.length) return `<p class="hint">COROS の活動から自動で判定しています。</p>`;
  const st = day.log?.status;
  const b = (status, label, extra = "") => `<button class="small ghost log-btn" data-date="${day.date}" data-status="${status}" ${extra}>${label}</button>`;
  let html = `<div class="logs">`;
  if (st) html += b("clear", "記録を取り消す");
  else {
    if (day.main) html += `<button class="small ghost skip-open" data-date="${day.date}">走らなかった</button>`;
    if (day.main || isToday) html += b("ran", "走った（手動）");
    if (isToday && day.main) html += b("off", "今日は走る予定なし");
  }
  html += `<div class="reasons" id="reasons-${day.date}" hidden>理由（任意）：${["schedule", "fatigue", "pain", ""]
    .map((r) => `<button class="small ghost log-btn" data-date="${day.date}" data-status="skipped" data-reason="${r}">${r ? REASON[r] : "なし"}</button>`)
    .join("")}</div></div>`;
  return html;
}

// ---- 各タブ ----
function renderTop(plan) {
  $("countdown").textContent = String(Math.max(plan.daysToRace, 0));
  $("phase").textContent = plan.phase ? `・${plan.phase.label}` : "";
  const c = [];
  if (plan.condition.recovery?.percent != null) c.push(`回復${plan.condition.recovery.percent}%`);
  if (plan.condition.loadRatio != null) c.push(`負荷${plan.condition.loadRatio.toFixed(2)}`);
  $("cond").textContent = c.join("・");
  $("cond").classList.toggle("warn", (plan.condition.loadRatio ?? 0) > 1.5);
  const st = plan.sync;
  $("sync-dot").className = `dot ${st.stale ? "warn" : "ok"}`;
  $("sync-label").textContent = st.stale ? "未同期" : "同期";
  $("sync").title = st.syncedAt ? `最終同期 ${fmtDate(st.syncedAt)}` : "未同期";
}

function renderAlerts(plan) {
  $("alerts").innerHTML = (plan.alerts ?? [])
    .map((a) => `<div class="alert ${a.level}">${esc(a.text)}${a.text.includes("痛み") ? ` <button class="small ghost" id="pain-clear">痛みは治った</button>` : ""}</div>`)
    .join("");
}

function renderToday(plan) {
  const day = plan.days[0];
  if (!day) {
    $("today").innerHTML = "<p>計画の期間外です。</p>";
    return;
  }
  const s = chosen(day);
  let html = `<div class="t-head"><span>今日 ${mmdd(day.date)}（${day.weekday}）${day.holiday ? ` <span class="hol">${esc(day.holiday)}</span>` : ""}</span>${resultChip(day)}</div>`;
  if (s) {
    if (day.optional) html += `<p class="opt">任意：余裕があれば。走らなくても計画には影響しません</p>`;
    html += sessionDetail(s) + renderChoices(day);
  } else {
    html += `<div class="sess"><div class="sess-head">${badge("rest")} <strong>${day.log?.status === "off" ? "今日は走る予定なし" : "今日は休養日"}</strong></div>
      <p class="hint">休むのも練習のうち。ケアのタブに軽いストレッチがあります</p></div>`;
  }
  html += actualLine(day);
  html += `<div class="actions">${pushButton(day)}<button class="small ghost" data-sheet="log" data-date="${day.date}">📝 記録</button>${
    day.pushed ? `<span class="pushed">⌚ 送信済み</span>` : ""}</div><p class="msg" id="push-msg"></p>`;
  $("today").innerHTML = html;
}

function renderDays(plan) {
  const v = plan.volume?.week;
  $("week-sum").textContent = v ? `今週 ${Math.round((v.done + v.planned) * 10) / 10}km` : "";
  $("days").innerHTML = plan.days
    .slice(1)
    .map((day) => {
      const s = chosen(day);
      const off = day.log?.status === "off";
      const marks = `${day.pushed ? "⌚" : ""}${day.notes.length ? "💬" : ""}`;
      if (!s) {
        return `<li><button class="rowbtn" data-sheet="day" data-date="${day.date}">${dateCell(day)}${dot("rest")}<span class="t muted">${off ? "走る予定なし" : "休養"}</span><span class="km">${marks}</span></button></li>`;
      }
      return `<li><button class="rowbtn${day.optional ? " optional" : ""}" data-sheet="day" data-date="${day.date}">${dateCell(day)}${dot(s.category)}<span class="t">${day.optional ? "（任意）" : ""}${esc(s.title)}</span><span class="km">${s.distanceKm}km${marks}</span></button></li>`;
    })
    .join("");
}

function holdText(st) {
  return st.kind === "dynamic" ? "各10回" : `${st.holdSec}秒${st.sides ? "×左右" : ""}`;
}

function renderCare(plan) {
  const c = plan.care;
  if (!c) return;
  const rows = (list) =>
    list
      .map(
        (st) => `<li><div class="rowbtn" data-sheet="stretch" data-id="${st.id}"><span class="t"><strong>${esc(st.name)}</strong> <small class="muted">${holdText(st)}</small></span>
        <button class="small ghost ask-btn" data-id="${st.id}">🗣 教わる</button></div></li>`,
      )
      .join("");
  let html = `<div class="panel-head"><span>${esc(c.title)}</span></div>`;
  if (c.caution) html += `<div class="alert warn">${esc(c.caution)}</div>`;
  if (c.before.length) html += `<p class="sub">走る前</p><ul class="rows">${rows(c.before)}</ul>`;
  if (c.after.length) html += `<p class="sub">${plan.days[0]?.main ? "走ったあと" : "今日のストレッチ"}</p><ul class="rows">${rows(c.after)}</ul>`;
  html += `<p class="sub">セルフケア</p><p class="selfcare">${c.selfCare.map(esc).join("／")}</p>`;
  $("care-list").innerHTML = html;
}

function renderNutrition(plan) {
  const n = plan.nutrition;
  if (!n) {
    $("nutrition").innerHTML = `<p class="muted">体重が分かりません。COROS と同期するか、設定で体重を入力してください。</p>`;
    return;
  }
  const rng = (a) => `${a[0]}〜${a[1]}`;
  $("nutrition").innerHTML = `
    <div class="panel-head"><span>${esc(n.dayType)}</span><span class="muted">体重 ${n.weightKg}kg</span></div>
    <div class="tiles">
      <div class="tile"><small>炭水化物</small><b>${rng(n.carbs.grams)}<small>g</small></b><small class="muted">ご飯 約${rng(n.carbs.riceBowls)}杯分</small></div>
      <div class="tile"><small>たんぱく質</small><b>${rng(n.protein.grams)}<small>g</small></b><small class="muted">鶏むね 約${rng(n.protein.chickenG)}g分</small></div>
    </div>
    <ul class="menu compact">${n.tips.slice(0, 2).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <button class="small ghost" data-sheet="food">食べ物の目安・注意</button>`;
}

function renderPast(plan) {
  const past = [...(plan.past ?? [])].reverse();
  $("past").innerHTML = past.length
    ? past
        .map((day) => {
          const p = day.planned ? (day.choice >= 0 && day.subs[day.choice]) || day.planned : null;
          return `<li><button class="rowbtn" data-sheet="past" data-date="${day.date}">${dateCell(day)}${p ? dot(p.category) : dot("rest")}<span class="t">${
            p ? esc(p.title) : `<span class="muted">予定なし</span>`
          }</span><span class="res">${resultChip(day)}</span></button></li>`;
        })
        .join("")
    : `<li class="muted">まだ記録がありません</li>`;
}

function renderVolume(plan) {
  const v = plan.volume;
  if (!v) return;
  const w = v.week;
  const wTotal = Math.round((w.done + w.planned) * 10) / 10;
  const scale = Math.max(220, ...v.months.map((m) => m.actual + m.planned + m.optional));
  const pct = (km) => `${(km / scale) * 100}%`;
  const rows = v.months
    .map(
      (m) => `<div class="vrow"><span class="vm">${Number(m.month.slice(5))}月</span>
        <div class="vtrack"><i class="band" style="left:${pct(v.target.min)};width:${pct(v.target.max - v.target.min)}"></i>
          <i class="va" style="width:${pct(m.actual)}"></i><i class="vp" style="width:${pct(m.planned)}"></i><i class="vo" style="width:${pct(m.optional)}"></i></div>
        <span class="vt">${Math.round(m.actual + m.planned)}km${m.optional ? `<small>+${Math.round(m.optional)}</small>` : ""}</span></div>`,
    )
    .join("");
  $("volume").innerHTML = `
    <div class="panel-head"><span>今週 ${wTotal}km</span><span class="muted">走った ${w.done}／予定 ${w.planned}${w.optional ? `／任意 ${w.optional}` : ""}</span></div>
    <div class="vchart">${rows}</div>
    <p class="vlegend"><span><i class="va"></i>走った</span><span><i class="vp"></i>予定</span><span><i class="vo"></i>任意</span><span><i class="band"></i>目安 ${v.target.min}〜${v.target.max}km/月</span></p>
    <p class="hint">11月・12月・3月は大会の42kmを含みます</p>`;
}

function renderAbility(plan) {
  const a = plan.ability;
  const p = a.paces;
  const h = a.history;
  const race = a.race
    ? `<p>大会実績：${mmdd(a.race.date)} ${a.race.km}km <strong>${a.race.time}</strong>（${a.race.pace}/km）</p>`
    : `<p class="muted">直近120日にフルマラソンの記録が見つかりません。</p>`;
  $("ability").innerHTML = `${race}
    <p>COROS の予測：フル ${a.predictedFull}／基準の走力（VDOT）${a.vdotSpeed}</p>
    <table class="paces">
      <tr><th>ジョグ</th><td>${p.jog}/km</td></tr>
      <tr><th>ロング走</th><td>${p.long}/km</td></tr>
      <tr><th>マラソンペース</th><td>${p.mpBuild} → ${p.mpPeak}/km</td></tr>
      <tr><th>閾値走</th><td>${p.tempo}/km</td></tr>
      <tr><th>インターバル</th><td>${p.interval}/km</td></tr>
      <tr><th>サブ4の平均</th><td>${p.goal}/km</td></tr>
    </table>
    <p class="hint">大会前8週：週平均 ${h.avgWeeklyKm}km・${h.avgRunsPerWeek}回、最長 ${h.longestKm}km</p>`;
}

function renderSettings(plan) {
  if (document.activeElement?.closest?.("#tab-settings form")) return; // 入力中は書き換えない
  $("set-weight").value = plan.body?.weightKg ?? "";
  $("set-weight").placeholder = plan.body?.corosWeightKg ? String(plan.body.corosWeightKg) : "";
  $("weight-hint").textContent = plan.body?.corosWeightKg
    ? `空欄なら COROS の体重（${plan.body.corosWeightKg}kg）を使います`
    : "COROS から体重を取れていません。入力してください";
  $("set-dist").value = plan.settings.distPct;
  $("set-pace").value = plan.settings.paceTolS;
}

// ---- シートの中身 ----
function renderSheet() {
  if (!sheet || !lastPlan) return;
  const { kind, key } = sheet;
  let html = "";
  if (kind === "day" || kind === "log" || kind === "past") {
    const day = findDay(key);
    if (!day) return closeSheet();
    const isToday = day.date === lastPlan.today;
    const isPast = day.date < lastPlan.today;
    const s = chosen(day);
    html += `<h3>${mmdd(day.date)}（${day.weekday}）${day.holiday ? ` <span class="hol">${esc(day.holiday)}</span>` : ""} <small class="muted">${esc(day.phaseLabel ?? "")}</small></h3>`;
    html += resultChip(day, true) ? `<div class="sheet-res">${resultChip(day, true)}</div>` : "";
    if (kind !== "log") {
      const p = isPast ? (day.planned ? (day.choice >= 0 && day.subs[day.choice]) || day.planned : null) : s;
      html += p ? sessionDetail(p) : `<p class="muted">${day.log?.status === "off" ? "走る予定なし" : "休養日"}</p>`;
      if (!isPast) html += renderChoices(day);
      html += day.notes.map((n) => `<p class="note">💬 ${esc(n)}</p>`).join("");
    }
    html += actualLine(day);
    if (!isPast && kind !== "log" && day.main) html += `<div class="actions">${pushButton(day)}${day.pushed ? `<span class="pushed">⌚ 送信済み：${esc(day.pushed.title)}</span>` : ""}</div><p class="msg" id="sheet-push-msg"></p>`;
    if (isPast || isToday) html += logButtons(day, isToday);
    else if (day.main || day.log?.status === "off") {
      const off = day.log?.status === "off";
      html += `<div class="logs"><button class="small ghost log-btn" data-date="${day.date}" data-status="${off ? "clear" : "off"}">${off ? "予定なしを取り消す" : "この日は走る予定なし"}</button></div>`;
    }
  } else if (kind === "stretch") {
    const st = [...(lastPlan.care?.before ?? []), ...(lastPlan.care?.after ?? [])].find((x) => x.id === key);
    if (!st) return closeSheet();
    html += `<h3>${esc(st.name)} <small class="muted">${esc(st.target)}・${holdText(st)}</small></h3>
      <ol class="steps">${st.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
      <button class="small ask-btn" data-id="${st.id}">🗣 コーチに教わる</button>`;
  } else if (kind === "food") {
    const n = lastPlan.nutrition;
    if (!n) return closeSheet();
    html += `<h3>${esc(n.dayType)} <small class="muted">体重 ${n.weightKg}kg${n.weightSource === "coros" ? "（COROS）" : ""}</small></h3>
      <p>炭水化物 ${n.carbs.perKg[0]}〜${n.carbs.perKg[1]}g/kg・たんぱく質 ${n.protein.perKg[0]}〜${n.protein.perKg[1]}g/kg</p>
      <ul class="menu">${n.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <p><strong>炭水化物</strong>：${n.foods.carbs.map(esc).join("／")}</p>
      <p><strong>たんぱく質</strong>：${n.foods.protein.map(esc).join("／")}</p>
      <p class="hint">一般的なスポーツ栄養の目安です（1日の合計）。医学的な判断ではありません。体調不良が続くときは医療機関に相談してください。</p>`;
  }
  $("sheet-body").innerHTML = html;
}

// ---- 読み込み ----
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
    setTab("settings");
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

async function loadPlan(connected) {
  const { status, body } = await api("/api/plan");
  if (status !== 200) {
    $("today").innerHTML = `<p class="ng">計画を読み込めませんでした（${esc(body?.message || status)}）</p>`;
    return;
  }
  lastPlan = body;
  coach?.say(body.coach);
  renderTop(body);
  renderAlerts(body);
  renderToday(body);
  renderDays(body);
  renderCare(body);
  renderNutrition(body);
  renderPast(body);
  renderVolume(body);
  renderAbility(body);
  renderSettings(body);
  renderSheet();
  if (connected && !body.sync.syncedAt && !autoSynced) {
    autoSynced = true;
    doSync();
  }
}

async function doSync() {
  $("sync").disabled = true;
  $("sync-label").textContent = "同期中…";
  const { status, body } = await api("/api/sync", { method: "POST" });
  $("sync").disabled = false;
  if (status === 200) {
    $("sync-msg").textContent = body.errors?.length ? `一部取得できませんでした：${body.errors.join(" / ")}` : "";
    await loadPlan(true);
  } else {
    $("sync-msg").textContent = `同期に失敗しました：${body?.message || body?.error || status}（「未同期」のまま表示しています）`;
    $("sync-label").textContent = "未同期";
  }
}
$("sync").addEventListener("click", doSync);

// ---- 操作 ----
document.addEventListener("click", async (e) => {
  const pb = e.target.closest(".push-btn");
  if (pb) {
    const date = pb.dataset.date;
    const msg = $("sheet-push-msg") && !$("sheet").hidden ? $("sheet-push-msg") : $("push-msg");
    pb.disabled = true;
    msg.textContent = "送信中…";
    const { status, body } = await api("/api/push", { method: "POST", body: JSON.stringify({ date, choice: findDay(date)?.choice ?? -1 }) });
    pb.disabled = false;
    if (status === 200) {
      await loadPlan(false);
      const m = !$("sheet").hidden && $("sheet-push-msg") ? $("sheet-push-msg") : $("push-msg");
      m.textContent = `${body.updated ? "時計の予定を書き換えました" : "時計の予定に登録しました"}。COROS アプリで同期すると時計に入ります${body.message ? `（${body.message}）` : ""}`;
    } else {
      msg.textContent = `送れませんでした：${body?.message || status}`;
    }
    return;
  }
  // ストレッチのやり方をコーチが説明する（動作の見本は第一段階では作らない）
  const ask = e.target.closest(".ask-btn");
  if (ask) {
    e.stopPropagation();
    const st = [...(lastPlan?.care?.before ?? []), ...(lastPlan?.care?.after ?? [])].find((x) => x.id === ask.dataset.id);
    if (st && coach) {
      closeSheet();
      coach.say(st.speech, { restart: true });
    }
    return;
  }
  const opener = e.target.closest("[data-sheet]");
  if (opener) {
    openSheet(opener.dataset.sheet, opener.dataset.date ?? opener.dataset.id ?? null);
    return;
  }
  const so = e.target.closest(".skip-open");
  if (so) {
    $(`reasons-${so.dataset.date}`).hidden = false;
    return;
  }
  const lb = e.target.closest(".log-btn");
  if (lb) {
    const { date, status, reason } = lb.dataset;
    let km = null;
    if (status === "ran") {
      const v = prompt("走った距離（km）。分からなければ空欄でOK", "");
      if (v === null) return;
      km = Number(v) || null;
    }
    lb.disabled = true;
    const r = await api("/api/day", {
      method: "POST",
      body: JSON.stringify({ date, status: status === "clear" ? null : status, reason: reason || null, km }),
    });
    if (r.status !== 200) alert(r.body?.message || "記録できませんでした");
    await loadPlan(false);
    return;
  }
  if (e.target.id === "pain-clear") {
    await api("/api/pain-clear", { method: "POST" });
    await loadPlan(false);
    return;
  }
  const b = e.target.closest(".choice");
  if (b) {
    await api("/api/choice", { method: "POST", body: JSON.stringify({ date: b.dataset.date, choice: Number(b.dataset.i) }) });
    await loadPlan(false);
  }
});

// ---- 設定 ----
function renderProbe(r) {
  lastProbe = r;
  show("download");
  const okCount = r.calls.filter((c) => c.ok).length;
  const writes = r.write_tools_available;
  let html = `<p class="summary">${new Date(r.ran_at).toLocaleString("ja-JP")} 実行 / 成功 ${okCount} / ${r.calls.length}</p>`;
  html += `<p class="summary">書き込みツール: ${writes.length ? `<span class="ok">${writes.length}個</span>` : `<span class="ng">なし</span>`}</p><ul class="calls">`;
  for (const c of r.calls) {
    const mark = c.ok ? `<span class="ok">✓</span>` : `<span class="ng">✗</span>`;
    const detail = c.error ? esc(c.error) : esc(JSON.stringify(c.data, null, 2).slice(0, 20000));
    html += `<li><details><summary>${mark} <code>${esc(c.tool)}</code></summary><pre>${detail}</pre></details></li>`;
  }
  $("probe-result").innerHTML = html + "</ul>";
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
  if (!$("login").hidden) $("login-msg").textContent = "パスワードは正しいのに、ログイン状態を保存できませんでした（Cookie がブロックされている可能性）。";
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

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ distPct: Number($("set-dist").value), paceTolS: Number($("set-pace").value) }),
  });
  $("settings-msg").textContent = r.status === 200 ? "保存しました" : "保存できませんでした";
  document.activeElement?.blur();
  await loadPlan(false);
});

$("body-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("set-weight").value.trim();
  const r = await api("/api/body", { method: "POST", body: JSON.stringify({ weightKg: v ? Number(v) : null }) });
  $("body-msg").textContent = r.status === 200 ? "保存しました" : "保存できませんでした";
  document.activeElement?.blur();
  await loadPlan(false);
});

// OAuth から戻ってきたときのメッセージ
const params = new URLSearchParams(location.search);
if (params.get("connected")) $("coros-msg").textContent = "COROSと接続しました。";
if (params.get("oauth_error")) {
  $("coros-msg").textContent = `接続に失敗しました: ${params.get("oauth_error")}`;
  setTab("settings");
}
if (params.get("login_required")) $("login-msg").textContent = "先にログインしてください。";
if ([...params.keys()].length) history.replaceState(null, "", "/");

refresh();
