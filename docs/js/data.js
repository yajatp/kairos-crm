/* ------------------------------------------------------------------
   Demo seed data. Entirely fictional — no real practice, contact, or
   deal from the production CRM appears here. Dates are generated as
   offsets from today so the dashboard buckets always look live.
   ------------------------------------------------------------------ */

const USERS = [
  { id: 1, name: "Avery", active: true },
  { id: 2, name: "Jordan", active: true },
  { id: 3, name: "Riley", active: true },
  { id: 4, name: "Morgan", active: true },
  { id: 5, name: "Quinn", active: true },
  { id: 6, name: "Elliot", active: true },
  { id: 7, name: "Tester", active: false },
];

const CHANNEL_TYPES = ["Cold Visit", "Cold Call", "Cold Email", "Referral", "Conference", "Inbound"];

const PIPELINE_STAGES = [
  "New Lead", "Not Called", "No Answer", "Left Voicemail", "Call Back Later",
  "Contacted", "Interested", "Demo Scheduled", "Waiting on Decision",
  "Onboarding", "Closed Won", "Closed Lost", "Not Interested", "Dead", "Nurture Later",
];

const CLOSED_STAGES = new Set(["Closed Won", "Closed Lost", "Nurture Later", "Not Interested", "Dead"]);
const CLOSING_STAGES = ["Onboarding", "Waiting on Decision", "Demo Scheduled", "Interested"];

const ACTIVITY_TYPES = [
  "In-person visit", "Phone call", "Email sent", "Demo scheduled", "Demo completed",
  "Follow-up completed", "Pricing/onboarding info sent", "No response", "Other",
];

const LOST_REASONS = [
  "Too expensive", "Not ready for AI", "Dentist/owner not interested",
  "Office manager not interested", "Uses another AI tool",
  "Uses another patient communication tool", "DSO restriction",
  "PMS/integration concern", "Bad timing", "No response", "Other",
];

const COMPETITOR_TOOLS = [
  "Weave", "Adit", "Dentina", "NexHealth", "Mango", "Dental Intelligence",
  "Patient Prism", "None / front desk only", "Unknown",
];

const DEMO_STATUSES = ["Scheduled", "Completed", "No-show", "Rescheduled"];
const DECISION_MAKER_REACHED = ["Unknown", "Yes", "No"];

const TEMPLATE_CATEGORIES = [
  "Follow-up after in-person visit — went well",
  "Follow-up after in-person visit — neutral or poor",
  "Follow-up after in-person visit — interested later",
  "Scheduling a demo after visit",
  "Follow-up after no response",
  "Conference follow-up",
  "Referral follow-up",
  "Post-demo follow-up",
  "Pricing/onboarding follow-up",
  "Rejection / keep-in-touch",
];

const CADENCES = [
  { id: 1, name: "New Lead Outreach", description: "Standard 6-touch sequence over ~2 weeks for brand new leads." },
  { id: 2, name: "Post-Demo Nurture", description: "Four touches over three weeks after a completed demo." },
  { id: 3, name: "Cold Visit Follow-up", description: "Three touches in the ten days after walking into a practice." },
];

const STALE_DAYS = 14;
const WAITING_STALE_DAYS = 7;

/* ---------------- date helpers (America/Chicago, like the real app) --------- */

function centralToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return parts; // YYYY-MM-DD
}

function isoOffset(days) {
  const base = new Date(centralToday() + "T12:00:00Z");
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000);
}

/* ---------------- accounts ---------------- */

/* offsets: due = days from today for next_action_due_date (null = none)
            last = days ago for last_action_date                          */
