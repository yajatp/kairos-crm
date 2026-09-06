/* ------------------------------------------------------------------
   Guided tour. Each step can move the app to a page/tab before it
   points at something, so the tour drives the product rather than
   just narrating a static screen.
   ------------------------------------------------------------------ */

(function () {
  const STEPS = [
    {
      before: () => { state.user = USERS[0]; state.page = "dashboard"; state.dashOwner = null; },
      sel: '[data-tour="nav"]', place: "right",
      title: "One CRM, seven screens",
      body: "Kairos CRM is the system of record for a dental-software sales team. Everything lives behind this nav: the daily worklist, team-wide reporting, the account book, a lead scraper, templates, bulk import, and admin.",
    },
    {
      sel: '[data-tour="dash-summary"]', place: "bottom",
      title: "The dashboard answers one question",
      body: "<strong>What do I need to do today?</strong> Every account is bucketed into due today, overdue, stale, or upcoming — computed live in America/Chicago, because a follow-up that is “due today” has to mean the rep's today.",
    },
    {
      sel: '[data-tour="dash-owner"]', place: "bottom",
      title: "Scoped to you by default",
      body: "There is no login and no permissions model — deliberately. You pick a name on the way in, and it pre-fills the owner field everywhere without ever locking you out of another rep's records.",
    },
    {
      sel: '[data-tour="dash-overdue"]', place: "top",
      title: "Overdue, worst first",
      body: "Sorted by how badly it has slipped, with the age of the miss spelled out. The stage pill is colour-coded so you can read the state of the pipeline without reading any words.",
    },
    {
      sel: '[data-tour="dash-stale"]', place: "top",
      title: "Stale is inferred, not entered",
      body: "Nobody marks a lead stale. The app derives it: no activity in 14 days, or no next action set at all, or seven days of silence while sitting in <em>Interested</em> or <em>Waiting on Decision</em>. The reason is printed under each row.",
    },
    {
      before: () => { state.page = "overview"; },
      sel: '[data-tour="ov-kpis"]', place: "bottom",
      title: "Team Overview: the manager's view",
      body: "The same underlying data, aggregated across every rep instead of filtered to one. Six numbers that answer whether the week is on track.",
    },
    {
      sel: '[data-tour="ov-team"]', place: "top",
      title: "Load balancing",
      body: "Open leads per rep, share of the open pipeline, and how much each person is behind on. This is the table that decides who gets the next batch of scraped leads.",
    },
    {
      before: () => { state.page = "accounts"; },
      sel: '[data-tour="acct-filters"]', place: "bottom",
      title: "The account book",
      body: "Free-text search plus owner, stage, channel, and city filters, with due-today and overdue toggles layered on top. Filters compose — this is how a rep builds a call list for an afternoon.",
    },
    {
      before: () => { state.accountId = 1; state.backTo = "accounts"; state.page = "account"; state.acctTab = "Details"; },
      sel: '[data-tour="acct-cadence"]', place: "bottom",
      title: "Cadences, or a one-off",
      body: "Enroll an account in a multi-touch sequence and the next step schedules itself as each one completes. Or skip the ceremony and schedule a single follow-up N days out.",
    },
    {
      before: () => { state.acctTab = "Activity Log"; },
      sel: '[data-tour="acct-log"]', place: "top",
      title: "Activity drives everything else",
      body: "This is the only place state changes. Logging an activity sets the account's next action through a Postgres trigger, so the row and its parent can never disagree. <strong>Try it</strong> — type a summary and a next action, then press Log.",
    },
    {
      before: () => { state.page = "donut"; state.donutTab = "scrape"; },
      sel: '[data-tour="donut-draw"]', place: "bottom",
      title: "Donut Scraper: finding the leads",
      body: "Draw a polygon over a neighbourhood. The app searches Google Places inside it, enriches every clinic through Gemini, de-duplicates against the existing CRM with fuzzy name matching, and hands back only what is new.",
    },
    {
      before: () => { state.donutTab = "runs"; },
      sel: '[data-tour="donut-runs"]', place: "top",
      title: "Runs become call lists",
      body: "Each scrape is saved as a run you can work through: mark call outcomes clinic by clinic, then promote the good ones into real CRM accounts. The map view plots the survivors so a rep can drive a route.",
    },
    {
      before: () => { state.page = "csv"; state.csvStep = 1; },
      sel: '[data-tour="csv-dupes"]', place: "top",
      title: "Duplicates warn — they never decide",
      body: "Bulk import runs fuzzy matching on names and exact matching on phones, then <strong>stops and asks</strong>. Silently skipping or auto-merging a row is how a CRM quietly loses a deal, so the app refuses to do either.",
    },
    {
      before: () => { state.page = "dashboard"; },
      sel: '[data-tour="bot"]', place: "right",
      title: "And it works over text message",
      body: "The same CRM is reachable by SMS through a SendBlue number and a Supabase edge function. Reps text it from a parking lot — “log a call for Cedar Ridge, left a voicemail” — and it writes the activity and sets the next action. <strong>Try the box below.</strong>",
    },
    {
      sel: null,
      title: "That's the tour",
      body: "Everything here is fictional data running client-side. The real build is Streamlit and Supabase, and the full source — schema, triggers, scraper pipeline, and edge function — is in the repository this demo ships from.",
      final: true,
    },
  ];

  let i = 0, active = false;
  let spot, pop;

  function ensureNodes() {
    if (spot) return;
    spot = document.createElement("div"); spot.id = "tour-spot";
    pop = document.createElement("div"); pop.id = "tour-pop";
    document.body.append(spot, pop);
  }

  function rectOf(sel) {
    if (!sel) return null;
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: r.top + window.scrollY, left: r.left + window.scrollX,
      width: r.width, height: r.height, viewTop: r.top, viewHeight: r.height,
    };
  }

  function place(step) {
    const pad = 6;
    const r = rectOf(step.sel);

    if (!r) {
      spot.style.cssText = "position:absolute;z-index:9998;border-radius:10px;box-shadow:0 0 0 9999px rgba(15,23,42,.58);pointer-events:none;";
      spot.style.top = `${window.scrollY + window.innerHeight / 2}px`;
      spot.style.left = `${window.innerWidth / 2}px`;
      spot.style.width = "0px"; spot.style.height = "0px";
      pop.style.top = `${window.scrollY + window.innerHeight / 2 - pop.offsetHeight / 2}px`;
      pop.style.left = `${window.innerWidth / 2 - pop.offsetWidth / 2}px`;
      return;
    }

    spot.style.top = `${r.top - pad}px`;
    spot.style.left = `${r.left - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;

    const pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 18;
    let top, left, placement = step.place || "bottom";

    // flip if there is not enough room in the viewport
    if (placement === "bottom" && r.viewTop + r.viewHeight + gap + ph > window.innerHeight) placement = "top";
    if (placement === "top" && r.viewTop - gap - ph < 0) placement = "bottom";

    if (placement === "right") {
      left = r.left + r.width + gap;
      top = r.top + r.height / 2 - ph / 2;
    } else if (placement === "left") {
      left = r.left - pw - gap;
      top = r.top + r.height / 2 - ph / 2;
    } else if (placement === "top") {
      left = r.left + r.width / 2 - pw / 2;
      top = r.top - ph - gap;
    } else {
      left = r.left + r.width / 2 - pw / 2;
      top = r.top + r.height + gap;
    }

    left = Math.max(16, Math.min(left, window.innerWidth - pw - 16));
    top = Math.max(window.scrollY + 16, top);
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  function scrollTo(step) {
    const r = rectOf(step.sel);
    if (!r) return;
    const target = r.top - Math.max(120, (window.innerHeight - r.height) / 2);
    window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  function draw() {
    const step = STEPS[i];
    if (step.before) step.before();
    render();

    ensureNodes();
    pop.innerHTML = `
      <div class="step">Step ${i + 1} of ${STEPS.length}</div>
      <h3>${step.title}</h3>
      <p>${step.body}</p>
      <div class="tour-foot">
        <div class="dots">${STEPS.map((_, n) => `<i class="${n <= i ? "on" : ""}"></i>`).join("")}</div>
        <button class="ghost" data-tour-act="end">${step.final ? "Close" : "Skip"}</button>
        ${i > 0 ? `<button data-tour-act="prev">Back</button>` : ""}
        ${step.final ? `<button class="primary" data-tour-act="end">Explore on my own</button>`
                     : `<button class="primary" data-tour-act="next">Next</button>`}
      </div>`;

    scrollTo(step);
    // let the smooth scroll and any layout settle before measuring
    requestAnimationFrame(() => place(step));
    setTimeout(() => place(step), 340);
  }

  function start(from = 0) {
    active = true; i = from;
    document.body.classList.add("tour-open");
    ensureNodes();
    spot.style.display = pop.style.display = "";
    draw();
  }

  function end() {
    active = false;
    document.body.classList.remove("tour-open");
    if (spot) spot.style.display = pop.style.display = "none";
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tour-act]");
    if (!b) return;
    const act = b.dataset.tourAct;
    if (act === "end") end();
    else if (act === "next") { if (i < STEPS.length - 1) { i++; draw(); } else end(); }
    else if (act === "prev") { if (i > 0) { i--; draw(); } }
  });

  document.addEventListener("keydown", (e) => {
    if (!active) return;
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight") { if (i < STEPS.length - 1) { i++; draw(); } }
    else if (e.key === "ArrowLeft") { if (i > 0) { i--; draw(); } }
  });

  window.addEventListener("resize", () => { if (active) place(STEPS[i]); });
  window.addEventListener("scroll", () => { if (active) place(STEPS[i]); }, { passive: true });

  window.Tour = { start, end };

  // First-time visitors get the tour automatically; afterwards it is on
  // the sidebar button, which never sits on top of the page content.
  if (!localStorage.getItem("kairos-tour-seen")) {
    try { localStorage.setItem("kairos-tour-seen", "1"); } catch (_) {}
    setTimeout(() => start(), 700);
  }
})();
