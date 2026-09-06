/* ------------------------------------------------------------------
   Kairos CRM demo — client-side reimplementation of the Streamlit app.
   All state is in memory; edits persist for the session only.
   ------------------------------------------------------------------ */

const state = {
  user: null,
  page: "dashboard",
  accountId: null,
  backTo: null,
  acctTab: "Details",
  donutTab: "scrape",
  dashOwner: null,
  filters: { q: "", owner: null, stage: "All", channel: "All", city: "", dueToday: false, overdue: false, sort: "Practice name" },
  templateFilter: "All",
  flash: null,
  scrapeError: null,
  polygon: null,
  csvStep: 0,
  chat: JSON.parse(JSON.stringify(BOT_THREADS)),
  chatThread: "Texts",
  mapObj: null,
};

/* ---------------- tiny DOM helpers ---------------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function userName(id) {
  const u = USERS.find((x) => x.id === id);
  return u ? u.name : "—";
}

function callBadge(status) {
  const c = CALL_STATUS_COLORS[status] || { bg: "#e2e8f0", fg: "#1e293b" };
  return `<span class="badge" style="background:${c.bg};color:${c.fg}">${esc(status)}</span>`;
}

function badge(stage) {
  if (!stage) return "—";
  const c = STAGE_COLORS[stage] || { bg: "#e2e8f0", fg: "#1e293b" };
  return `<span class="badge" style="background:${c.bg};color:${c.fg}">${esc(stage)}</span>`;
}

function title(text, opts = {}) {
  const btn = opts.refresh === false ? "" :
    `<button class="btn" data-act="refresh">${icon("refresh")} Refresh</button>`;
  return `<div class="page-head"><h1 class="st-title">${esc(text)}</h1>${btn}</div>`;
}

/* Streamlit cycles divider colours blue → green → orange → red → violet */
const DIV_COLORS = ["", "green", "orange", "red", "violet"];
function subheader(text, i = 0) {
  return `<h2 class="st-subheader">${esc(text)}</h2><div class="st-divider ${DIV_COLORS[i % 5]}"></div>`;
}

const ICONS = {
  dashboard: '<path d="M3 3h7v7H3zM14 3h7v5h-7zM14 11h7v10h-7zM3 13h7v8H3z"/>',
  groups: '<path d="M12 12a3 3 0 100-6 3 3 0 000 6zm-7 1a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm14 0a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM12 14c-2.7 0-5 1.3-5 3v2h10v-2c0-1.7-2.3-3-5-3zM3.5 15C2 15.5 1 16.4 1 17.5V19h4.5v-2c0-.8.3-1.5.8-2zm17 0c-.3-.1-.6-.1-.8 0 .5.5.8 1.2.8 2v2H23v-1.5c0-1.1-1-2-2.5-2.5z"/>',
  business: '<path d="M3 21V7l6-4v4l6-3v5h6v12H3zm2-2h4v-3H5v3zm0-5h4v-3H5v3zm0-5h4V6L5 8v1zm6 10h4v-3h-4v3zm0-5h4v-3h-4v3zm0-5h4V6l-4 2v1zm6 10h2v-3h-2v3zm0-5h2v-3h-2v3z"/>',
  map: '<path d="M15 19l-6-2.1L4.4 18.7c-.3.1-.6.1-.9-.1-.3-.2-.5-.5-.5-.8V5.7c0-.2.1-.4.2-.6.1-.2.3-.3.6-.4L9 3l6 2.1 4.6-1.8c.3-.1.6-.1.9.1.3.2.5.5.5.8v12.1c0 .2-.1.4-.2.6-.1.2-.3.3-.6.4L15 19zm-1-2.2V6.8l-4-1.4v10l4 1.4z"/>',
  mail: '<path d="M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm8 7L4.4 6.3 4 6v.6l8 5 8-5V6l-.4.3L12 11z"/>',
  upload_file: '<path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9l-7-7zm-1 2.5L17.5 10H13a1 1 0 01-1-1V4.5zM12 19l-3.5-3.5h2.25V12h2.5v3.5h2.25L12 19z"/>',
  settings: '<path d="M12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7zm7.4-2.6l1.9 1.5-1.9 3.3-2.3-.9c-.5.4-1 .7-1.6.9l-.3 2.4h-3.8l-.3-2.4c-.6-.2-1.1-.5-1.6-.9l-2.3.9-1.9-3.3 1.9-1.5a6.4 6.4 0 010-1.8L3.3 9.6l1.9-3.3 2.3.9c.5-.4 1-.7 1.6-.9l.3-2.4h3.8l.3 2.4c.6.2 1.1.5 1.6.9l2.3-.9 1.9 3.3-1.9 1.5c.1.6.1 1.2 0 1.8z"/>',
  refresh: '<path d="M17.65 6.35A8 8 0 105.5 16.5l1.45-1.45A6 6 0 1112 18a6 6 0 01-4.24-1.76l-1.42 1.42A8 8 0 1017.65 6.35zM13 3v6h6l-2.35-2.35z"/>',
  person: '<path d="M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-3.3 0-8 1.7-8 4v2h16v-2c0-2.3-4.7-4-8-4z"/>',
  add: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  filter: '<path d="M4 5h16v2l-6 6v6l-4-2v-4L4 7z"/>',
  back: '<path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/>',
  save: '<path d="M17 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V7l-4-4zm-5 16a3 3 0 110-6 3 3 0 010 6zm3-10H5V5h10v4z"/>',
  calendar: '<path d="M7 2v2h10V2h2v2h1a2 2 0 012 2v14a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h1V2h2zm13 8H4v10h16V10z"/>',
  task: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  list: '<path d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zM4 16h2v2H4zm4 0h12v2H8z"/>',
  delete: '<path d="M6 7h12v13a2 2 0 01-2 2H8a2 2 0 01-2-2V7zm3-4h6l1 2h4v2H4V5h4l1-2z"/>',
  enroll: '<path d="M3 5h12v2H3zm0 4h12v2H3zm0 4h8v2H3zm14-4h2v3h3v2h-3v3h-2v-3h-3v-2h3z"/>',
  send: '<path d="M2 21l21-9L2 3v7l15 2-15 2z"/>',
  help: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 17h-2v-2h2v2zm2.1-7.7l-.9.9c-.7.7-1.2 1.3-1.2 2.8h-2v-.5c0-1.1.5-2.1 1.2-2.8l1.2-1.2c.4-.4.6-.9.6-1.5a2 2 0 10-4 0H8a4 4 0 118 0c0 .9-.4 1.6-.9 2.3z"/>',
};

function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

/* ---------------- derived data (mirrors utils/stale.py) ---------------- */