const RAW_ACCOUNTS = [
  { n: "Cedar Ridge Family Dental", city: "Plano", st: "TX", owner: 1, stage: "Waiting on Decision", ch: "Cold Visit",
    na: "Call Dr. Alvarez about the pricing sheet", due: -6, last: 11,
    email: "front@cedarridgedental.example", phone: "(214) 555-0142",
    best: "Marisol Rey", bestRole: "Office Manager", dm: "Dr. Elena Alvarez", dmReached: "Yes",
    pms: "Dentrix", tool: "None / front desk only", size: 4 },

  { n: "Bluebonnet Dental Studio", city: "Frisco", st: "TX", owner: 1, stage: "Demo Scheduled", ch: "Referral",
    na: "Send calendar invite for Thursday demo", due: 2, last: 3,
    email: "hello@bluebonnetdental.example", phone: "(972) 555-0118",
    best: "Priya Raman", bestRole: "Practice Coordinator", dm: "Dr. Grant Whitfield", dmReached: "Yes",
    pms: "Open Dental", tool: "Weave", size: 6 },

  { n: "Northgate Smiles", city: "McKinney", st: "TX", owner: 2, stage: "Contacted", ch: "Cold Call",
    na: "Phone call", due: -12, last: 19,
    email: "office@northgatesmiles.example", phone: "(469) 555-0173",
    best: "Dana Ortiz", bestRole: "Front Desk", dm: "", dmReached: "No",
    pms: "Eaglesoft", tool: "Unknown", size: 3 },

  { n: "Harbor Point Dental Group", city: "Houston", st: "TX", owner: 3, stage: "Interested", ch: "Conference",
    na: "Send the ROI one-pager", due: 0, last: 5,
    email: "admin@harborpointdental.example", phone: "(713) 555-0155",
    best: "Kevin Massey", bestRole: "Regional Manager", dm: "Dr. Ifeoma Nwosu", dmReached: "Yes",
    pms: "Curve Dental", tool: "NexHealth", size: 11 },

  { n: "Willow Creek Orthodontics", city: "Austin", st: "TX", owner: 3, stage: "Onboarding", ch: "Inbound",
    na: "Kickoff call with the front desk team", due: 1, last: 2,
    email: "team@willowcreekortho.example", phone: "(512) 555-0190",
    best: "Sam Delgado", bestRole: "Office Manager", dm: "Dr. Hannah Boyd", dmReached: "Yes",
    pms: "Open Dental", tool: "Mango", size: 8 },

  { n: "Lone Star Pediatric Dentistry", city: "San Antonio", st: "TX", owner: 4, stage: "Contacted", ch: "Cold Visit",
    na: "Drop by with sample call transcripts", due: -3, last: 9,
    email: "info@lonestarpedo.example", phone: "(210) 555-0126",
    best: "Rosa Aguilar", bestRole: "Front Desk", dm: "", dmReached: "Unknown",
    pms: "Dentrix", tool: "Unknown", size: 5 },

  { n: "Magnolia Park Dental", city: "Houston", st: "TX", owner: 2, stage: "New Lead", ch: "Cold Email",
    na: "", due: null, last: 21,
    email: "contact@magnoliaparkdental.example", phone: "(281) 555-0134",
    best: "", bestRole: "", dm: "", dmReached: "Unknown",
    pms: "", tool: "Unknown", size: 2 },

  { n: "Trinity Heights Dental", city: "Fort Worth", st: "TX", owner: 1, stage: "Left Voicemail", ch: "Cold Call",
    na: "Try again mid-morning", due: -1, last: 4,
    email: "reception@trinityheights.example", phone: "(817) 555-0161",
    best: "Alex Kimura", bestRole: "Front Desk", dm: "", dmReached: "No",
    pms: "Eaglesoft", tool: "Unknown", size: 4 },

  { n: "Silver Lake Dental Arts", city: "Dallas", st: "TX", owner: 5, stage: "Interested", ch: "Referral",
    na: "Confirm which PMS they run", due: 3, last: 8,
    email: "hello@silverlakedentalarts.example", phone: "(214) 555-0107",
    best: "Bea Chandler", bestRole: "Office Manager", dm: "Dr. Nikhil Rao", dmReached: "Yes",
    pms: "Curve Dental", tool: "Adit", size: 7 },

  { n: "Prairie View Dental", city: "Denton", st: "TX", owner: 4, stage: "Demo Scheduled", ch: "Cold Visit",
    na: "Demo prep — pull their call volume numbers", due: 4, last: 1,
    email: "office@prairieviewdental.example", phone: "(940) 555-0148",
    best: "Tomas Lira", bestRole: "Practice Coordinator", dm: "Dr. Susan Feld", dmReached: "Yes",
    pms: "Open Dental", tool: "None / front desk only", size: 5 },

  { n: "Rosewood Smile Center", city: "Arlington", st: "TX", owner: 6, stage: "No Answer", ch: "Cold Call",
    na: "Phone call", due: -8, last: 16,
    email: "info@rosewoodsmile.example", phone: "(682) 555-0139",
    best: "", bestRole: "", dm: "", dmReached: "Unknown",
    pms: "", tool: "Unknown", size: 3 },

  { n: "Alamo Modern Dentistry", city: "San Antonio", st: "TX", owner: 6, stage: "Call Back Later", ch: "Cold Call",
    na: "Call back after the holiday rush", due: 6, last: 6,
    email: "desk@alamomodern.example", phone: "(210) 555-0182",
    best: "Ingrid Sorensen", bestRole: "Front Desk", dm: "", dmReached: "No",
    pms: "Dentrix", tool: "Weave", size: 4 },

  { n: "Gulf Coast Dental Partners", city: "Corpus Christi", st: "TX", owner: 3, stage: "Waiting on Decision", ch: "Conference",
    na: "Check in on the partner vote", due: -2, last: 10,
    email: "partners@gulfcoastdental.example", phone: "(361) 555-0193",
    best: "Devon Pratt", bestRole: "Operations Lead", dm: "Dr. Ana Mireles", dmReached: "Yes",
    pms: "Eaglesoft", tool: "Dental Intelligence", size: 14 },

  { n: "Highland Village Dental", city: "Highland Village", st: "TX", owner: 5, stage: "Contacted", ch: "Cold Visit",
    na: "Email the case study", due: -4, last: 13,
    email: "hi@hvdental.example", phone: "(972) 555-0166",
    best: "Carla Nunez", bestRole: "Office Manager", dm: "", dmReached: "Unknown",
    pms: "Open Dental", tool: "Unknown", size: 6 },

  { n: "Sunset Terrace Dental", city: "El Paso", st: "TX", owner: 2, stage: "Closed Won", ch: "Referral",
    na: "", due: null, last: 7,
    email: "office@sunsetterrace.example", phone: "(915) 555-0121",
    best: "Luis Marchetti", bestRole: "Office Manager", dm: "Dr. Paul Whitaker", dmReached: "Yes",
    pms: "Open Dental", tool: "None / front desk only", size: 9 },

  { n: "Copper Canyon Dental", city: "Lubbock", st: "TX", owner: 4, stage: "Closed Lost", ch: "Cold Call",
    na: "", due: null, last: 24, lost: "Uses another AI tool",
    email: "front@coppercanyondental.example", phone: "(806) 555-0179",
    best: "Nadia Rowe", bestRole: "Front Desk", dm: "Dr. Omar Haddad", dmReached: "Yes",
    pms: "Dentrix", tool: "Weave", size: 4 },

  { n: "Riverbend Dental Care", city: "Waco", st: "TX", owner: 1, stage: "Contacted", ch: "Cold Email",
    na: "Phone call", due: -9, last: 17,
    email: "care@riverbenddental.example", phone: "(254) 555-0104",
    best: "Gemma Sato", bestRole: "Front Desk", dm: "", dmReached: "Unknown",
    pms: "Curve Dental", tool: "Unknown", size: 3 },

  { n: "Pecan Grove Dentistry", city: "Sugar Land", st: "TX", owner: 5, stage: "Nurture Later", ch: "Cold Visit",
    na: "", due: null, last: 30,
    email: "office@pecangrovedentistry.example", phone: "(281) 555-0158",
    best: "Ruth Okafor", bestRole: "Office Manager", dm: "", dmReached: "No",
    pms: "Eaglesoft", tool: "Mango", size: 5 },

  { n: "Stonebriar Dental Excellence", city: "Frisco", st: "TX", owner: 6, stage: "Interested", ch: "Inbound",
    na: "Schedule the demo", due: 5, last: 4,
    email: "hello@stonebriardental.example", phone: "(469) 555-0187",
    best: "Peter Vance", bestRole: "Practice Coordinator", dm: "Dr. Leila Ghorbani", dmReached: "Yes",
    pms: "Open Dental", tool: "Unknown", size: 8 },

  { n: "Live Oak Dental Collective", city: "Round Rock", st: "TX", owner: 3, stage: "Not Called", ch: "Cold Email",
    na: "", due: null, last: 26,
    email: "team@liveoakdental.example", phone: "(512) 555-0113",
    best: "", bestRole: "", dm: "", dmReached: "Unknown",
    pms: "", tool: "Unknown", size: 4 },

  { n: "Mesquite Family Dentistry", city: "Mesquite", st: "TX", owner: 2, stage: "Demo Scheduled", ch: "Cold Visit",
    na: "Send pre-demo questionnaire", due: 0, last: 2,
    email: "info@mesquitefamilydental.example", phone: "(972) 555-0129",
    best: "Yara Beltran", bestRole: "Office Manager", dm: "Dr. Curtis Nance", dmReached: "Yes",
    pms: "Dentrix", tool: "None / front desk only", size: 6 },

  { n: "Katy Prairie Dental", city: "Katy", st: "TX", owner: 5, stage: "Contacted", ch: "Cold Call",
    na: "Ask for the office manager by name", due: -15, last: 22,
    email: "desk@katyprairiedental.example", phone: "(346) 555-0164",
    best: "", bestRole: "", dm: "", dmReached: "Unknown",
    pms: "", tool: "Unknown", size: 3 },
];

