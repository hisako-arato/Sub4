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
let session = null; // ケアの実演中の状態
let autoSynced = false;
let coach = null;
try {
  coach = createCoach({ canvas: $("coach-canvas"), bubble: $("coach-bubble"), text: $("coach-text"), more: $("coach-more") });
} catch (e) {
  console.warn("coach unavailable", e);
}
window.__coach = coach; // 動作確認用

// ---- タブ・切り替え ----
function setTab(name) {
  if (name !== "care" && session) stopCareSession(false);
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
  return `<button class="small push-btn" data-date="${day.date}">${day.pushed ? "⌚ 送り直す" : "⌚ 送る"}</button>`;
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
    .map((a) => `<div class="alert ${a.level}">${esc(a.text)}${a.text.includes("痛み") ? ` <button class="small ghost pain-btn" data-active="0">痛みは治った</button>` : ""}</div>`)
    .join("");
}

function renderToday(plan) {
  const day = plan.days[0];
  if (!day) {
    $("today").innerHTML = "<p class='muted'>計画の期間外です</p>";
    return;
  }
  const s = chosen(day);
  const head = `<div class="cs-head">今日 ${mmdd(day.date)}（${day.weekday}）${resultChip(day)}</div>`;
  const body = s
    ? `<button class="cs-main" data-sheet="day" data-date="${day.date}">${dot(s.category)}<b>${esc(s.title)}</b><span class="km">${s.distanceKm}km</span></button>
       <div class="cs-sub">${esc(s.pace)}${day.optional ? "・任意" : ""}</div>`
    : `<button class="cs-main" data-sheet="day" data-date="${day.date}">${dot("rest")}<b>休養日</b></button><div class="cs-sub">ケアで軽いストレッチを</div>`;
  const btns = `<div class="cs-btns">${s ? pushButton(day) : ""}${
    plan.pain ? "" : `<button class="small ghost pain-btn" data-active="1" aria-label="痛みがある" title="痛みがあるときに押す">🩹</button>`
  }</div><p class="msg" id="push-msg"></p>`;
  $("today").innerHTML = head + body + btns;
}

/** 今週：距離と曜日ごとの ✓ ✗ ○ */
function renderWeek(plan) {
  const v = plan.volume?.week;
  const mon = (() => {
    const d = new Date(plan.today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d;
  })();
  const all = [...(plan.past ?? []), ...plan.days];
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(mon.getTime() + i * 86400000).toISOString().slice(0, 10);
    const day = all.find((x) => x.date === dt);
    const wd = "月火水木金土日"[i];
    let mark = "·", cls = "none";
    const ran = day?.actual?.length;
    if (dt < plan.today) {
      if (ran) (mark = "✓"), (cls = "done");
      else if (day?.result?.state === "auto_skipped" || day?.result?.state === "skipped") (mark = "✗"), (cls = "miss");
    } else if (dt === plan.today) {
      if (ran) (mark = "✓"), (cls = "done");
      else if (day && chosen(day)) (mark = "●"), (cls = `today cat-${chosen(day).category}`);
    } else if (day && chosen(day)) (mark = "○"), (cls = `next cat-${chosen(day).category}`);
    cells.push(`<span class="wd ${dt === plan.today ? "is-today" : ""}"><small>${wd}</small><i class="${cls}">${mark}</i></span>`);
  }
  const done = v?.done ?? 0, total = Math.round(((v?.done ?? 0) + (v?.planned ?? 0)) * 10) / 10;
  const ratio = total ? Math.min(100, (done / total) * 100) : 0;
  $("week").innerHTML = `<div class="cs-head">今週</div>
    <div class="cs-big">${done}<small> / ${total}km</small></div>
    <div class="bar"><i style="width:${ratio}%"></i></div>
    <div class="wds">${cells.join("")}</div>`;
}