function categorize(accounts) {
  const today = centralToday();
  const weekEnd = (() => {
    const d = new Date(today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + (6 - ((d.getUTCDay() + 6) % 7)));
    return d.toISOString().slice(0, 10);
  })();

  const due_today = [], overdue = [], stale = [], upcoming = [];

  for (const a of accounts) {
    const due = a.next_action_due_date;
    const last = a.last_action_date;
    const openStage = !CLOSED_STAGES.has(a.pipeline_stage);
    const hasNext = !!(a.next_action || "").trim();

    if (due === today) due_today.push({ account: a });
    if (due && due < today && openStage) overdue.push({ account: a, days_overdue: daysBetween(due, today) });

    if (openStage) {
      const reasons = [];
      if (due && due < today) reasons.push(`Next action ${daysBetween(due, today)}d overdue`);
      if (!hasNext) reasons.push("No next action set");
      if (last && daysBetween(last, today) >= STALE_DAYS) reasons.push(`No activity in ${daysBetween(last, today)}d`);
      if (["Interested", "Waiting on Decision"].includes(a.pipeline_stage) && last && daysBetween(last, today) >= WAITING_STALE_DAYS)
        reasons.push(`In ${a.pipeline_stage} with no activity for ${daysBetween(last, today)}d`);
      if (reasons.length) stale.push({ account: a, reasons });
    }

    if (due && due > today && due <= weekEnd) upcoming.push({ account: a });
  }

  overdue.sort((x, y) => y.days_overdue - x.days_overdue);
  upcoming.sort((x, y) => (x.account.next_action_due_date > y.account.next_action_due_date ? 1 : -1));
  return { due_today, overdue, stale, upcoming };
}

function latestActivity(accountId) {
  const acts = ACTIVITIES.filter((a) => a.account_id === accountId && !a.system)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return acts[0] || null;
}

/* ---------------- sidebar ---------------- */

const NAV = [
  ["dashboard", "Dashboard", "dashboard"],
  ["overview", "Team Overview", "groups"],
  ["accounts", "Accounts", "business"],
  ["donut", "Donut Scraper", "map"],
  ["templates", "Email Templates", "mail"],
  ["csv", "CSV Import", "upload_file"],
  ["settings", "Settings", "settings"],
];

const TOUR_BTN = `<button class="btn tour-launch" data-act="start-tour">${icon("help", 14)} Take the tour</button>`;

function renderSidebar() {
  const nav = NAV.map(([id, label, ic]) =>
    `<a data-nav="${id}" class="${state.page === id || (id === "accounts" && state.page === "account") ? "active" : ""}">${icon(ic)}${esc(label)}</a>`
  ).join("");

  if (!state.user) {
    $("#sidebar").innerHTML = `
      <div class="sidebar-top">${TOUR_BTN}</div>
      <nav class="nav" data-tour="nav">${nav}</nav>`;
    return;
  }

  const msgs = state.chat[state.chatThread] || [];
  const log = msgs.map((m) => {
    const t = new Date(Date.now() - m.ago * 60000);
    const ts = t.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `<div class="chat-msg ${m.who}"><div class="bar"></div><div class="body">
      <p>${esc(m.text)}</p><div class="ts">${esc(ts)}</div></div></div>`;
  }).join("");

  $("#sidebar").innerHTML = `
    <div class="sidebar-user">
      <span class="who">${icon("person", 16)} Logged in as ${esc(state.user.name)}</span>
      ${TOUR_BTN}
    </div>
    <nav class="nav" data-tour="nav">${nav}</nav>
    <div class="chat-panel" data-tour="bot">
      <div class="chat-controls">
        <select><option>Texts</option></select>
        <button title="New thread">+</button>
        <button title="More">&#8942;</button>
      </div>
      <div class="chat-log" id="chatlog">${log}</div>
      <form class="chat-input" id="chatform">
        <input id="chatinput" placeholder="Message Kairos Bot..." autocomplete="off">
        <button type="submit">${icon("send", 16)}</button>
      </form>
    </div>`;

  $("#chatlog").scrollTop = $("#chatlog").scrollHeight;
}

/* ---------------- pages ---------------- */

function pageLanding() {
  return `
    <h1 class="st-title">Kairos CRM</h1>
    <h2 class="st-subheader" style="font-size:24px;padding-top:0">Who are you?</h2>
    <p class="st-caption">Your selection pre-fills the Kairos Owner field on new records. It is always editable per-entry.</p>
    <div class="landing-users" data-tour="landing-users">
      ${USERS.filter((u) => u.active).map((u) => `<button class="btn" data-login="${u.id}">${esc(u.name)}</button>`).join("")}
    </div>
    <div style="margin-top:56px;max-width:760px">
      <div class="st-alert info">
        <strong>This is a public demo.</strong> Every practice, contact and deal below is fictional.
        The tour walks through the same screens the Kairos sales team uses day to day.
      </div>
      <button class="btn primary" data-act="start-tour">Start the guided tour</button>
    </div>`;
}

function listRows(items, { showOverdue = false, extraCity = false } = {}) {
  if (!items.length) return `<p class="st-caption">Nothing here.</p>`;
  const cls = extraCity ? " acct" : "";
  const heads = extraCity
    ? ["Practice", "City", "Owner", "Stage", "Next action", "Due date", ""]
    : ["Practice", "Owner", "Stage", "Next action", "Due date", ""];

  const header = `<div class="row-header${cls}">${heads.map((h) => `<div>${h}</div>`).join("")}</div>`;

  const body = items.map((item, i) => {
    const a = item.account || item;
    const due = a.next_action_due_date;
    const dueTxt = showOverdue && item.days_overdue != null
      ? `${due} (${item.days_overdue}d overdue)` : (due || "—");
    const cells = [
      `<div class="name">${esc(a.practice_name)}</div>`,
      extraCity ? `<div>${esc(a.city || "—")}</div>` : null,
      `<div>${esc(userName(a.kairos_owner_id))}</div>`,
      `<div>${badge(a.pipeline_stage)}</div>`,
      `<div>${esc(a.next_action || "—")}</div>`,
      `<div>${esc(dueTxt)}</div>`,
      `<div><button class="btn sm full" data-open="${a.id}">Open</button></div>`,
    ].filter(Boolean).join("");
    const reasons = item.reasons ? `<div class="row-reasons">${esc(item.reasons.join("; "))}</div>` : "";
    return `<div class="row${cls} ${i % 2 === 0 ? "even" : ""}">${cells}</div>${reasons}`;
  }).join("");

  return header + body;
}

function pageDashboard() {
  const owner = state.dashOwner ?? state.user.id;
  const accounts = ACCOUNTS.filter((a) => owner === "all" ? true : a.kairos_owner_id === owner);
  const b = categorize(accounts);
  const ownerDesc = owner === "all" ? "All Owners" : userName(owner);

  const opts = [`<option value="all">All Owners</option>`]
    .concat(USERS.filter((u) => u.active).map((u) =>
      `<option value="${u.id}" ${u.id === owner ? "selected" : ""}>${esc(u.name)}</option>`)).join("");

  return `
    ${title("Dashboard")}
    <div class="field" style="margin-top:8px" data-tour="dash-owner">
      <label>Filter by owner</label>
      <select id="dashOwner">${opts}</select>
    </div>
    <div class="st-alert info" data-tour="dash-summary">
      Showing accounts owned by ${esc(ownerDesc)}: ${b.overdue.length} overdue follow-ups,
      ${b.due_today.length} actions due today, ${b.stale.length} stale leads,
      ${b.upcoming.length} upcoming this week.
    </div>

    <div data-tour="dash-due">${subheader("Due Today", 0)}${listRows(b.due_today)}</div>
    <div data-tour="dash-overdue">${subheader("Overdue", 1)}${listRows(b.overdue, { showOverdue: true })}</div>
    <div data-tour="dash-stale">${subheader("Stale Leads", 2)}${listRows(b.stale)}</div>
    <div>${subheader("Upcoming This Week", 3)}${listRows(b.upcoming)}</div>
    <p class="st-caption" style="margin-top:16px">As of ${centralToday()} (Central). Auto-refreshes every 60 seconds.</p>`;
}