const ACCOUNTS = RAW_ACCOUNTS.map((r, i) => ({
  id: i + 1,
  practice_name: r.n,
  city: r.city,
  state: r.st,
  kairos_owner_id: r.owner,
  pipeline_stage: r.stage,
  channel_type: r.ch,
  next_action: r.na || "",
  next_action_due_date: r.due === null ? null : isoOffset(r.due),
  last_action_date: isoOffset(-r.last),
  practice_email: r.email,
  practice_phone: r.phone,
  best_contact: r.best,
  best_contact_email: r.best ? r.best.toLowerCase().replace(/[^a-z]/g, ".") + "@" + r.email.split("@")[1] : "",
  best_contact_phone: r.best ? r.phone : "",
  decision_maker: r.dm,
  decision_maker_email: "",
  decision_maker_phone: "",
  decision_maker_reached: r.dmReached,
  pms: r.pms,
  competitor_tool: r.tool,
  practice_size: r.size,
  lost_reason: r.lost || "",
  cadence_id: null,
  notes: "",
}));

/* ---------------- contacts ---------------- */

const CONTACTS = [
  { id: 1, account_id: 1, name: "Marisol Rey", role: "Office Manager", email: "marisol@cedarridgedental.example", phone: "(214) 555-0142" },
  { id: 2, account_id: 1, name: "Dr. Elena Alvarez", role: "Owner / DDS", email: "e.alvarez@cedarridgedental.example", phone: "(214) 555-0143" },
  { id: 3, account_id: 1, name: "Trent Hollis", role: "Billing", email: "billing@cedarridgedental.example", phone: "" },
  { id: 4, account_id: 2, name: "Priya Raman", role: "Practice Coordinator", email: "priya@bluebonnetdental.example", phone: "(972) 555-0118" },
  { id: 5, account_id: 2, name: "Dr. Grant Whitfield", role: "Owner / DDS", email: "", phone: "" },
  { id: 6, account_id: 4, name: "Kevin Massey", role: "Regional Manager", email: "k.massey@harborpointdental.example", phone: "(713) 555-0155" },
  { id: 7, account_id: 5, name: "Sam Delgado", role: "Office Manager", email: "sam@willowcreekortho.example", phone: "(512) 555-0190" },
];