/** 大会までの流れ（期分けの帯といまの位置） */
function renderSeason(plan) {
  const segs = plan.season?.segments ?? [];
  if (!segs.length) return;
  const t = (d) => new Date(d + "T00:00:00Z").getTime();
  const start = t(segs[0].from), end = t(plan.season.race);
  const span = end - start;
  const now = Math.min(100, Math.max(0, ((t(plan.today) - start) / span) * 100));
  const bars = segs
    .map((g) => {
      const w = ((Math.min(t(g.to), end) - t(g.from) + 86400000) / span) * 100;
      const cur = plan.today >= g.from && plan.today <= g.to;
      return `<span class="seg-${g.phase}${g.label === "台北" ? " taipei" : ""}${cur ? " cur" : ""}" style="width:${w}%">${w > 9 ? g.label : ""}</span>`;
    })
    .join("");
  $("season").innerHTML = `<div class="cs-head"><span>大会までの流れ</span><span class="muted">静岡まで${plan.daysToRace}日</span></div>
    <div class="timeline">${bars}<i class="now" style="left:${now}%"></i></div>
    <div class="tl-foot"><span>${mmdd(segs[0].from)}</span><span>12/20 台北</span><span>3/14 静岡</span></div>`;
}

/** 気づき（上位2件。タップで詳しく、全部はシートで） */
function renderInsights(plan) {
  const ins = plan.insights ?? [];
  if (!ins.length) {
    $("insights").innerHTML = `<div class="cs-head">データからの気づき</div><p class="hint">同期すると、COROS のデータから気づいたことをここに出します</p>`;
    return;
  }
  const mark = { warn: "!", good: "◎", info: "i" };
  $("insights").innerHTML = `<div class="cs-head"><span>データからの気づき</span><button class="link small" data-sheet="insights">すべて見る（${ins.length}）</button></div>
    ${ins
      .slice(0, 2)
      .map((i) => `<button class="ins ins-${i.level}" data-sheet="insight" data-id="${i.id}"><span class="ins-ic">${i.icon}</span><span class="ins-t"><b>${esc(i.title)}</b><small>${esc(i.value)}</small></span><span class="ins-lv">${mark[i.level]}</span></button>`)
      .join("")}`;
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
        <button class="small ghost demo-btn" data-id="${st.id}">▶ 見本</button></div></li>`,
      )
      .join("");
  const n = c.before.length + c.after.length;
  const done = careDoneToday(plan.today);
  let html = `<div class="panel-head"><span>${esc(c.title)}${done ? ' <span class="lv lv-ok">✓ 完了</span>' : ""}</span>${
    n ? `<button class="small session-btn">▶ まとめてやる（${n}種目）</button>` : ""}</div>`;
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

/** 練習カレンダー：先週・今週・来週・再来週（過去は結果、これからは練習の種類） */
function renderCalendar(plan) {
  const t = (d) => new Date(d + "T00:00:00Z");
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const today = plan.today;
  const mon0 = t(today).getTime() - ((t(today).getUTCDay() + 6) % 7) * 86400000 - 7 * 86400000;
  const all = [...(plan.past ?? []), ...plan.days];
  const RES = { achieved: ["◎", "ok"], partial: ["△", "mid"], missed: ["✕", "ng"], done: ["✓", "ok"] };
  const weekNames = ["先週", "今週", "来週", "再来週"];
  let html = `<div class="cal-row cal-headrow"><span></span>${"月火水木金土日".split("").map((w, i) => `<span class="${i === 5 ? "sat" : i === 6 ? "sun" : ""}">${w}</span>`).join("")}<span>計</span></div>`;
  for (let w = 0; w < 4; w++) {
    let actual = 0, planned = 0;
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const date = iso(mon0 + (w * 7 + i) * 86400000);
      const day = all.find((x) => x.date === date);
      const past = date < today;
      const ran = day?.actual?.reduce((s, a) => s + a.distanceKm, 0) ?? 0;
      actual += ran;
      let mark = "", cls = "";
      if (day && (past || (date === today && ran))) {
        const r = day.result;
        if (r?.state === "ran" || r?.state === "ran_manual") [mark, cls] = RES[r.achievement.level];
        else if (r?.state === "extra") [mark, cls] = day.actual.some((a) => a.distanceKm >= 40) ? ["🏁", "race"] : ["✓", "ok"];
        else if (r?.state === "auto_skipped" || r?.state === "skipped") [mark, cls] = ["✕", "ng"];
      } else if (day) {
        const s = chosen(day);
        if (s) {
          mark = CAT[s.category].icon;
          cls = `plan cat-${s.category}${day.optional ? " opt" : ""}`;
          if (!day.optional) planned += s.distanceKm;
        }
      }
      const isToday = date === today;
      const hol = day?.holiday ? " hol" : "";
      cells.push(
        `<button class="cal-cell${isToday ? " is-today" : ""}${past ? " past" : ""}${hol}" ${day ? `data-sheet="day" data-date="${date}"` : "disabled"}>
          <small>${Number(date.slice(8, 10))}</small><i class="${cls}">${mark || "·"}</i></button>`,
      );
    }
    const total = w < 1 ? actual : w === 1 ? actual + planned : planned;
    const sum = w === 1 ? `${Math.round(actual)}/${Math.round(total)}` : `${Math.round(total)}`;
    html += `<div class="cal-row"><span class="cal-wk">${weekNames[w]}</span>${cells.join("")}<span class="cal-sum">${sum}<small>km</small></span></div>`;
  }
  $("cal").innerHTML = html;
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
    if (isPast && !day.actual.length && day.result?.state === "auto_skipped") html += `<p class="hint">COROS に走った記録がないので「走らなかった」として計画を組み直しています。走っていたら COROS で同期してください。</p>`;
  } else if (kind === "insights" || kind === "insight") {
    const list = (lastPlan.insights ?? []).filter((i) => kind === "insights" || i.id === key);
    if (!list.length) return closeSheet();
    html += `<h3>データからの気づき</h3><p class="hint">COROS の活動・心拍・ラップ・負荷を組み合わせて読み取ったことです</p>` +
      list.map((i) => `<div class="ins-full ins-${i.level}"><b>${i.icon} ${esc(i.title)}</b><div class="ins-v">${esc(i.value)}</div><p>${esc(i.text)}</p></div>`).join("");
  } else if (kind === "stretch") {
    const st = [...(lastPlan.care?.before ?? []), ...(lastPlan.care?.after ?? [])].find((x) => x.id === key);
    if (!st) return closeSheet();
    html += `<h3>${esc(st.name)} <small class="muted">${esc(st.target)}・${holdText(st)}</small></h3>
      <ol class="steps">${st.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
      <button class="small demo-btn" data-id="${st.id}">▶ コーチの見本</button>`;
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
  renderWeek(body);
  renderSeason(body);
  renderInsights(body);
  renderCalendar(body);
  renderCare(body);
  renderNutrition(body);
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
    $("sync-msg").textContent = "";
    $("sync-detail").textContent = body.errors?.length ? `前回の同期で一部取得できませんでした：${body.errors.join(" / ")}` : "";
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
  // ストレッチの実演（コーチが動いて見せる）
  const demoBtn = e.target.closest(".demo-btn");
  if (demoBtn) {
    e.stopPropagation();
    const st = [...(lastPlan?.care?.before ?? []), ...(lastPlan?.care?.after ?? [])].find((x) => x.id === demoBtn.dataset.id);
    closeSheet();
    if (st) startCareSession([st]);
    return;
  }
  if (e.target.closest(".session-btn")) {
    startCareSession([...(lastPlan?.care?.before ?? []), ...(lastPlan?.care?.after ?? [])]);
    return;
  }
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
  const pain = e.target.closest(".pain-btn");
  if (pain) {
    const on = pain.dataset.active === "1";
    if (on && !confirm("痛みがあることを記録しますか？\n強度を下げ、休養を優先した計画にします（「治った」で戻ります）")) return;
    await api("/api/pain", { method: "POST", body: JSON.stringify({ active: on }) });
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

// ---- ケアの実演（コーチがストレッチを動いて見せ、時間を数える） ----
const careKey = (d) => `sub4-care-${d}`;
function careDoneToday(d) {
  try {
    return localStorage.getItem(careKey(d)) === "1";
  } catch {
    return false;
  }
}

/** 実演の流れ：手順を話しながら構える → 保持（秒を数える）→ 反対側 → 次の種目 */
function buildSteps(list) {
  const steps = [];
  list.forEach((st, i) => {
    const sides = st.sides ? ["left", "right"] : ["left"];
    const holdSec = st.kind === "dynamic" ? 14 : st.holdSec;
    const lines = st.speech?.lines ?? [st.name];
    sides.forEach((side, k) => {
      const label = st.sides ? (side === "left" ? "左" : "右") : "";
      if (k === 0) {
        const intro = [i > 0 ? `次は${st.name}よ！` : lines[0], ...lines.slice(1, -1)];
        intro.forEach((l, j) => steps.push({ st, side, label, phase: "prep", sec: Math.max(2.5, l.length * 0.12), line: l, first: j === 0 }));
        steps.push({ st, side, label, phase: "hold", sec: holdSec, line: lines.at(-1) });
      } else {
        steps.push({ st, side, label, phase: "prep", sec: 2.5, line: "反対側！ 同じように構えて" });
        steps.push({ st, side, label, phase: "hold", sec: holdSec, line: "そのままキープ。呼吸は止めないのよ" });
      }
    });
  });
  return steps;
}

function startCareSession(list) {
  if (!list.length || !coach) return;
  setTab("care");
  session = { steps: buildSteps(list), list, i: -1, left: 0, paused: false, timer: null, last: performance.now(), said10: false };
  document.querySelector(".shell").classList.add("demo");
  show("care-list", false);
  show("care-session");
  nextStep();
  session.timer = setInterval(tickSession, 200);
}

function nextStep() {
  session.i++;
  const step = session.steps[session.i];
  if (!step) return finishCareSession();
  session.left = step.sec;
  session.said10 = false;
  coach.demo(step.st.id, step.side);
  coach.say({ expression: step.phase === "hold" ? "relaxed" : "happy", lines: [step.line] }, { restart: true });
  renderSession();
}

function tickSession() {
  if (!session || session.paused) {
    if (session) session.last = performance.now();
    return;
  }
  const now = performance.now();
  session.left -= (now - session.last) / 1000;
  session.last = now;
  const step = session.steps[session.i];
  if (step.phase === "hold" && step.sec >= 20 && !session.said10 && session.left <= 10) {
    session.said10 = true;
    coach.say({ expression: "happy", lines: ["あと10秒！ もうひと息よ"] }, { restart: true });
  }
  if (session.left <= 0) nextStep();
  else updateCount();
}

/** 秒数だけ書き換える（ボタンは作り直さないので、押し損じない） */
function updateCount() {
  const step = session?.steps[session.i];
  const el = document.querySelector("#care-session .cs-count");
  if (step && el && step.phase === "hold") el.innerHTML = `${Math.max(0, Math.ceil(session.left))}<small>秒</small>`;
}

function renderSession() {
  const step = session.steps[session.i];
  if (!step) return;
  const idx = session.list.indexOf(step.st);
  const dots = session.list.map((_, k) => `<i class="${k < idx ? "done" : k === idx ? "cur" : ""}"></i>`).join("");
  const sec = Math.max(0, Math.ceil(session.left));
  $("care-session").innerHTML = `
    <div class="cs-name"><b>${esc(step.st.name)}</b>${step.label ? `<span class="side">${step.label}</span>` : ""}<span class="muted">${esc(step.st.target)}</span></div>
    <div class="cs-count ${step.phase}">${step.phase === "hold" ? `${sec}<small>秒</small>` : "構えて"}</div>
    <div class="cs-dots">${dots}</div>
    <div class="cs-ctrl">
      <button class="small ghost" id="ss-pause">${session.paused ? "▶ 再開" : "⏸ 一時停止"}</button>
      <button class="small ghost" id="ss-next">⏭ 次へ</button>
      <button class="small ghost" id="ss-stop">✕ やめる</button>
    </div>
    <p class="hint warn-text">痛みが出たらすぐ中止。反動はつけず、気持ちいいところで止めてね</p>`;
}

function finishCareSession() {
  try {
    localStorage.setItem(careKey(lastPlan?.today ?? ""), "1");
  } catch {}
  stopCareSession(true);
}

function stopCareSession(done) {
  if (!session) return;
  clearInterval(session.timer);
  session = null;
  coach?.demo(null);
  document.querySelector(".shell").classList.remove("demo");
  show("care-session", false);
  show("care-list");
  coach?.say({ expression: "happy", lines: [done ? "おつかれさま、ハルキ君！ 今日のケアは完了よ。えらいじゃない" : "今日はここまでね。続きはまた今度でいいわ"] }, { restart: true });
  if (lastPlan) renderCare(lastPlan);
}

document.addEventListener("click", (e) => {
  if (!session) return;
  if (e.target.id === "ss-pause") {
    session.paused = !session.paused;
    e.target.textContent = session.paused ? "▶ 再開" : "⏸ 一時停止";
  } else if (e.target.id === "ss-next") nextStep();
  else if (e.target.id === "ss-stop") stopCareSession(false);
});