function pageOverview() {
  const b = categorize(ACCOUNTS);
  const open = ACCOUNTS.filter((a) => !CLOSED_STAGES.has(a.pipeline_stage));
  const won = ACCOUNTS.filter((a) => a.pipeline_stage === "Closed Won");
  const today = centralToday();
  const demosWeek = DEMOS.filter((d) => d.date >= today && daysBetween(today, d.date) <= 7);

  const kpis = [
    ["Total accounts", ACCOUNTS.length, "#475569"],
    ["Open pipeline", open.length, "#2563eb"],
    ["Due today", b.due_today.length, "#d97706"],
    ["Overdue", b.overdue.length, "#dc2626"],
    ["Demos this week", demosWeek.length, "#7e22ce"],
    ["Closed won", won.length, "#16a34a"],
  ].map(([l, v, c]) => `<div class="kpi"><div class="label">${l}</div><div class="value" style="color:${c}">${v}</div></div>`).join("");

  const total = Math.max(ACCOUNTS.length, 1);
  const stageRows = PIPELINE_STAGES.map((s) => {
    const n = ACCOUNTS.filter((a) => a.pipeline_stage === s).length;
    const pct = (n / total) * 100;
    return `<tr><td>${esc(s)}</td><td class="num">${n}</td><td>
      <div class="progress-cell"><span class="progress"><span style="width:${pct}%"></span></span>
      <span class="pct">${pct.toFixed(2)}%</span></div></td></tr>`;
  }).join("");

  const totalOpen = Math.max(open.length, 1);
  const teamRows = USERS.filter((u) => u.active).map((u) => {
    const o = open.filter((a) => a.kairos_owner_id === u.id).length;
    const cnt = (list) => list.filter((r) => (r.account || r).kairos_owner_id === u.id).length;
    const pct = (o / totalOpen) * 100;
    return `<tr><td>${esc(u.name)}</td><td class="num">${o}</td>
      <td><div class="progress-cell"><span class="progress"><span style="width:${pct}%"></span></span>
      <span class="pct">${pct.toFixed(0)}%</span></div></td>
      <td class="num">${cnt(b.due_today)}</td><td class="num">${cnt(b.overdue)}</td>
      <td class="num">${cnt(b.stale)}</td>
      <td class="num">${demosWeek.filter((d) => (ACCOUNTS.find((a) => a.id === d.account_id) || {}).kairos_owner_id === u.id).length}</td>
      <td class="num">${won.filter((a) => a.kairos_owner_id === u.id).length}</td></tr>`;
  }).join("");

  const closing = ACCOUNTS.filter((a) => CLOSING_STAGES.includes(a.pipeline_stage))
    .sort((x, y) => String(x.next_action_due_date || "9999-12-31").localeCompare(String(y.next_action_due_date || "9999-12-31")));

  const recent = ACTIVITIES.filter((a) => !a.system).sort((a, b2) => (a.date < b2.date ? 1 : -1)).slice(0, 8)
    .map((e) => {
      const acct = ACCOUNTS.find((a) => a.id === e.account_id);
      return `<div class="st-md"><p style="margin-bottom:2px"><strong>${e.date}</strong> — ${esc(acct ? acct.practice_name : "—")} — ${esc(e.activity_type)} — ${esc(userName(e.owner))}</p>
        ${e.summary ? `<p class="st-caption" style="margin-bottom:10px">${esc(e.summary)}</p>` : ""}</div>`;
    }).join("");

  return `
    ${title("Team Overview")}
    <p class="st-caption">Every lead across the whole team, regardless of owner or who is acting.</p>
    <div class="grid c6" data-tour="ov-kpis" style="margin:8px 0 12px">${kpis}</div>

    <div data-tour="ov-pipeline">
      ${subheader("Pipeline by stage", 0)}
      <table class="df" style="margin-top:12px"><thead><tr><th>Stage</th><th>Accounts</th><th>Share of all accounts</th></tr></thead>
      <tbody>${stageRows}</tbody></table>
    </div>

    <div data-tour="ov-team">
      ${subheader("Team load", 1)}
      <table class="df" style="margin-top:12px"><thead><tr><th>Owner</th><th>Open leads</th><th>Share of open pipeline</th>
      <th>Due today</th><th>Overdue</th><th>Stale</th><th>Demos this week</th><th>Closed won</th></tr></thead>
      <tbody>${teamRows}</tbody></table>
    </div>

    ${subheader("Closest to close", 2)}
    <p class="st-caption">Open accounts in ${CLOSING_STAGES.join(", ")}, soonest next action first.</p>
    ${listRows(closing)}

    ${subheader("Recent team activity", 3)}
    <div style="margin-top:12px">${recent}</div>`;
}

function filteredAccounts() {
  const f = state.filters;
  let list = ACCOUNTS.slice();
  if (f.q) list = list.filter((a) => a.practice_name.toLowerCase().includes(f.q.toLowerCase()));
  if (f.owner && f.owner !== "all") list = list.filter((a) => a.kairos_owner_id === Number(f.owner));
  if (f.stage !== "All") list = list.filter((a) => a.pipeline_stage === f.stage);
  if (f.channel !== "All") list = list.filter((a) => a.channel_type === f.channel);
  if (f.city) list = list.filter((a) => (a.city || "").toLowerCase().includes(f.city.toLowerCase()));
  const today = centralToday();
  if (f.dueToday) list = list.filter((a) => a.next_action_due_date === today);
  if (f.overdue) list = list.filter((a) => a.next_action_due_date && a.next_action_due_date < today && !CLOSED_STAGES.has(a.pipeline_stage));

  if (f.sort === "Practice name") list.sort((a, b) => a.practice_name.localeCompare(b.practice_name));
  else if (f.sort === "Due date") list.sort((a, b) => String(a.next_action_due_date || "9999").localeCompare(String(b.next_action_due_date || "9999")));
  else if (f.sort === "Last action") list.sort((a, b) => String(b.last_action_date).localeCompare(String(a.last_action_date)));
  return list;
}