/* ---------------- activities ---------------- */

const ACTIVITIES = [
  { id: 1, account_id: 1, date: isoOffset(-11), activity_type: "Phone call", owner: 1,
    summary: "Spoke with Marisol. Dr. Alvarez wants the pricing sheet before the partner meeting.", system: false },
  { id: 2, account_id: 1, date: isoOffset(-18), activity_type: "Pricing/onboarding info sent", owner: 1,
    summary: "Emailed the two-tier pricing sheet and the Open Dental integration note.", system: false },
  { id: 3, account_id: 1, date: isoOffset(-25), activity_type: "Demo completed", owner: 1,
    summary: "45-minute demo. Strong interest in after-hours call capture. Asked about HIPAA/BAA.", system: false },
  { id: 4, account_id: 1, date: isoOffset(-31), activity_type: "In-person visit", owner: 1,
    summary: "Walked in, met Marisol at the front desk. Left a one-pager.", system: false },
  { id: 5, account_id: 1, date: isoOffset(-11), activity_type: "Details updated", owner: 1,
    summary: "pipeline_stage, next_action_due_date", system: true },

  { id: 6, account_id: 2, date: isoOffset(-3), activity_type: "Phone call", owner: 1,
    summary: "Priya confirmed Thursday 2pm for the demo. Dr. Whitfield will join for the first 20 minutes.", system: false },
  { id: 7, account_id: 2, date: isoOffset(-9), activity_type: "Email sent", owner: 1,
    summary: "Referral intro from Sunset Terrace. Sent the scheduling link.", system: false },

  { id: 8, account_id: 4, date: isoOffset(-5), activity_type: "Phone call", owner: 3,
    summary: "Kevin wants the ROI one-pager to take to the group's ops committee.", system: false },
  { id: 9, account_id: 4, date: isoOffset(-14), activity_type: "In-person visit", owner: 3,
    summary: "Met Dr. Nwosu at the TDA conference booth. 11 chairs across two locations.", system: false },

  { id: 10, account_id: 5, date: isoOffset(-2), activity_type: "Demo completed", owner: 3,
    summary: "Signed. Kickoff scheduled — front desk team of four needs training on the handoff flow.", system: false },
  { id: 11, account_id: 3, date: isoOffset(-19), activity_type: "No response", owner: 2,
    summary: "Third call, no answer, no voicemail box set up.", system: false },
  { id: 12, account_id: 13, date: isoOffset(-10), activity_type: "Phone call", owner: 3,
    summary: "Partner vote pushed to next month. Devon will flag when it's on the agenda.", system: false },
  { id: 13, account_id: 15, date: isoOffset(-7), activity_type: "Demo completed", owner: 2,
    summary: "Closed won. Starting on the single-location plan, will revisit the second office in Q3.", system: false },
  { id: 14, account_id: 16, date: isoOffset(-24), activity_type: "Phone call", owner: 4,
    summary: "Already two years into a Weave contract. Not interested until renewal.", system: false },
  { id: 15, account_id: 10, date: isoOffset(-1), activity_type: "Demo scheduled", owner: 4,
    summary: "Dr. Feld booked for next week. Pulling their inbound call volume first.", system: false },
];

