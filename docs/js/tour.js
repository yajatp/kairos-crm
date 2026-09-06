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

  /* Position the popover in VIEWPORT coordinates, then convert to document
     coordinates. Working in viewport space is what makes clamping correct:
     the popover must always sit fully inside the visible window, whatever
     the target's size or the window's. */
  function place(step) {
    const pad = 6, gap = 18, edge = 16;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const r = rectOf(step.sel);

    if (!r) {
      spot.style.top = `${window.scrollY + vh / 2}px`;
      spot.style.left = `${vw / 2}px`;
      spot.style.width = "0px";
      spot.style.height = "0px";
      pop.style.top = `${window.scrollY + Math.max(edge, (vh - ph) / 2)}px`;
      pop.style.left = `${Math.max(edge, (vw - pw) / 2)}px`;
      return;
    }

    // A section taller than the window gets its top highlighted rather than
    // the whole thing, so there is always somewhere for the popover to go.
    const effH = Math.min(r.viewHeight, Math.round(vh * 0.55));

    spot.style.top = `${r.top - pad}px`;
    spot.style.left = `${r.left - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${effH + pad * 2}px`;

    const vt = r.viewTop;
    const vb = vt + effH;
    const vl = r.left - window.scrollX;
    const vr = vl + r.width;

    const room = { bottom: vh - vb - gap, top: vt - gap, right: vw - vr - gap, left: vl - gap };
    const fits = (pl) => (pl === "bottom" || pl === "top") ? room[pl] >= ph : room[pl] >= pw;

    let placement = step.place || "bottom";
    if (!fits(placement)) placement = ["bottom", "top", "right", "left"].find(fits) || placement;

    let top, left;
    if (placement === "right") {
      left = vr + gap; top = vt + effH / 2 - ph / 2;
    } else if (placement === "left") {
      left = vl - pw - gap; top = vt + effH / 2 - ph / 2;
    } else if (placement === "top") {
      left = vl + r.width / 2 - pw / 2; top = vt - ph - gap;
    } else {
      left = vl + r.width / 2 - pw / 2; top = vb + gap;
    }

    left = Math.min(Math.max(left, edge), Math.max(edge, vw - pw - edge));
    top = Math.min(Math.max(top, edge), Math.max(edge, vh - ph - edge));

    pop.style.top = `${top + window.scrollY}px`;
    pop.style.left = `${left + window.scrollX}px`;
  }

  function scrollTo(step) {
    const r = rectOf(step.sel);
    if (!r) return;
    const vh = window.innerHeight;
    // Tall sections scroll to their top; everything else centres.
    const target = r.height > vh * 0.55 ? r.top - 110 : r.top - (vh - r.height) / 2;
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
    // reposition as the smooth scroll runs, and once more after it settles
    requestAnimationFrame(() => place(step));
    setTimeout(() => place(step), 340);
    setTimeout(() => place(step), 700);
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