function pageAccounts() {
  const f = state.filters;
  const list = filteredAccounts();
  const ownerOpts = [`<option value="all">All</option>`].concat(
    USERS.filter((u) => u.active).map((u) => `<option value="${u.id}" ${String(f.owner) === String(u.id) ? "selected" : ""}>${esc(u.name)}</option>`)).join("");
  const sel = (opts, cur) => opts.map((o) => `<option ${o === cur ? "selected" : ""}>${esc(o)}</option>`).join("");

  return `
    ${title("Accounts")}
    <button class="btn full" style="margin-bottom:16px;justify-content:flex-start">${icon("add")} Add account</button>

    <details class="expander" data-tour="acct-filters" open>
      <summary>${icon("filter")} Filters and search</summary>
      <div class="expander-body">
          <div class="grid c5">
            <div class="field"><label>Search practice name</label><input id="fq" value="${esc(f.q)}"></div>
            <div class="field"><label>Kairos owner</label><select id="fowner">${ownerOpts}</select></div>
            <div class="field"><label>Pipeline stage</label><select id="fstage">${sel(["All", ...PIPELINE_STAGES], f.stage)}</select></div>
            <div class="field"><label>Channel type</label><select id="fchannel">${sel(["All", ...CHANNEL_TYPES], f.channel)}</select></div>
            <div class="field"><label>City</label><input id="fcity" value="${esc(f.city)}"></div>
          </div>
          <div class="grid c4" style="margin-top:4px">
            <label class="checkline"><input type="checkbox" id="fdue" ${f.dueToday ? "checked" : ""}> Due today</label>
            <label class="checkline"><input type="checkbox" id="fover" ${f.overdue ? "checked" : ""}> Overdue</label>
            <label class="checkline"><input type="checkbox" disabled> In cadence</label>
            <label class="checkline"><input type="checkbox" disabled> No activity in X+ days</label>
          </div>
        <div class="field" style="max-width:50%"><label>Sort by</label>
          <select id="fsort">${sel(["Practice name", "Due date", "Last action"], f.sort)}</select></div>
      </div>
    </details>

    <p class="st-caption">${list.length} accounts</p>
    <div data-tour="acct-list">${listRows(list, { extraCity: true })}</div>`;
}

function pageAccountDetail() {
  const a = ACCOUNTS.find((x) => x.id === state.accountId);
  if (!a) return pageAccounts();
  const last = latestActivity(a.id);
  const tabs = ["Details", "Contacts", "Activity Log", "Demos"];

  const tabBar = `<div class="tabs" data-tour="acct-tabs">${tabs.map((t) =>
    `<button data-acttab="${esc(t)}" class="${state.acctTab === t ? "active" : ""}">${esc(t)}</button>`).join("")}</div>`;

  return `
    <button class="btn" data-act="back">${icon("back")} Back to accounts</button>
    <div class="page-head" style="margin-top:8px">
      <h1 class="st-title">${esc(a.practice_name)}</h1>${badge(a.pipeline_stage)}
    </div>
    <p class="st-caption">Owner: ${esc(userName(a.kairos_owner_id))} | Channel: ${esc(a.channel_type)} | Last action: ${esc(a.last_action_date)}</p>
    <div class="st-alert info">${last
      ? `<strong>Latest activity (${last.date}):</strong> ${esc(last.activity_type)} — ${esc(last.summary)}`
      : `<strong>Latest activity:</strong> No activity logged yet.`}</div>

    <div class="panel" data-tour="acct-cadence">
      <div class="grid" style="grid-template-columns:1fr auto;align-items:end">
        <div class="field" style="margin:0"><label>Enroll in a cadence</label>
          <select>${CADENCES.map((c) => `<option>${esc(c.name)}</option>`).join("")}</select></div>
        <button class="btn">${icon("enroll")} Enroll</button>
      </div>
      <p class="st-caption" style="margin-top:10px">${esc(CADENCES[0].description)}</p>
      <hr class="hr">
      <div class="st-md"><p><strong>Or schedule a one-off follow-up</strong> (no cadence needed)</p></div>
      <div class="grid" style="grid-template-columns:2fr 1.4fr 3fr auto;align-items:end">
        <div class="field" style="margin:0"><label>Follow-up type</label>
          <select>${ACTIVITY_TYPES.map((t) => `<option>${esc(t)}</option>`).join("")}</select></div>
        <div class="field" style="margin:0"><label>In how many days</label><input value="2"></div>
        <div class="field" style="margin:0"><label>Note (this is the whole action when type is Custom)</label><input></div>
        <button class="btn">${icon("calendar")} Schedule</button>
      </div>
    </div>

    ${tabBar}
    <div data-tour="acct-tabbody">${acctTabBody(a)}</div>`;
}