/* ---------------- demos ---------------- */

const DEMOS = [
  { id: 1, account_id: 1, date: isoOffset(-25), status: "Completed", owner: 1,
    attendees: "Dr. Elena Alvarez, Marisol Rey", notes: "Asked for a BAA and an Open Dental integration walkthrough." },
  { id: 2, account_id: 2, date: isoOffset(2), status: "Scheduled", owner: 1,
    attendees: "Priya Raman, Dr. Grant Whitfield", notes: "Thursday 2:00 PM CT." },
  { id: 3, account_id: 10, date: isoOffset(4), status: "Scheduled", owner: 4,
    attendees: "Dr. Susan Feld", notes: "" },
  { id: 4, account_id: 21, date: isoOffset(0), status: "Scheduled", owner: 2,
    attendees: "Yara Beltran, Dr. Curtis Nance", notes: "Send the questionnaire first." },
  { id: 5, account_id: 5, date: isoOffset(-2), status: "Completed", owner: 3,
    attendees: "Sam Delgado, Dr. Hannah Boyd", notes: "Moved straight to onboarding." },
  { id: 6, account_id: 15, date: isoOffset(-7), status: "Completed", owner: 2,
    attendees: "Luis Marchetti", notes: "Closed on the call." },
];

/* ---------------- email templates ---------------- */