function acctTabBody(a) {
  if (state.acctTab === "Details") {
    const sel = (opts, cur) => opts.map((o) => `<option ${o === cur ? "selected" : ""}>${esc(o)}</option>`).join("");
    return `
      <p class="st-caption">Reference facts about the practice, entered once. Key people live on the Contacts tab; the next action is set from the Activity Log.</p>
      <div class="panel">
        <div class="grid c3">
          <div class="field"><label>Practice name *</label><input value="${esc(a.practice_name)}"></div>
          <div class="field"><label>City</label><input value="${esc(a.city)}"></div>
          <div class="field"><label>Kairos owner</label><select>${sel(USERS.filter(u=>u.active).map(u=>u.name), userName(a.kairos_owner_id))}</select></div>
          <div class="field"><label>Practice email</label><input value="${esc(a.practice_email)}"></div>
          <div class="field"><label>State</label><input value="${esc(a.state)}"></div>
          <div class="field"><label>Channel type</label><select>${sel(CHANNEL_TYPES, a.channel_type)}</select></div>
          <div class="field"><label>Practice phone</label><input value="${esc(a.practice_phone)}"></div>
          <div class="field"><label>PMS</label><input value="${esc(a.pms)}"></div>
          <div class="field"><label>Pipeline stage</label><select>${sel(PIPELINE_STAGES, a.pipeline_stage)}</select></div>
          <div class="field"><label>Practice size (operatories)</label><input value="${esc(a.practice_size)}"></div>
          <div class="field"><label>Competitor tool</label><select>${sel(COMPETITOR_TOOLS, a.competitor_tool)}</select></div>
          <div class="field"><label>Lost reason</label><select>
            <option value="" ${a.lost_reason ? "" : "selected"}>—</option>
            ${LOST_REASONS.map((r) => `<option ${r === a.lost_reason ? "selected" : ""}>${esc(r)}</option>`).join("")}
          </select></div>
        </div>
        <div class="field"><label>Notes</label><textarea placeholder="Anything that does not fit a field above">${esc(a.notes)}</textarea></div>
        <button class="btn primary">${icon("save")} Save</button>
      </div>
      <details class="expander"><summary>${icon("delete")} Delete account</summary>
        <div class="expander-body">
          <div class="st-alert warn">Deletes the account and all its contacts, activities, and demos.</div>
          <label class="checkline"><input type="checkbox"> I understand</label>
        </div></details>`;
  }

  if (state.acctTab === "Contacts") {
    const people = CONTACTS.filter((c) => c.account_id === a.id);
    return `
      <div class="panel">
        <div class="st-md"><p><strong>Key people</strong></p></div>
        <div class="grid c3">
          <div class="field"><label>Best contact</label><input value="${esc(a.best_contact)}"></div>
          <div class="field"><label>Best contact email</label><input value="${esc(a.best_contact_email)}"></div>
          <div class="field"><label>Best contact phone</label><input value="${esc(a.best_contact_phone)}"></div>
          <div class="field"><label>Decision maker</label><input value="${esc(a.decision_maker)}"></div>
          <div class="field"><label>Decision maker email</label><input value="${esc(a.decision_maker_email)}"></div>
          <div class="field"><label>Decision maker phone</label><input value="${esc(a.decision_maker_phone)}"></div>
        </div>
        <div class="field" style="max-width:33%"><label>Decision maker reached</label>
          <select>${DECISION_MAKER_REACHED.map((d) => `<option ${d === a.decision_maker_reached ? "selected" : ""}>${d}</option>`).join("")}</select></div>
        <button class="btn primary">${icon("save")} Save key people</button>
      </div>
      <div class="panel">
        <div class="st-md"><p><strong>Add contact</strong></p></div>
        <div class="grid c4">
          <div class="field"><label>Name *</label><input></div>
          <div class="field"><label>Role</label><input></div>
          <div class="field"><label>Email</label><input></div>
          <div class="field"><label>Phone</label><input></div>
        </div>
        <button class="btn">${icon("person")} Add</button>
      </div>
      ${people.length ? people.map((c) => `
        <details class="expander"><summary>${esc(c.name)} — ${esc(c.role || "no role")}</summary>
          <div class="expander-body"><div class="grid c4">
            <div class="field"><label>Name *</label><input value="${esc(c.name)}"></div>
            <div class="field"><label>Role</label><input value="${esc(c.role)}"></div>
            <div class="field"><label>Email</label><input value="${esc(c.email)}"></div>
            <div class="field"><label>Phone</label><input value="${esc(c.phone)}"></div>
          </div><button class="btn">Save</button></div>
        </details>`).join("") : `<p class="st-caption">No contacts yet.</p>`}`;
  }

  if (state.acctTab === "Activity Log") {
    const acts = ACTIVITIES.filter((x) => x.account_id === a.id).sort((x, y) => (x.date < y.date ? 1 : -1));
    return `
      <div class="panel" data-tour="acct-log">
        <div class="st-md"><p><strong>Log activity</strong></p></div>
        <div class="grid c3">
          <div class="field"><label>Date</label><input value="${centralToday().replace(/-/g, "/")}"></div>
          <div class="field"><label>Kairos owner</label>
            <select>${USERS.filter(u=>u.active).map((u) => `<option ${u.id === state.user.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></div>
          <div></div>
        </div>
        <div class="grid c2">
          <div class="field"><label>Type</label><select>${ACTIVITY_TYPES.map((t) => `<option>${esc(t)}</option>`).join("")}</select></div>
          <div class="field"><label>Add new type (overrides selection)</label><input></div>
        </div>
        <div class="field"><label>Summary</label><textarea id="actSummary" placeholder="What happened?"></textarea></div>
        <div class="grid c2">
          <div class="field"><label>Next action</label><input id="actNext"></div>
          <div class="field"><label>Next action due date</label><input id="actDue" placeholder="YYYY/MM/DD"></div>
        </div>
        <p class="st-caption">Setting a next action here updates the account's current next action.</p>
        <button class="btn primary" data-act="log-activity">${icon("task")} Log</button>
      </div>
      <div>${acts.map((x) => `
        <div class="panel" style="padding:14px 16px">
          <div class="st-md"><p style="margin:0"><strong>${x.date}</strong> — ${esc(x.activity_type)} — ${esc(userName(x.owner))}
          ${x.system ? ` <span class="badge" style="background:#f1f5f9;color:#475569">system</span>` : ""}</p>
          ${x.summary ? `<p class="st-caption" style="margin:4px 0 0">${esc(x.summary)}</p>` : ""}</div>
        </div>`).join("") || `<p class="st-caption">No activity logged yet.</p>`}</div>`;
  }

  const demos = DEMOS.filter((d) => d.account_id === a.id).sort((x, y) => (x.date < y.date ? 1 : -1));
  return `
    <div class="panel">
      <div class="st-md"><p><strong>Schedule a demo</strong></p></div>
      <div class="grid c3">
        <div class="field"><label>Date</label><input value="${centralToday().replace(/-/g, "/")}"></div>
        <div class="field"><label>Status</label><select>${DEMO_STATUSES.map((s) => `<option>${s}</option>`).join("")}</select></div>
        <div class="field"><label>Kairos owner</label><select>${USERS.filter(u=>u.active).map((u) => `<option>${esc(u.name)}</option>`).join("")}</select></div>
      </div>
      <div class="field"><label>Attendees</label><input></div>
      <div class="field"><label>Notes</label><textarea></textarea></div>
      <button class="btn">${icon("calendar")} Add demo</button>
    </div>
    ${demos.map((d) => `
      <details class="expander"><summary>${d.date} — ${esc(d.status)} — ${esc(userName(d.owner))}</summary>
        <div class="expander-body">
          <div class="grid c2">
            <div class="field"><label>Attendees</label><input value="${esc(d.attendees)}"></div>
            <div class="field"><label>Status</label><select>${DEMO_STATUSES.map((s) => `<option ${s === d.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>
          </div>
          <div class="field"><label>Notes</label><textarea>${esc(d.notes)}</textarea></div>
          <button class="btn">Save</button>
        </div></details>`).join("") || `<p class="st-caption">No demos yet.</p>`}`;
}

function pageDonut() {
  const tabBar = `<div class="tabs" data-tour="donut-tabs">
    <button data-donuttab="scrape" class="${state.donutTab === "scrape" ? "active" : ""}">${icon("map", 16)} New Scrape</button>
    <button data-donuttab="runs" class="${state.donutTab === "runs" ? "active" : ""}">${icon("list", 16)} Scrape Runs</button>
  </div>`;

  if (state.donutTab === "scrape") {
    return `${title("Donut Scraper")}${tabBar}
      <div class="st-md" data-tour="donut-draw"><p><strong>Draw your target area</strong> — polygon only, one shape at a time</p></div>
      <div id="map"></div>
      <p class="st-caption" id="drawHint" style="margin-top:8px">Pick the polygon tool at the top left, click to drop vertices, then double-click to close the shape.</p>
      <div class="field" style="margin-top:16px"><input placeholder="Jump to a city or ZIP — e.g. Plano, TX or 75024"></div>
      ${state.scrapeError ? `<div class="st-alert warn">${esc(state.scrapeError)}</div>` : ""}
      <div class="panel" data-tour="donut-params">
        <div class="grid c2">
          <div class="field" style="margin:0"><label style="text-transform:uppercase;font-size:11px;letter-spacing:.6px;font-weight:700;color:#64748b">Area label (optional)</label>
            <input id="areaLabel" placeholder="e.g. Prosper test zone"></div>
          <div class="field" style="margin:0"><label style="text-transform:uppercase;font-size:11px;letter-spacing:.6px;font-weight:700;color:#64748b">Buffer distance (miles)</label>
            <input value="0.5"><p class="st-caption" style="margin-top:6px">0.5 mi buffer around polygon</p></div>
        </div>
        <div class="grid c2" style="margin-top:16px">
          <button class="btn primary" data-act="run-scrape">${icon("map", 16)} Run scrape</button>
          <button class="btn">${icon("refresh")} Reset</button>
        </div>
      </div>
      <p class="st-caption">Searches Google Places inside the polygon, enriches each clinic with Gemini, de-duplicates against the CRM, and writes the survivors into a scrape run.</p>`;
  }

  const runs = SCRAPE_RUNS.map((r) => `
    <div class="run-card">
      <div class="run-head ${r.saved ? "saved" : "unsaved"}">
        <div><div class="run-title">${esc(r.run_name)}</div><div class="run-sub">${esc(r.location)}</div></div>
        <div><strong>${r.total}</strong> total clinics<div class="run-sub">${r.fresh} new · ${r.reused} reused</div>
          <div style="color:#16a34a;font-weight:600">${r.promoted} promoted to CRM</div></div>
        <div class="run-sub">Created by: <strong style="color:var(--text)">${esc(r.created_by)}</strong><br>Date: ${esc(r.when)}</div>
      </div>
      <div class="run-actions">
        <button class="btn primary" data-run="${r.id}">Open</button>
        <button class="btn">Confirm</button>
        <button class="btn" data-runmap="${r.id}">Map</button>
        <button class="btn">Archive</button>
      </div>
    </div>`).join("");

  return `${title("Donut Scraper")}${tabBar}
    <div class="page-head"><h2 class="st-subheader" style="flex:1">All Scrape Runs <span class="live">${icon("refresh", 14)} Live sync active (30s)</span></h2>
      <button class="btn" data-act="refresh">${icon("refresh")} Refresh</button></div>
    ${state.flash ? `<div class="st-alert success">${state.flash}</div>` : ""}
    <div class="key-line"><strong>KEY:</strong>
      <span><span class="swatch" style="background:#dbeafe;border-color:#60a5fa"></span>Unsaved Scrape</span>
      <span><span class="swatch" style="background:#dcfce7;border-color:#4ade80"></span>Saved to CRM</span>
      <span><span class="swatch" style="background:#e2e8f0;border-color:#94a3b8"></span>Archived</span>
    </div>
    <div data-tour="donut-runs">${runs}</div>`;
}

function pageRunDetail(runId) {
  const r = SCRAPE_RUNS.find((x) => x.id === runId);
  const rows = r.clinics.map((c, i) => `
    <div class="row ${i % 2 === 0 ? "even" : ""}" style="grid-template-columns:3fr 3fr 1.4fr 2fr 1.4fr">
      <div class="name">${esc(c.name)}</div>
      <div>${esc(c.addr)}</div>
      <div>${c.rating} <span style="color:#f59e0b">★</span> <span class="muted">(${c.reviews})</span></div>
      <div>${callBadge(c.status)}</div>
      <div><button class="btn sm full">Promote</button></div>
    </div>`).join("");

  return `
    <button class="btn" data-act="back-donut">${icon("back")} Back to scrape runs</button>
    ${title(r.run_name)}
    <p class="st-caption">${r.total} clinics found · ${r.promoted} promoted to the CRM · created by ${esc(r.created_by)}</p>
    <div class="st-alert info">Call-through checklist. Mark each clinic as you work the list; promoting one creates an account with the Donut Scrape channel already set.</div>
    <div class="row-header" style="grid-template-columns:3fr 3fr 1.4fr 2fr 1.4fr">
      <div>Clinic</div><div>Address</div><div>Rating</div><div>Call status</div><div></div></div>
    ${rows}`;
}

function pageTemplates() {
  const list = state.templateFilter === "All" ? TEMPLATES : TEMPLATES.filter((t) => t.category === state.templateFilter);
  return `
    ${title("Email Templates", { refresh: false })}
    <details class="expander"><summary>${icon("add")} Add template</summary>
      <div class="expander-body">
        <div class="grid c2">
          <div class="field"><label>Name *</label><input></div>
          <div class="field"><label>Category</label><select>${TEMPLATE_CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
        </div>
        <div class="field"><label>Situation (when to use it)</label><input></div>
        <div class="field"><label>Subject</label><input></div>
        <div class="field"><label>Body</label><textarea style="min-height:160px"></textarea></div>
        <button class="btn">${icon("save")} Add</button>
      </div></details>

    <div class="field" data-tour="tpl-filter"><label>Filter by category</label>
      <select id="tplFilter">${["All", ...TEMPLATE_CATEGORIES].map((c) =>
        `<option ${c === state.templateFilter ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
    <p class="st-caption">${list.length} templates</p>

    <div data-tour="tpl-list">${list.map((t, i) => `
      <details class="expander" ${i === 0 ? "open" : ""}><summary>${esc(t.name)} — ${esc(t.category)}</summary>
        <div class="expander-body">
          <div class="grid c2">
            <div class="field"><label>Name *</label><input value="${esc(t.name)}"></div>
            <div class="field"><label>Category</label><select>${TEMPLATE_CATEGORIES.map((c) =>
              `<option ${c === t.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
          </div>
          <div class="field"><label>Situation (when to use it)</label><input value="${esc(t.situation)}"></div>
          <div class="field"><label>Subject</label><input value="${esc(t.subject)}"></div>
          <div class="field"><label>Body</label><textarea style="min-height:180px">${esc(t.body)}</textarea></div>
          <div class="field"><label>Notes</label><input value="${esc(t.notes)}"></div>
          <button class="btn">Save</button>
        </div></details>`).join("")}</div>`;
}

const CSV_HEADERS = ["clinic name", "phone number", "contact email", "city", "state", "best contact found", "notes", "follow-up date"];
const CSV_ROWS = [
  ["Apex Dental Clinic", "(214) 555-0300", "info@apexdental.example", "Dallas", "TX", "Dr. Rivera", "Interested in after-hours coverage", isoOffset(6)],
  ["Apex Dental", "(214) 555-0300", "info@apexdental.example", "Dallas", "TX", "Dr. Rivera", "Duplicate phone and name check", isoOffset(8)],
  ["", "(832) 555-0311", "nameless@dentistry.example", "Houston", "TX", "No Name", "This row has no clinic name", isoOffset(11)],
  ["Starlight Smiles", "(512) 555-0322", "hello@starlightsmiles.example", "Austin", "TX", "Dr. Yoon", "Wants a demo", isoOffset(7)],
];

function pageCsv() {
  const head = `${title("CSV Import", { refresh: false })}
    <p class="st-caption">Imports accounts only. Map each CSV column to a CRM field, preview, review flagged duplicates, then commit.</p>`;

  if (state.csvStep === 0) {
    return `${head}
      <div class="field"><label>Upload CSV</label>
        <div class="dropzone" data-tour="csv-drop">
          <div class="dz-text"><div class="dz-title">Drag and drop file here</div>
            <div class="dz-sub">Limit 200MB per file &bull; CSV</div></div>
          <button class="btn" data-act="csv-demo">Browse files</button>
        </div></div>
      <p class="st-caption">Pick <strong>Browse files</strong> to load a sample file — the demo ships one with a deliberate duplicate in it.</p>`;
  }

  const fieldOpts = ["— skip —", "practice_name", "practice_phone", "practice_email", "city", "state", "best_contact", "notes", "next_action_due_date"];
  const guess = ["practice_name", "practice_phone", "practice_email", "city", "state", "best_contact", "notes", "next_action_due_date"];

  return `${head}
    <div class="st-alert success">leads_sample.csv loaded — 4 rows, 8 columns.</div>

    ${subheader("1. Map columns", 0)}
    <div class="grid c4" style="margin-top:12px" data-tour="csv-map">
      ${CSV_HEADERS.map((h, i) => `<div class="field"><label>${esc(h)}</label>
        <select>${fieldOpts.map((o) => `<option ${o === guess[i] ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></div>`).join("")}
    </div>

    ${subheader("2. Batch defaults", 1)}
    <div class="grid c3" style="margin-top:12px">
      <div class="field"><label>Kairos owner for every row</label>
        <select>${USERS.filter(u=>u.active).map((u) => `<option ${u.id === state.user.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Channel type</label><select>${CHANNEL_TYPES.map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
      <div class="field"><label>Pipeline stage</label><select>${PIPELINE_STAGES.map((s) => `<option>${esc(s)}</option>`).join("")}</select></div>
    </div>

    ${subheader("3. Preview", 2)}
    <table class="df" style="margin-top:12px"><thead><tr>${CSV_HEADERS.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${CSV_ROWS.map((r) => `<tr>${r.map((c) => `<td>${esc(c || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table>

    ${subheader("4. Duplicate review", 3)}
    <div data-tour="csv-dupes" style="margin-top:12px">
      <div class="st-alert warn"><strong>2 rows need a decision.</strong> Duplicate detection warns — it never silently skips or merges. You choose per row.</div>
      <div class="panel">
        <div class="st-md"><p style="margin:0"><strong>Row 2 — "Apex Dental"</strong></p>
        <p class="st-caption" style="margin:4px 0 10px">94% name match with row 1 "Apex Dental Clinic" and an exact phone match.</p></div>
        <div class="grid c3"><button class="btn">Import anyway</button><button class="btn">Skip this row</button><button class="btn">Merge into row 1</button></div>
      </div>
      <div class="panel">
        <div class="st-md"><p style="margin:0"><strong>Row 3 — no practice name</strong></p>
        <p class="st-caption" style="margin:4px 0 10px">practice_name is required and this row is blank.</p></div>
        <div class="grid c3"><button class="btn">Skip this row</button><button class="btn">Enter a name</button><div></div></div>
      </div>
    </div>

    ${subheader("5. Commit", 4)}
    <p class="st-caption" style="margin-top:12px">2 rows ready to import, 2 awaiting a decision.</p>
    <button class="btn primary">${icon("save")} Import 2 accounts</button>`;
}

function pageSettings() {
  return `
    ${title("Settings", { refresh: false })}
    <p class="st-caption">Users and channel types are editable here without a code deploy. Deactivate rather than delete — historical records keep their references.</p>

    <div data-tour="set-users">
      ${subheader("Users", 0)}
      <div class="panel" style="margin-top:12px">
        <div class="grid" style="grid-template-columns:1fr auto;align-items:end">
          <div class="field" style="margin:0"><label>New user name</label><input></div>
          <button class="btn">${icon("person")} Add user</button>
        </div>
      </div>
      <div class="row-header" style="grid-template-columns:3fr 3fr 1.6fr"><div>Name</div><div>Status</div><div></div></div>
      ${USERS.map((u, i) => `<div class="row ${i % 2 === 0 ? "even" : ""}" style="grid-template-columns:3fr 3fr 1.6fr">
        <div>${esc(u.name)}</div><div>${u.active ? "Active" : "Inactive"}</div>
        <div><button class="btn sm full">${u.active ? "Deactivate" : "Reactivate"}</button></div></div>`).join("")}
    </div>

    ${subheader("Channel types", 1)}
    <div class="panel" style="margin-top:12px">
      <div class="grid" style="grid-template-columns:1fr auto;align-items:end">
        <div class="field" style="margin:0"><label>New channel type</label><input></div>
        <button class="btn">${icon("add")} Add channel</button>
      </div>
    </div>
    <div class="row-header" style="grid-template-columns:3fr 3fr 1.6fr"><div>Channel</div><div>Status</div><div></div></div>
    ${CHANNEL_TYPES.map((c, i) => `<div class="row ${i % 2 === 0 ? "even" : ""}" style="grid-template-columns:3fr 3fr 1.6fr">
      <div>${esc(c)}</div><div>Active</div><div><button class="btn sm full">Deactivate</button></div></div>`).join("")}

    ${subheader("Cadences", 2)}
    <div style="margin-top:12px">${CADENCES.map((c) => `
      <details class="expander"><summary>${esc(c.name)}</summary>
        <div class="expander-body"><p class="st-caption">${esc(c.description)}</p>
        <div class="field"><label>Name</label><input value="${esc(c.name)}"></div>
        <button class="btn">Save</button></div></details>`).join("")}</div>`;
}

/* ---------------- render ---------------- */

function render() {
  renderSidebar();
  const p = $("#page");

  if (!state.user) { p.innerHTML = pageLanding(); return; }

  const map = {
    dashboard: pageDashboard, overview: pageOverview, accounts: pageAccounts,
    account: pageAccountDetail, donut: pageDonut, templates: pageTemplates,
    csv: pageCsv, settings: pageSettings,
  };

  if (state.page === "run") p.innerHTML = pageRunDetail(state.runId);
  else p.innerHTML = (map[state.page] || pageDashboard)();

  if (state.page === "donut" && state.donutTab === "scrape") initMap();
  autosize();
  state.flash = null;
  window.scrollTo({ top: 0 });
}

function autosize() {
  $$("textarea").forEach((t) => {
    t.style.height = "auto";
    t.style.height = `${Math.max(t.scrollHeight, 90)}px`;
  });
}

document.addEventListener("input", (e) => {
  if (e.target.tagName === "TEXTAREA") {
    e.target.style.height = "auto";
    e.target.style.height = `${Math.max(e.target.scrollHeight, 90)}px`;
  }
});

function initMap() {
  const node = $("#map");
  if (!node || !window.L) return;
  const m = L.map(node, { scrollWheelZoom: false, doubleClickZoom: false }).setView([32.85, -96.95], 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(m);
  state.mapObj = m;

  // Polygon drawing: click to drop vertices, double-click to close the shape.
  let drawing = false, pts = [], guide = null, shape = null;

  const Draw = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const bar = L.DomUtil.create("div", "leaflet-bar");
      const a = L.DomUtil.create("a", "", bar);
      a.href = "#";
      a.title = "Draw a polygon";
      a.style.cssText = "display:flex;align-items:center;justify-content:center;font-size:15px";
      a.innerHTML = "&#11040;";
      L.DomEvent.on(a, "click", (e) => {
        L.DomEvent.stop(e);
        drawing = !drawing;
        a.style.background = drawing ? "#d9f2ef" : "";
        node.style.cursor = drawing ? "crosshair" : "";
        if (drawing) reset();
      });
      return bar;
    },
  });
  m.addControl(new Draw());

  function reset() {
    pts = [];
    if (guide) { m.removeLayer(guide); guide = null; }
    if (shape) { m.removeLayer(shape); shape = null; }
    state.polygon = null;
  }

  let lastClick = 0;

  function close() {
    if (!drawing || pts.length < 3) return;
    if (guide) { m.removeLayer(guide); guide = null; }
    shape = L.polygon(pts, { color: "#3abdaf", weight: 3, fillOpacity: 0.15, interactive: false }).addTo(m);
    m.fitBounds(shape.getBounds(), { padding: [40, 40] });
    state.polygon = pts.slice();
    state.scrapeError = null;
    drawing = false;
    node.style.cursor = "";
    const hint = $("#drawHint");
    if (hint) hint.textContent = `Polygon closed — ${pts.length} vertices. Press Run scrape to search inside it.`;
  }

  m.on("click", (e) => {
    if (!drawing) return;
    const now = Date.now();
    // a double-click lands twice on the same spot: that closes the shape
    if (pts.length >= 3 && now - lastClick < 400) {
      const prev = m.latLngToContainerPoint(L.latLng(pts[pts.length - 1]));
      if (prev.distanceTo(e.containerPoint) < 12) { lastClick = 0; close(); return; }
    }
    lastClick = now;
    pts.push([e.latlng.lat, e.latlng.lng]);
    if (guide) m.removeLayer(guide);
    guide = L.polyline(pts, { color: "#3abdaf", weight: 3, dashArray: "5,6", interactive: false }).addTo(m);
    const hint = $("#drawHint");
    if (hint) hint.textContent = pts.length < 3
      ? `${pts.length} vertex placed — keep clicking, then double-click to close.`
      : `${pts.length} vertices — double-click to close the shape.`;
  });

  m.on("dblclick", close);
}

/* ---------------- events ---------------- */

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-nav],[data-login],[data-open],[data-act],[data-acttab],[data-donuttab],[data-run],[data-runmap]");
  if (!t) return;

  if (t.dataset.login) {
    state.user = USERS.find((u) => u.id === Number(t.dataset.login));
    state.page = "dashboard";
    render();
    return;
  }
  if (t.dataset.nav) { state.page = t.dataset.nav; render(); return; }
  if (t.dataset.open) {
    state.accountId = Number(t.dataset.open);
    state.backTo = state.page;
    state.page = "account";
    state.acctTab = "Details";
    render();
    return;
  }
  if (t.dataset.acttab) { state.acctTab = t.dataset.acttab; render(); return; }
  if (t.dataset.donuttab) { state.donutTab = t.dataset.donuttab; render(); return; }
  if (t.dataset.run || t.dataset.runmap) {
    state.runId = Number(t.dataset.run || t.dataset.runmap);
    state.page = "run";
    render();
    return;
  }

  switch (t.dataset.act) {
    case "refresh": render(); break;
    case "back": state.page = state.backTo || "accounts"; render(); break;
    case "back-donut": state.page = "donut"; state.donutTab = "runs"; render(); break;
    case "csv-demo": state.csvStep = 1; render(); break;
    case "start-tour": if (window.Tour) window.Tour.start(); break;
    case "run-scrape": {
      if (!state.polygon) {
        state.scrapeError = "Draw a polygon first — pick the polygon tool on the map, click to drop vertices, then double-click to close it.";
        render();
        break;
      }
      const label = ($("#areaLabel") || {}).value?.trim();
      const lat = state.polygon.reduce((t, p) => t + p[0], 0) / state.polygon.length;
      const lng = state.polygon.reduce((t, p) => t + p[1], 0) / state.polygon.length;
      const n = 4 + Math.floor(Math.random() * 4);
      const pool = CLINIC_POOL.slice().sort(() => Math.random() - 0.5).slice(0, n);
      const reused = Math.floor(Math.random() * 3);
      const clinics = pool.map(([name, addr], k) => ({
        name, addr: label ? `${addr}, ${label}` : addr,
        rating: Number((4.1 + Math.random() * 0.8).toFixed(1)),
        reviews: 40 + Math.floor(Math.random() * 300),
        status: CALL_STATUS_SEED[k % CALL_STATUS_SEED.length],
        lat: lat + (Math.random() - 0.5) * 0.08,
        lng: lng + (Math.random() - 0.5) * 0.08,
        phone: "(555) 555-0" + String(100 + k),
      }));
      SCRAPE_RUNS.unshift({
        id: Date.now(),
        run_name: `${label || "Custom area"} — ${centralToday()}`,
        location: label || `${lat.toFixed(3)}, ${lng.toFixed(3)} · ${state.polygon.length} vertices`,
        total: clinics.length + reused, fresh: clinics.length, reused,
        promoted: 0, created_by: state.user.name,
        when: `${centralToday()} at ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} CT`,
        saved: false, center: [lat, lng], clinics,
      });
      state.polygon = null;
      state.scrapeError = null;
      state.flash = `Scrape complete — ${clinics.length + reused} clinics found inside the polygon, ${clinics.length} new after de-duplication. Open the run to work the call list.`;
      state.donutTab = "runs";
      render();
      break;
    }
    case "log-activity": {
      const a = ACCOUNTS.find((x) => x.id === state.accountId);
      const summary = $("#actSummary").value.trim();
      const next = $("#actNext").value.trim();
      ACTIVITIES.push({
        id: Date.now(), account_id: a.id, date: centralToday(),
        activity_type: "Phone call", owner: state.user.id,
        summary: summary || "(no summary)", system: false,
      });
      a.last_action_date = centralToday();
      if (next) {
        a.next_action = next;
        const due = $("#actDue").value.trim().replace(/\//g, "-");
        if (due) a.next_action_due_date = due;
      }
      render();
      break;
    }
  }
});

document.addEventListener("change", (e) => {
  const id = e.target.id;
  if (id === "dashOwner") {
    state.dashOwner = e.target.value === "all" ? "all" : Number(e.target.value);
    render();
  } else if (id === "tplFilter") {
    state.templateFilter = e.target.value;
    render();
  } else if (["fq", "fowner", "fstage", "fchannel", "fcity", "fdue", "fover", "fsort"].includes(id)) {
    const f = state.filters;
    f.q = $("#fq").value; f.owner = $("#fowner").value; f.stage = $("#fstage").value;
    f.channel = $("#fchannel").value; f.city = $("#fcity").value;
    f.dueToday = $("#fdue").checked; f.overdue = $("#fover").checked; f.sort = $("#fsort").value;
    render();
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "chatform") return;
  e.preventDefault();
  const input = $("#chatinput");
  const text = input.value.trim();
  if (!text) return;
  const thread = state.chat[state.chatThread];
  thread.push({ who: "user", text, ago: 0 });
  thread.push({ who: "bot", text: botReply(text), ago: 0 });
  render();
});

function botReply(text) {
  const q = text.toLowerCase();
  const b = categorize(ACCOUNTS.filter((a) => a.kairos_owner_id === state.user.id));
  if (q.includes("overdue")) {
    if (!b.overdue.length) return "Nothing overdue for you right now.";
    const top = b.overdue[0];
    return `You have ${b.overdue.length} overdue follow-ups. The oldest is ${top.account.practice_name} — ${top.account.next_action || "no next action"}, ${top.days_overdue} days past due.`;
  }
  if (q.includes("today") || q.includes("due")) {
    return b.due_today.length
      ? `${b.due_today.length} due today: ${b.due_today.map((r) => r.account.practice_name).join(", ")}.`
      : "Nothing due today for you.";
  }
  if (q.includes("stale")) return `${b.stale.length} of your leads are stale — no activity in ${STALE_DAYS}+ days or no next action set.`;
  if (q.includes("demo")) {
    const d = DEMOS.filter((x) => x.status === "Scheduled");
    return `${d.length} demos are on the calendar. The next is ${d[0].date}.`;
  }
  const hit = ACCOUNTS.find((a) => q.includes(a.practice_name.toLowerCase().split(" ")[0]));
  if (hit) return `${hit.practice_name} — ${hit.pipeline_stage}, owned by ${userName(hit.kairos_owner_id)}. Next action: ${hit.next_action || "none set"}${hit.next_action_due_date ? ` (due ${hit.next_action_due_date})` : ""}.`;
  return "In the real app this runs against Gemini with the CRM schema in context, so it can log activities and update accounts by text message. In this demo, try asking about overdue follow-ups, what's due today, stale leads, or a practice by name.";
}

render();