const TEMPLATES = [
  { id: 1, name: "Warm walk-in follow-up", category: "Follow-up after in-person visit — went well",
    situation: "You met the office manager, they were engaged and asked questions.",
    subject: "Great meeting you at {{practice_name}}",
    body: "Hi {{first_name}},\n\nThanks for taking a few minutes with me today — I know the front desk is the last place with spare time on a Tuesday.\n\nAs promised, here is the one-pager on how we handle after-hours and overflow calls. The short version: every call gets answered, and the ones that need a human land in your inbox with a transcript and a suggested reply.\n\nWould a 20-minute walkthrough later this week be useful? Happy to work around your schedule.\n\nBest,\n{{owner_name}}",
    notes: "Keep it under 150 words. Never attach a PDF on the first send." },
  { id: 2, name: "Neutral visit — light touch", category: "Follow-up after in-person visit — neutral or poor",
    situation: "They took the one-pager but did not engage much.",
    subject: "Quick note from today",
    body: "Hi {{first_name}},\n\nI stopped by earlier and left some information with the front desk — no need to do anything with it today.\n\nIf missed calls are ever a topic at {{practice_name}}, I'd be glad to show you what we do. Otherwise I'll check back in a few months.\n\nBest,\n{{owner_name}}",
    notes: "Deliberately low pressure. The goal is permission to come back." },
  { id: 3, name: "Demo scheduling after a visit", category: "Scheduling a demo after visit",
    situation: "They said yes to a demo but no time was set.",
    subject: "Times for that walkthrough",
    body: "Hi {{first_name}},\n\nHere are a few windows that work on my end this week:\n\n• Tuesday 10:00 AM\n• Wednesday 2:00 PM\n• Thursday 9:30 AM\n\nIt takes about 20 minutes, and I'll use your own call volume as the example. Any of those work, or send me a better time.\n\nBest,\n{{owner_name}}",
    notes: "Always propose three concrete slots — open-ended asks stall." },
  { id: 4, name: "Third touch, no response", category: "Follow-up after no response",
    situation: "Two prior emails, no reply.",
    subject: "Closing the loop",
    body: "Hi {{first_name}},\n\nI've reached out a couple of times and haven't heard back, which usually means the timing is wrong — completely understandable.\n\nI'll stop here. If it becomes relevant later, just reply to this email and I'll pick it back up.\n\nBest,\n{{owner_name}}",
    notes: "The break-up email. Historically our highest reply rate." },
  { id: 5, name: "Post-demo recap", category: "Post-demo follow-up",
    situation: "Send within two hours of a completed demo.",
    subject: "Recap + next steps for {{practice_name}}",
    body: "Hi {{first_name}},\n\nThanks for the time today. Recapping what we covered:\n\n1. After-hours calls route to us instead of voicemail\n2. Every call comes back as a transcript with a suggested follow-up\n3. Setup is about a week, and we handle the {{pms}} side\n\nYou mentioned wanting to check with {{decision_maker}} — happy to join that conversation if it helps.\n\nBest,\n{{owner_name}}",
    notes: "Numbered recaps get forwarded internally more often than prose." },
  { id: 6, name: "Pricing and onboarding", category: "Pricing/onboarding follow-up",
    situation: "They asked what it costs.",
    subject: "Pricing for {{practice_name}}",
    body: "Hi {{first_name}},\n\nFor a practice your size, here's how it works:\n\n• Flat monthly rate, no per-call charges\n• No setup fee\n• Month to month after the first 90 days\n\nI've attached the full sheet. The BAA is standard and our counsel can turn it around same-day.\n\nBest,\n{{owner_name}}",
    notes: "Lead with 'no per-call charges' — it's the first objection every time." },
  { id: 7, name: "Referral introduction", category: "Referral follow-up",
    situation: "An existing customer introduced you.",
    subject: "{{referrer}} suggested I reach out",
    body: "Hi {{first_name}},\n\n{{referrer}} mentioned you might be dealing with the same front-desk call volume they were, and suggested I get in touch.\n\nHappy to show you what we set up for them — it's about 20 minutes and you'll see their actual numbers.\n\nBest,\n{{owner_name}}",
    notes: "Name the referrer in the subject line. Open rates roughly double." },
  { id: 8, name: "Keep in touch after a no", category: "Rejection / keep-in-touch",
    situation: "They declined but were pleasant about it.",
    subject: "Understood — and thank you",
    body: "Hi {{first_name}},\n\nThanks for being straight with me. I'll take {{practice_name}} off the follow-up list.\n\nIf your current setup ever changes, you know where to find me.\n\nBest,\n{{owner_name}}",
    notes: "Set a Nurture Later stage and a 6-month reminder when you send this." },
];

/* ---------------- donut scrape runs ---------------- */

const SCRAPE_RUNS = [
  { id: 1, run_name: "Frisco / Plano corridor — " + isoOffset(-1), location: "Frisco, TX",
    total: 34, fresh: 31, reused: 3, promoted: 12, created_by: "Quinn", when: isoOffset(-1) + " at 4:12 PM CT", saved: true,
    center: [33.1507, -96.8236],
    clinics: [
      { name: "Stonebriar Dental Excellence", addr: "2601 Preston Rd, Frisco, TX", rating: 4.8, reviews: 212, status: "Interested", lat: 33.1002, lng: -96.8067, phone: "(469) 555-0187" },
      { name: "Panther Creek Dental", addr: "9555 Legacy Dr, Frisco, TX", rating: 4.6, reviews: 143, status: "Left Voicemail", lat: 33.1712, lng: -96.8402, phone: "(469) 555-0201" },
      { name: "Eldorado Family Dentistry", addr: "3130 Eldorado Pkwy, Frisco, TX", rating: 4.9, reviews: 318, status: "Not Called", lat: 33.1461, lng: -96.8571, phone: "(972) 555-0225" },
      { name: "Legacy West Smile Co.", addr: "7501 Windrose Ave, Plano, TX", rating: 4.4, reviews: 96, status: "No Answer", lat: 33.0764, lng: -96.8262, phone: "(972) 555-0248" },
      { name: "Preston Ridge Dental", addr: "8500 Preston Rd, Frisco, TX", rating: 4.7, reviews: 187, status: "Call Back Later", lat: 33.1289, lng: -96.8043, phone: "(469) 555-0262" },
      { name: "Willow Bend Dental Care", addr: "6101 Windhaven Pkwy, Plano, TX", rating: 4.5, reviews: 121, status: "Not Called", lat: 33.0603, lng: -96.8321, phone: "(972) 555-0279" },
    ] },
  { id: 2, run_name: "North Houston sweep — " + isoOffset(-4), location: "Houston, TX",
    total: 73, fresh: 68, reused: 5, promoted: 9, created_by: "Avery", when: isoOffset(-4) + " at 6:33 PM CT", saved: true,
    center: [29.9, -95.45],
    clinics: [
      { name: "Magnolia Park Dental", addr: "4410 Navigation Blvd, Houston, TX", rating: 4.3, reviews: 78, status: "Not Called", lat: 29.7519, lng: -95.3121, phone: "(281) 555-0134" },
      { name: "Champions Forest Dentistry", addr: "13300 Champion Forest Dr, Houston, TX", rating: 4.8, reviews: 264, status: "Interested", lat: 29.9784, lng: -95.5433, phone: "(281) 555-0311" },
      { name: "Spring Branch Smile Studio", addr: "8901 Long Point Rd, Houston, TX", rating: 4.2, reviews: 54, status: "No Answer", lat: 29.8021, lng: -95.5312, phone: "(713) 555-0328" },
      { name: "Vintage Park Dental", addr: "10920 Louetta Rd, Houston, TX", rating: 4.9, reviews: 401, status: "Not Called", lat: 29.9912, lng: -95.5701, phone: "(832) 555-0344" },
    ] },
  { id: 3, run_name: "Austin pilot zone — " + isoOffset(-9), location: "Austin, TX",
    total: 21, fresh: 21, reused: 0, promoted: 4, created_by: "Riley", when: isoOffset(-9) + " at 11:04 AM CT", saved: false,
    center: [30.30, -97.75],
    clinics: [
      { name: "Willow Creek Orthodontics", addr: "4200 S Lamar Blvd, Austin, TX", rating: 4.9, reviews: 356, status: "Interested", lat: 30.2358, lng: -97.7891, phone: "(512) 555-0190" },
      { name: "Barton Springs Dental", addr: "1701 Barton Springs Rd, Austin, TX", rating: 4.6, reviews: 178, status: "Not Called", lat: 30.2622, lng: -97.7657, phone: "(512) 555-0362" },
      { name: "Mueller District Dentistry", addr: "1801 E 51st St, Austin, TX", rating: 4.7, reviews: 203, status: "Left Voicemail", lat: 30.3014, lng: -97.7003, phone: "(512) 555-0377" },
    ] },
];

/* ---------------- sidebar bot transcript ---------------- */

const BOT_THREADS = {
  "Texts": [
    { who: "user", text: "what's overdue for me today", ago: 52 },
    { who: "bot", text: "You have 4 overdue follow-ups. The oldest is Katy Prairie Dental — a phone call that was due 15 days ago. Cedar Ridge Family Dental is 6 days overdue and sitting in Waiting on Decision.", ago: 52 },
    { who: "user", text: "log a call for cedar ridge, left a voicemail for dr alvarez", ago: 34 },
    { who: "bot", text: "Logged. Cedar Ridge Family Dental — Phone call, left a voicemail for Dr. Alvarez. Want me to set a next action?", ago: 34 },
    { who: "user", text: "yes call back friday", ago: 33 },
    { who: "bot", text: "Saved. Updated Cedar Ridge Family Dental — next action: Call back, next action due date: " + isoOffset(2) + ".", ago: 33 },
  ],
};

/* ---------------- stage badge palette (from utils/ui.py) ---------------- */

const STAGE_COLORS = {
  "New Lead":            { bg: "#f1f5f9", fg: "#475569" },
  "Contacted":           { bg: "#ffedd5", fg: "#c2410c" },
  "Interested":          { bg: "#eff6ff", fg: "#1d4ed8" },
  "Demo Scheduled":      { bg: "#faf5ff", fg: "#7e22ce" },
  "Waiting on Decision": { bg: "#fef9c3", fg: "#854d0e" },
  "Onboarding":          { bg: "#ecfdf5", fg: "#047857" },
  "Closed Won":          { bg: "#dcfce7", fg: "#16a34a" },
  "Closed Lost":         { bg: "#fee2e2", fg: "#dc2626" },
  "Nurture Later":       { bg: "#e0e7ff", fg: "#4f46e5" },
};

/* ---------------- call-status palette (donut run checklists) ---------------- */

const CALL_STATUS_COLORS = {
  "Not Called":      { bg: "#f1f5f9", fg: "#475569" },
  "No Answer":       { bg: "#fef3c7", fg: "#92400e" },
  "Left Voicemail":  { bg: "#e0e7ff", fg: "#4338ca" },
  "Call Back Later": { bg: "#ffedd5", fg: "#c2410c" },
  "Interested":      { bg: "#dcfce7", fg: "#15803d" },
  "Not Interested":  { bg: "#fee2e2", fg: "#b91c1c" },
  "Dead":            { bg: "#e2e8f0", fg: "#334155" },
};

/* Clinics a fresh scrape can turn up, so "Run scrape" produces a real run. */
const CLINIC_POOL = [
  ["Ashwood Dental Studio", "1204 Ashwood Ln"], ["Brightleaf Family Dentistry", "88 Brightleaf Rd"],
  ["Canyon Oaks Dental", "5510 Canyon Oaks Blvd"], ["Dover Park Dentistry", "710 Dover Park Dr"],
  ["Emberly Smile Care", "3345 Emberly Way"], ["Foxglove Dental Group", "9021 Foxglove St"],
  ["Granite Hill Dental", "417 Granite Hill Ave"], ["Hollowbrook Dentistry", "2680 Hollowbrook Pkwy"],
  ["Ironwood Dental Arts", "1533 Ironwood Trl"], ["Juniper Ridge Dental", "6104 Juniper Ridge Dr"],
  ["Kestrel Lane Dentistry", "228 Kestrel Ln"], ["Larkspur Dental Care", "7742 Larkspur Blvd"],
  ["Marigold Family Dental", "310 Marigold Ct"], ["Northfield Smile Studio", "4460 Northfield Rd"],
  ["Orchard Gate Dentistry", "1890 Orchard Gate Dr"], ["Pinecrest Dental Partners", "5027 Pinecrest Ave"],
];

const CALL_STATUS_SEED = ["Not Called", "Not Called", "No Answer", "Left Voicemail", "Not Called", "Call Back Later"];
