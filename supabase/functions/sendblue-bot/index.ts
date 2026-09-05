// SendBlue text bot for the Kairos CRM. Receives inbound iMessage/SMS webhooks,
// matches the sender to a CRM user by phone, runs a Gemini tool-use loop against
// Supabase (same rules as the app: activities drive next_action via the DB
// trigger; account_overview is the read model), and replies via SendBlue.
//
// Secrets (supabase secrets set ...): GEMINI_API_KEY, SENDBLUE_API_KEY_ID,
// SENDBLUE_API_SECRET_KEY, BOT_WEBHOOK_TOKEN. Optional: GEMINI_MODEL,
// GEMINI_FALLBACK_MODEL, SENDBLUE_FROM_NUMBER.
//
// The webhook URL registered with SendBlue must include ?token=<BOT_WEBHOOK_TOKEN>.
// Append &debug=1 to get the reply in the HTTP response instead of a text
// (for curl testing before SendBlue is wired up).

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = Deno.env.get("GEMINI_FALLBACK_MODEL") ?? "gemini-2.5-flash-lite";
const SENDBLUE_API_KEY_ID = Deno.env.get("SENDBLUE_API_KEY_ID") ?? "";
const SENDBLUE_API_SECRET_KEY = Deno.env.get("SENDBLUE_API_SECRET_KEY") ?? "";
const SENDBLUE_FROM_NUMBER = Deno.env.get("SENDBLUE_FROM_NUMBER") ?? "";
const BOT_WEBHOOK_TOKEN = Deno.env.get("BOT_WEBHOOK_TOKEN") ?? "";

// Mirrors utils/constants.py — keep in sync.
const PIPELINE_STAGES = [
  "New Lead",
  "Not Called",
  "No Answer",
  "Left Voicemail",
  "Call Back Later",
  "Contacted",
  "Interested",
  "Demo Scheduled",
  "Waiting on Decision",
  "Onboarding",
  "Closed Won",
  "Closed Lost",
  "Not Interested",
  "Dead",
  "Nurture Later",
];
const CLOSED_STAGES = ["Closed Won", "Closed Lost", "Nurture Later", "Not Interested", "Dead"];
const ACTIVITY_TYPES = [
  "In-person visit",
  "Phone call",
  "Email sent",
  "Demo scheduled",
  "Demo completed",
  "Follow-up completed",
  "Pricing/onboarding info sent",
  "No response",
  "Other",
];
const LOST_REASONS = [
  "Too expensive",
  "Not ready for AI",
  "Dentist/owner not interested",
  "Office manager not interested",
  "Uses another AI tool",
  "Uses another patient communication tool",
  "DSO restriction",
  "PMS/integration concern",
  "Bad timing",
  "No response",
  "Other",
];
const COMPETITOR_TOOLS = [
  "Weave",
  "Adit",
  "Dentina",
  "NexHealth",
  "Mango",
  "Dental Intelligence",
  "Patient Prism",
  "None / front desk only",
  "Unknown",
];
const DECISION_MAKER_REACHED = ["Unknown", "Yes", "No"];
const DEMO_STATUSES = ["Scheduled", "Completed", "No-show", "Rescheduled"];
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
const CADENCE_CHANNELS = ["Phone call", "Email", "Text", "In-person visit"];
// Mirrors utils/constants.py DONUT_CALL_STATUSES — keep in sync.
const DONUT_CALL_STATUSES = [
  "Not Called",
  "No Answer",
  "Left Voicemail",
  "Interested",
  "Not Interested",
  "Dead",
  "Call Back Later",
];

const ACCOUNT_SUMMARY_COLS =
  "id, practice_name, city, pipeline_stage, kairos_owner_id, next_action, next_action_due_date, last_action_date";

function chicagoToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function chicagoWeekday(): string {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long" });
}

function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, "").slice(-10);
}

function isDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

const GENERIC_NAME_WORDS = /\b(?:dental|dentistry|orthodontics|orthodontist|endodontics|pediatric|family|center|centre|clinic|associates|group|partners|specialists|surgery|implant|smile|smiles|braces|oral|cosmetic|care|of|the|and)\b/gi;

function normPhone(phone: unknown): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits.length >= 10 ? digits.slice(0, 10) : digits;
}

function normEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

function normDomain(url: unknown): string {
  let s = String(url ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "").split("/")[0];
  if (s.startsWith("www.")) {
    s = s.slice(4);
  }
  return s;
}

function normCity(city: unknown): string {
  let s = String(city ?? "").trim().toLowerCase();
  s = s.replace(/[,\s]+\b[a-z]{2}\b$/, "");
  if (s.endsWith("texas")) {
    s = s.slice(0, -5).trim();
  }
  return s.replace(/\s+/g, " ");
}

// Mirrors db/queries.py _city_from_address / _state_from_address — keep in sync.
// Locates the "ST ZIP" segment by regex and reads off it, rather than counting
// parts from the front, since a suite/unit segment or Google's trailing "USA"
// both shift a fixed offset by one.
function cityFromAddress(address: string): string | null {
  const parts = (address ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (/^[A-Z]{2}\s+\d{5}/.test(parts[i]) && i > 0) return parts[i - 1];
  }
  if (parts.length >= 2) return parts[parts.length - 2];
  if (parts.length === 1) return parts[0];
  return null;
}

function stateFromAddress(address: string): string | null {
  const parts = (address ?? "").split(",").map((p) => p.trim()).filter(Boolean).reverse();
  for (const part of parts) {
    const m = part.match(/^([A-Z]{2})\s+\d{5}/);
    if (m) return m[1];
  }
  return null;
}

async function getDonutChannelId(): Promise<number | null> {
  const { data: existing } = await supabase.from("channel_types").select("id").ilike("label", "Donut Visit").maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await supabase.from("channel_types").insert({ label: "Donut Visit" }).select("id").single();
  return created?.id ?? null;
}

function normName(name: unknown): string {
  const s = String(name ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function nameCore(name: unknown): string {
  const s = normName(name).replace(GENERIC_NAME_WORDS, " ");
  return s.replace(/\s+/g, " ").trim();
}

function levenshteinDistance(a: string, b: string): number {
  const tmp: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1, // deletion
        tmp[i][j - 1] + 1, // insertion
        tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
    }
  }
  return tmp[a.length][b.length];
}

function tokenSortRatio(a: string, b: string): number {
  const normA = a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean).sort().join(" ");
  const normB = b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean).sort().join(" ");
  if (!normA && !normB) return 100;
  if (!normA || !normB) return 0;
  const dist = levenshteinDistance(normA, normB);
  const sumLen = normA.length + normB.length;
  return Math.round(((sumLen - dist) / sumLen) * 100);
}

// Existing options that fuzzily resemble a proposed new value, most similar
// first. Used to push back before the bot coins a near-duplicate (e.g. a new
// "Follow-up text" activity type when "Text sent" already exists). 65 is a
// starting default, like NAME_SIMILARITY_THRESHOLD in utils/dedup.py — not
// tuned; flag to Yajat rather than silently adjusting if it misses or
// over-triggers on real traffic.
function topSimilar(candidate: string, options: string[], limit = 2): string[] {
  return options
    .filter((o) => o.toLowerCase() !== candidate.toLowerCase())
    .map((o) => ({ value: o, score: tokenSortRatio(candidate, o) }))
    .filter((s) => s.score >= 65)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.value);
}

// deno-lint-ignore no-explicit-any
function findDuplicates(
  candidate: Record<string, any>,
  existing: Record<string, any>[],
): { match: Record<string, any>; reasons: string[]; confidence: string }[] {
  const cPhone = normPhone(candidate.practice_phone);
  const cEmail = normEmail(candidate.practice_email);
  const cDomain = normDomain(candidate.website);
  const cCity = normCity(candidate.city);
  const cName = normName(candidate.practice_name);
  const cCore = nameCore(candidate.practice_name);

  const results = [];
  const threshold = 85;

  for (const row of existing) {
    if (candidate.id !== undefined && row.id === candidate.id) {
      continue;
    }

    const reasons: string[] = [];
    if (cPhone && cPhone.length >= 10 && cPhone === normPhone(row.practice_phone)) {
      reasons.push("Same phone number");
    }
    if (cEmail && cEmail === normEmail(row.practice_email)) {
      reasons.push("Same email");
    }
    if (cDomain && cDomain === normDomain(row.website)) {
      reasons.push("Same website");
    }

    let confidence = reasons.length ? "exact" : "";

    if (!reasons.length && cName && cCity && cCity === normCity(row.city)) {
      const rName = normName(row.practice_name);
      const rCore = nameCore(row.practice_name);
      const score = tokenSortRatio(cName, rName);
      const coreMatch = cCore.length >= 4 && cCore === rCore;
      if (score >= threshold || coreMatch) {
        reasons.push(`Similar name in same city (${score}% match)`);
        confidence = "fuzzy";
      }
    }

    if (reasons.length) {
      results.push({ match: row, reasons, confidence });
    }
  }

  results.sort((a, b) => (a.confidence === "exact" ? -1 : 1));
  return results;
}

const TOOL_DECLARATIONS = [
  {
    name: "get_due_today",
    description:
      "Accounts owned by the current user whose next action is due today or overdue (America/Chicago). Use for 'what's due', 'what do I have today'.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "list_my_accounts",
    description:
      "Open accounts owned by the current user with stage, next action, and due date. Use for 'what am I working on'. Optionally filter by pipeline stage.",
    parameters: {
      type: "OBJECT",
      properties: {
        stage: { type: "STRING", description: `One of: ${PIPELINE_STAGES.join(", ")}` },
        include_closed: { type: "BOOLEAN", description: "Include Closed Won/Closed Lost/Nurture Later accounts" },
      },
    },
  },
  {
    name: "find_account",
    description:
      "Search all accounts (any owner) by practice name fragment. Returns candidate matches with ids. Always use this to resolve a name before get_account_details, log_activity, or update_account.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "Practice name or part of it" } },
      required: ["query"],
    },
  },
  {
    name: "get_account_details",
    description:
      "Full detail for one account: every field plus contacts, recent activities, and demos. Contacts and demos include their id - use those exact ids for edit_contact/edit_demo, never a guessed or remembered number.",
    parameters: {
      type: "OBJECT",
      properties: { account_id: { type: "INTEGER" } },
      required: ["account_id"],
    },
  },
  {
    name: "log_activity",
    description:
      "Log an activity on an account, attributed to the current user, dated today unless another date is given. If next_action/next_action_due_date are provided the account's current next action is updated automatically.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_id: { type: "INTEGER" },
        activity_type: { type: "STRING", description: `Prefer an existing type from: ${ACTIVITY_TYPES.join(", ")} (or one of the current custom types listed in the system prompt). If none fits, you may use a short new type name in the same sentence-case style (e.g. "Text sent"), but you must flag it as new in your proposal.` },
        summary: { type: "STRING" },
        date: { type: "STRING", description: "YYYY-MM-DD, defaults to today in Chicago" },
        next_action: { type: "STRING" },
        next_action_due_date: { type: "STRING", description: "YYYY-MM-DD" },
        confirm_new: { type: "BOOLEAN", description: "Set true only on a follow-up call, after the user has explicitly said they want a brand-new activity_type despite a similar existing one you already asked them about." },
      },
      required: ["account_id", "activity_type", "summary"],
    },
  },
  {
    name: "update_account",
    description:
      "Update any field on an existing account directly (stage change, contact info, decision maker, current tool, etc). Set every field the message gives you a basis for, not just the one the user named. Do NOT use this for next_action changes that stem from an activity the user is reporting — log_activity handles those.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_id: { type: "INTEGER" },
        pipeline_stage: {
          type: "STRING",
          description: `Current stage in the sales pipeline. One of: ${PIPELINE_STAGES.join(", ")}.`,
        },
        next_action: { type: "STRING", description: "The single next step to take. Only set here for a standalone correction; otherwise use log_activity." },
        next_action_due_date: { type: "STRING", description: "Due date of the next action, YYYY-MM-DD." },
        best_contact: {
          type: "STRING",
          description: "Name of the primary day-to-day contact at the practice (often the office manager / front-desk lead). If only one person has been named or spoken to, that person is the best contact.",
        },
        best_contact_email: { type: "STRING", description: "Email of the best-contact person specifically (not the general office email)." },
        best_contact_phone: { type: "STRING", description: "Direct phone of the best-contact person specifically." },
        decision_maker: {
          type: "STRING",
          description: "Name of the person with buying authority, usually the dentist / practice owner. May be the same person as best_contact if that person decides.",
        },
        decision_maker_email: { type: "STRING", description: "Email of the decision maker specifically." },
        decision_maker_phone: { type: "STRING", description: "Direct phone of the decision maker specifically." },
        decision_maker_reached: {
          type: "STRING",
          description: `Whether the decision maker has actually been spoken to. One of: ${DECISION_MAKER_REACHED.join(", ")}. 'Yes' only if the owner/dentist was reached directly; 'No' if only staff/office manager were reached.`,
        },
        lost_reason: {
          type: "STRING",
          description: `Why the deal was lost. Set only when stage is Closed Lost. One of: ${LOST_REASONS.join(", ")}.`,
        },
        practice_phone: { type: "STRING", description: "Main office phone line for the practice." },
        practice_email: { type: "STRING", description: "General office email (e.g. info@, staff@); NOT a specific person's email." },
        website: { type: "STRING", description: "Practice website URL or domain." },
        city: { type: "STRING" },
        state: { type: "STRING", description: "Two-letter state, e.g. TX." },
        source_detail: { type: "STRING", description: "Where the lead came from, e.g. 'PNDC 2026', 'Apollo', a referrer's name." },
        pms: { type: "STRING", description: "Practice-management software they currently run, e.g. Open Dental, Dentrix, Eaglesoft, Curve." },
        competitor_tool: {
          type: "STRING",
          description: `Existing patient-communication / AI tool they use. One of: ${COMPETITOR_TOOLS.join(", ")}. Use 'None / front desk only' if they have none.`,
        },
        channel_type_id: { type: "INTEGER", description: "Reassign how this lead was sourced. Channel type ID from the list in the system prompt." },
        kairos_owner_id: { type: "INTEGER", description: "Reassign the account's Kairos owner. User ID from the list in the system prompt." },
        initial_encounter_summary: { type: "STRING", description: "Narrative of the first meaningful encounter. Prefer log_activity for ongoing updates; only edit this to correct the original." },
        cadence_id: { type: "INTEGER", description: "Enroll the account in a follow-up cadence. Cadence ID from list_settings." },
        cadence_paused: { type: "BOOLEAN", description: "Pause or resume the account's current cadence without changing which one it's on." },
      },
      required: ["account_id"],
    },
  },
  {
    name: "create_account",
    description:
      "Create a new dental practice account. Populate every field the message supports (see field descriptions), not just the name. Warning: this tool checks for duplicates, and you must warn the user if a duplicate is found.",
    parameters: {
      type: "OBJECT",
      properties: {
        practice_name: { type: "STRING", description: "Official name of the dental practice (required)." },
        city: { type: "STRING" },
        state: { type: "STRING", description: "Two-letter state, e.g. TX." },
        practice_phone: { type: "STRING", description: "Main office phone line." },
        practice_email: { type: "STRING", description: "General office email (e.g. info@, staff@); NOT a specific person's email." },
        website: { type: "STRING", description: "Practice website URL or domain." },
        kairos_owner_id: { type: "INTEGER", description: "Kairos rep who owns this account. Defaults to the texting user's ID." },
        channel_type_id: { type: "INTEGER", description: "How the lead was sourced. Channel type ID from the list in the system prompt (e.g. a walk-in is Cold Visit or Donut Visit)." },
        source_detail: { type: "STRING", description: "Where the lead came from, e.g. 'PNDC 2026', 'Apollo', a referrer's name." },
        initial_encounter_summary: { type: "STRING", description: "Narrative of the first meaningful encounter: who was spoken to, what was discussed, their reaction." },
        pipeline_stage: {
          type: "STRING",
          description: `Current stage. One of: ${PIPELINE_STAGES.join(", ")}. Default 'New Lead'. Infer from sentiment: a positive first meeting is 'Interested', a booked demo is 'Demo Scheduled'.`,
        },
        next_action: { type: "STRING" },
        next_action_due_date: { type: "STRING", description: "YYYY-MM-DD." },
        best_contact: {
          type: "STRING",
          description: "Primary day-to-day contact (often the office manager). If only one person has been named or spoken to, that person is the best contact.",
        },
        best_contact_email: { type: "STRING", description: "Email of the best-contact person specifically." },
        best_contact_phone: { type: "STRING", description: "Direct phone of the best-contact person specifically." },
        decision_maker: { type: "STRING", description: "Person with buying authority, usually the dentist / owner. May equal best_contact." },
        decision_maker_email: { type: "STRING", description: "Email of the decision maker specifically." },
        decision_maker_phone: { type: "STRING", description: "Direct phone of the decision maker specifically." },
        decision_maker_reached: {
          type: "STRING",
          description: `Whether the decision maker was actually spoken to. One of: ${DECISION_MAKER_REACHED.join(", ")}. 'No' if only staff were reached.`,
        },
        pms: { type: "STRING", description: "Practice-management software they run, e.g. Open Dental, Dentrix, Eaglesoft." },
        competitor_tool: {
          type: "STRING",
          description: `Existing patient-communication / AI tool. One of: ${COMPETITOR_TOOLS.join(", ")}.`,
        },
      },
      required: ["practice_name"],
    },
  },
  {
    name: "add_contact",
    description:
      "Add a person to an account's contact roster (the Contacts tab). Use when the user names a specific person at the practice with a role, email, or phone worth keeping. This is separate from the account's best_contact/decision_maker quick-reference fields — set those on the account too if this person fills that role.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_id: { type: "INTEGER" },
        name: { type: "STRING", description: "Person's full name (required)." },
        role: { type: "STRING", description: "Their role at the practice, e.g. Office Manager, Dentist/Owner, Front Desk." },
        email: { type: "STRING" },
        phone: { type: "STRING" },
        confirm_new: { type: "BOOLEAN", description: "Set true only on a follow-up call, after the user has explicitly confirmed this is a different person from a similarly-named existing contact you already asked them about." },
      },
      required: ["account_id", "name"],
    },
  },
  {
    name: "log_demo",
    description:
      "Record a demo on the account's Demos tab. Use when a demo is scheduled, completed, rescheduled, or a no-show. If a demo is newly scheduled or completed, also log_activity so the timeline and next action reflect it.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_id: { type: "INTEGER" },
        demo_date: { type: "STRING", description: "Date of the demo, YYYY-MM-DD." },
        status: { type: "STRING", description: `One of: ${DEMO_STATUSES.join(", ")}. Default 'Scheduled'.` },
        attendees: { type: "STRING", description: "Who attended or is expected to attend, e.g. 'Dr. Lee and the office manager'." },
        pain_points: { type: "STRING", description: "Problems/needs the practice raised during the demo." },
        objections: { type: "STRING", description: "Concerns or objections they voiced." },
        follow_up_required: { type: "STRING", description: "What follow-up the demo surfaced." },
      },
      required: ["account_id"],
    },
  },
  {
    name: "list_settings",
    description:
      "List admin/settings data: all users and channel types (including inactive), all cadences with their steps, and all email templates. Use this to resolve names to IDs before manage_user, manage_channel_type, manage_cadence, manage_cadence_step, manage_email_template, or an update_account cadence_id, including inactive ones you might reactivate.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "manage_user",
    description: "Add a new Kairos team member, or deactivate/reactivate an existing one. Deactivate rather than delete so historical accounts keep their owner reference.",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["add", "deactivate", "reactivate"] },
        name: { type: "STRING", description: "Full name (for add)." },
        user_id: { type: "INTEGER", description: "ID from list_settings (for deactivate/reactivate)." },
        confirm_new: { type: "BOOLEAN", description: "Set true only after the user confirmed a genuinely new team member despite a similarly-named existing one." },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_channel_type",
    description: "Add a new lead-source channel type, or deactivate/reactivate an existing one. Deactivate rather than delete so historical accounts keep their reference.",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["add", "deactivate", "reactivate"] },
        label: { type: "STRING", description: "Channel type name (for add)." },
        channel_type_id: { type: "INTEGER", description: "ID from list_settings (for deactivate/reactivate)." },
        confirm_new: { type: "BOOLEAN", description: "Set true only after the user confirmed a genuinely new channel type despite a similarly-named existing one." },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_cadence",
    description: "Create a new follow-up cadence, edit its name/description, or deactivate/reactivate it. Steps are managed separately with manage_cadence_step.",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["create", "update", "deactivate", "reactivate"] },
        cadence_id: { type: "INTEGER", description: "ID from list_settings (for update/deactivate/reactivate)." },
        name: { type: "STRING" },
        description: { type: "STRING" },
        confirm_new: { type: "BOOLEAN", description: "Set true only after the user confirmed a genuinely new cadence despite a similarly-named existing one." },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_cadence_step",
    description: "Add, edit, or delete a single step within a cadence. day_gap is calendar days after the previous step (step 1 counts from enrollment).",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["add", "update", "delete"] },
        cadence_id: { type: "INTEGER", description: "ID from list_settings (required for add)." },
        step_id: { type: "INTEGER", description: "ID from list_settings (required for update/delete)." },
        step_order: { type: "INTEGER", description: "Position of this step within the cadence, starting at 1." },
        channel: { type: "STRING", description: `Prefer one of: ${CADENCE_CHANNELS.join(", ")}. A custom channel name is allowed.` },
        day_gap_min: { type: "INTEGER", description: "Minimum days after the previous step. Default 0." },
        day_gap_max: { type: "INTEGER", description: "Maximum days after the previous step, shown as guidance." },
        note: { type: "STRING" },
        email_template_id: { type: "INTEGER", description: "Email template to use for this step, ID from list_settings." },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_email_template",
    description: "Create, edit, or delete a reusable email template.",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["create", "update", "delete"] },
        template_id: { type: "INTEGER", description: "ID from list_settings (required for update/delete)." },
        name: { type: "STRING" },
        category: { type: "STRING", description: `One of: ${TEMPLATE_CATEGORIES.join(", ")}.` },
        situation: { type: "STRING", description: "When to use this template." },
        subject: { type: "STRING" },
        body: { type: "STRING" },
        notes: { type: "STRING" },
        confirm_new: { type: "BOOLEAN", description: "Set true only after the user confirmed a genuinely new template despite a similarly-named existing one." },
      },
      required: ["action"],
    },
  },
  {
    name: "edit_contact",
    description: "Update or delete an existing contact person on an account's roster. For adding a new person, use add_contact instead. contact_id must come from get_account_details for the right account - never guess or reuse an id from a different account.",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["update", "delete"] },
        contact_id: { type: "INTEGER", description: "ID of the contact, from find_account/get_account_details." },
        name: { type: "STRING" },
        role: { type: "STRING" },
        email: { type: "STRING" },
        phone: { type: "STRING" },
      },
      required: ["action", "contact_id"],
    },
  },
  {
    name: "edit_demo",
    description: "Update or delete an existing demo record. For logging a new demo, use log_demo instead. demo_id must come from get_account_details for the right account - never guess or reuse an id from a different account.",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["update", "delete"] },
        demo_id: { type: "INTEGER", description: "ID of the demo, from get_account_details." },
        demo_date: { type: "STRING", description: "YYYY-MM-DD." },
        status: { type: "STRING", description: `One of: ${DEMO_STATUSES.join(", ")}.` },
        attendees: { type: "STRING" },
        pain_points: { type: "STRING" },
        objections: { type: "STRING" },
        follow_up_required: { type: "STRING" },
      },
      required: ["action", "demo_id"],
    },
  },
  {
    name: "list_donut_runs",
    description:
      "List the current user's own Donut Scrape runs (scrape runs are private per user, like accounts). Returns each run's id, name, area, status, and clinic/promotion counts. Use this before find_donut_run if the user just wants an overview, or to resolve 'my scrape runs' / 'the Dallas run' etc.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "find_donut_run",
    description:
      "Search the current user's own Donut Scrape runs by run name or area name fragment (e.g. 'dallas', 'plano'). Always use this (or list_donut_runs) to resolve a run to an id before get_donut_run_detail or any donut write tool.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "Run name or area fragment" } },
      required: ["query"],
    },
  },
  {
    name: "get_donut_run_detail",
    description:
      "Full detail for one Donut Scrape run: its status/counts plus every clinic result (id, name, phone, email, dentist, call_status, promoted_account_id). Use the result ids from here for update_donut_result / promote_donut_result / unpromote_donut_result - never guess an id.",
    parameters: {
      type: "OBJECT",
      properties: { run_id: { type: "INTEGER" } },
      required: ["run_id"],
    },
  },
  {
    name: "update_donut_result",
    description:
      "Update the call status and/or call notes on one clinic in a Donut Scrape run's checklist - this is the same action as calling through the checklist in the app.",
    parameters: {
      type: "OBJECT",
      properties: {
        result_id: { type: "INTEGER", description: "Donut run result id, from get_donut_run_detail." },
        call_status: { type: "STRING", description: `One of: ${DONUT_CALL_STATUSES.join(", ")}.` },
        call_notes: { type: "STRING" },
      },
      required: ["result_id"],
    },
  },
  {
    name: "promote_donut_result",
    description:
      "Promote one clinic from a Donut Scrape run's checklist into its own standalone CRM account, still tagged to the run. Checks for duplicates against existing CRM accounts first and you must warn the user if any are found, same as create_account.",
    parameters: {
      type: "OBJECT",
      properties: { result_id: { type: "INTEGER", description: "Donut run result id, from get_donut_run_detail." } },
      required: ["result_id"],
    },
  },
  {
    name: "unpromote_donut_result",
    description:
      "Remove the CRM account link from a previously-promoted Donut Scrape result, moving it back to 'not yet in CRM' in the checklist. Does not delete the CRM account itself.",
    parameters: {
      type: "OBJECT",
      properties: { result_id: { type: "INTEGER", description: "Donut run result id, from get_donut_run_detail." } },
      required: ["result_id"],
    },
  },
  {
    name: "set_donut_run_status",
    description:
      "Confirm, unconfirm, or archive/unarchive a Donut Scrape run as a whole (same as the buttons on the Scrape Runs tab). This does not itself promote any clinic to the CRM - use promote_donut_result for that.",
    parameters: {
      type: "OBJECT",
      properties: {
        run_id: { type: "INTEGER" },
        status: { type: "STRING", enum: ["confirmed", "unsaved", "archived"], description: "Target status: confirmed = mark saved to CRM checklist, unsaved = unconfirm, archived = archive." },
      },
      required: ["run_id", "status"],
    },
  },
  {
    name: "update_donut_run_notes",
    description:
      "Replace the free-text route/visit-planning notes on a Donut Scrape run's Route Map tab (the 'Route Notes' box under the map). Always replaces the full text - if the user wants to add to existing notes, read the current value from get_donut_run_detail first and send the combined text.",
    parameters: {
      type: "OBJECT",
      properties: {
        run_id: { type: "INTEGER" },
        map_notes: { type: "STRING", description: "Full replacement text for the route notes." },
      },
      required: ["run_id", "map_notes"],
    },
  },
];

// deno-lint-ignore no-explicit-any
type ToolArgs = Record<string, any>;

type StagedCall = { name: string; args: ToolArgs };

// Where the dashboard should jump after a write. `page` is a logical page key the
// dashboard maps to a route — not hard-coded to accounts, so future non-account
// tools can point elsewhere. account_id is set when the target is one account.
type NavTarget = { page: string; label: string; account_id: number | null };

const WRITE_TOOLS = new Set([
  "log_activity",
  "update_account",
  "create_account",
  "add_contact",
  "log_demo",
  "manage_user",
  "manage_channel_type",
  "manage_cadence",
  "manage_cadence_step",
  "manage_email_template",
  "edit_contact",
  "edit_demo",
  "update_donut_result",
  "promote_donut_result",
  "unpromote_donut_result",
  "set_donut_run_status",
  "update_donut_run_notes",
]);

// Writes are gated in code, not by the model: without commit the tool only
// validates and stages, and the actual insert/update happens in
// executePending after the user texts an affirmative.
async function execTool(name: string, args: ToolArgs, userId: number, commit = false): Promise<unknown> {
  try {
    switch (name) {
      case "get_due_today": {
        const { data, error } = await supabase
          .from("account_overview")
          .select(ACCOUNT_SUMMARY_COLS)
          .eq("kairos_owner_id", userId)
          .lte("next_action_due_date", chicagoToday())
          .not("pipeline_stage", "in", `(${CLOSED_STAGES.map((s) => `"${s}"`).join(",")})`)
          .order("next_action_due_date");
        if (error) return { error: error.message };
        return { today: chicagoToday(), accounts: data };
      }
      case "list_my_accounts": {
        let q = supabase
          .from("account_overview")
          .select(ACCOUNT_SUMMARY_COLS)
          .eq("kairos_owner_id", userId);
        if (args.stage) q = q.eq("pipeline_stage", args.stage);
        else if (!args.include_closed) {
          q = q.not("pipeline_stage", "in", `(${CLOSED_STAGES.map((s) => `"${s}"`).join(",")})`);
        }
        const { data, error } = await q.order("next_action_due_date", { ascending: true, nullsFirst: false });
        return error ? { error: error.message } : { accounts: data };
      }
      case "find_account": {
        const query = String(args.query ?? "").trim();
        if (!query) return { error: "query is required" };
        let { data } = await supabase
          .from("account_overview")
          .select(ACCOUNT_SUMMARY_COLS)
          .ilike("practice_name", `%${query}%`)
          .limit(8);
        if (!data?.length) {
          const words = query.split(/\s+/).filter((w: string) => w.length > 2);
          if (words.length) {
            const ors = words.map((w: string) => `practice_name.ilike.%${w}%`).join(",");
            data = (
              await supabase.from("account_overview").select(ACCOUNT_SUMMARY_COLS).or(ors).limit(8)
            ).data;
          }
        }
        if (!data?.length) return { matches: [], note: "No accounts matched. Ask the user to rephrase the name." };
        return { matches: data };
      }
      case "get_account_details": {
        const id = Number(args.account_id);
        const [account, contacts, activities, demos] = await Promise.all([
          supabase.from("account_overview").select("*").eq("id", id).maybeSingle(),
          supabase.from("contacts").select("id, name, role, email, phone").eq("account_id", id),
          supabase
            .from("activities")
            .select("date, activity_type, summary, next_action, next_action_due_date")
            .eq("account_id", id)
            .order("date", { ascending: false })
            .order("id", { ascending: false })
            .limit(6),
          supabase
            .from("demos")
            .select("id, demo_date, status, attendees, pain_points, objections, follow_up_required")
            .eq("account_id", id)
            .order("demo_date", { ascending: false }),
        ]);
        if (!account.data) return { error: `No account with id ${id}` };
        return {
          account: account.data,
          contacts: contacts.data ?? [],
          recent_activities: activities.data ?? [],
          demos: demos.data ?? [],
        };
      }
      case "log_activity": {
        const activityType = String(args.activity_type ?? "").trim();
        if (!activityType) return { error: "activity_type is required" };
        if (args.next_action_due_date && !isDate(args.next_action_due_date)) {
          return { error: "next_action_due_date must be YYYY-MM-DD" };
        }
        if (!commit) {
          // Any type is allowed (the column is unconstrained and the app accepts
          // typed-in types); flag one the team has never used so the model warns
          // the rep it is coining a new type before they confirm.
          const allTypes = [...ACTIVITY_TYPES, ...(await knownActivityTypes())];
          const known = new Set(allTypes.map((t) => t.toLowerCase()));
          const isNew = !known.has(activityType.toLowerCase());
          const similar = isNew ? topSimilar(activityType, allTypes) : [];
          if (isNew && similar.length && !args.confirm_new) {
            // Not staged: the user hasn't resolved which one they mean yet, so a
            // plain "yes" from them must not execute this ambiguous call.
            return {
              status: "needs_clarification",
              similar_existing_types: similar,
              note: `"${activityType}" is not an existing activity type, and it looks similar to existing type(s): ${similar.join(", ")}. Do NOT stage or propose anything yet. Ask the user whether they meant one of the existing similar type(s), or really want a new type called "${activityType}". Once they answer, call log_activity again: with the existing type name if they picked one, or with the same new name and confirm_new: true if they confirmed a new type - then make the normal 'Reply yes to save' proposal.`,
            };
          }
          return {
            status: "needs_confirmation",
            new_activity_type: isNew,
            note: isNew
              ? `"${activityType}" is not an existing activity type. In your proposal, explicitly tell the user you are creating a NEW activity type by this name, then ask them to reply yes to save.`
              : "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save.",
          };
        }
        const row: ToolArgs = {
          account_id: Number(args.account_id),
          date: isDate(args.date) ? args.date : chicagoToday(),
          kairos_owner_id: userId,
          activity_type: activityType,
          summary: args.summary ?? null,
          next_action: args.next_action ?? null,
          next_action_due_date: args.next_action_due_date ?? null,
        };
        // The activities_sync_next_action trigger updates the parent account's
        // next_action fields atomically with this insert — never update here too.
        const { error } = await supabase.from("activities").insert(row);
        return error ? { error: error.message } : { ok: true, logged: row };
      }
      case "update_account": {
        const allowed = [
          "pipeline_stage",
          "next_action",
          "next_action_due_date",
          "best_contact",
          "best_contact_email",
          "best_contact_phone",
          "decision_maker",
          "decision_maker_email",
          "decision_maker_phone",
          "decision_maker_reached",
          "lost_reason",
          "practice_phone",
          "practice_email",
          "website",
          "city",
          "state",
          "source_detail",
          "pms",
          "competitor_tool",
          "channel_type_id",
          "kairos_owner_id",
          "initial_encounter_summary",
          "cadence_id",
          "cadence_paused",
        ];
        const fields: ToolArgs = {};
        for (const k of allowed) if (args[k] !== undefined) fields[k] = args[k];
        if (fields.pipeline_stage && !PIPELINE_STAGES.includes(fields.pipeline_stage)) {
          return { error: `pipeline_stage must be one of: ${PIPELINE_STAGES.join(", ")}` };
        }
        if (fields.decision_maker_reached && !DECISION_MAKER_REACHED.includes(fields.decision_maker_reached)) {
          return { error: `decision_maker_reached must be one of: ${DECISION_MAKER_REACHED.join(", ")}` };
        }
        if (fields.next_action_due_date && !isDate(fields.next_action_due_date)) {
          return { error: "next_action_due_date must be YYYY-MM-DD" };
        }
        if (!Object.keys(fields).length) return { error: "No editable fields provided" };
        if (!commit) {
          return {
            status: "needs_confirmation",
            note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save.",
          };
        }
        const { error } = await supabase.from("accounts").update(fields).eq("id", Number(args.account_id));
        if (!error && Object.keys(fields).length > 0) {
          const changed = Object.keys(fields).map(k => k.replaceAll("_", " ")).join(", ");
          await supabase.from("activities").insert({
            account_id: Number(args.account_id),
            date: chicagoToday(),
            kairos_owner_id: userId,
            activity_type: "Details updated",
            summary: changed,
            is_system: true,
          });
        }
        return error ? { error: error.message } : { ok: true, updated: fields };
      }
      case "create_account": {
        const practice_name = String(args.practice_name ?? "").trim();
        if (!practice_name) return { error: "practice_name is required" };

        const fields: ToolArgs = {
          practice_name,
          practice_email: args.practice_email ? String(args.practice_email).trim() : null,
          practice_phone: args.practice_phone ? String(args.practice_phone).trim() : null,
          website: args.website ? String(args.website).trim() : null,
          city: args.city ? String(args.city).trim() : null,
          state: args.state ? String(args.state).trim() : null,
          kairos_owner_id: args.kairos_owner_id ? Number(args.kairos_owner_id) : userId,
          channel_type_id: args.channel_type_id ? Number(args.channel_type_id) : null,
          source_detail: args.source_detail ? String(args.source_detail).trim() : null,
          initial_encounter_summary: args.initial_encounter_summary ? String(args.initial_encounter_summary).trim() : null,
          pipeline_stage: args.pipeline_stage ? String(args.pipeline_stage).trim() : "New Lead",
          next_action: args.next_action ? String(args.next_action).trim() : null,
          next_action_due_date: args.next_action_due_date ? String(args.next_action_due_date).trim() : null,
          best_contact: args.best_contact ? String(args.best_contact).trim() : null,
          best_contact_email: args.best_contact_email ? String(args.best_contact_email).trim() : null,
          best_contact_phone: args.best_contact_phone ? String(args.best_contact_phone).trim() : null,
          decision_maker: args.decision_maker ? String(args.decision_maker).trim() : null,
          decision_maker_email: args.decision_maker_email ? String(args.decision_maker_email).trim() : null,
          decision_maker_phone: args.decision_maker_phone ? String(args.decision_maker_phone).trim() : null,
          decision_maker_reached: args.decision_maker_reached ? String(args.decision_maker_reached).trim() : "Unknown",
          pms: args.pms ? String(args.pms).trim() : null,
          competitor_tool: args.competitor_tool ? String(args.competitor_tool).trim() : null,
          creation_source: "chatbot",
          creation_user_id: userId,
        };

        if (fields.pipeline_stage && !PIPELINE_STAGES.includes(fields.pipeline_stage)) {
          return { error: `pipeline_stage must be one of: ${PIPELINE_STAGES.join(", ")}` };
        }
        if (!DECISION_MAKER_REACHED.includes(fields.decision_maker_reached)) {
          return { error: `decision_maker_reached must be one of: ${DECISION_MAKER_REACHED.join(", ")}` };
        }
        if (fields.next_action_due_date && !isDate(fields.next_action_due_date)) {
          return { error: "next_action_due_date must be YYYY-MM-DD" };
        }

        // Run duplicate detection
        const { data: existing } = await supabase
          .from("account_overview")
          .select("id, practice_name, city, practice_phone, practice_email, website");
        
        const duplicates = findDuplicates(fields, existing ?? []);

        if (!commit) {
          return {
            status: "needs_confirmation",
            duplicates: duplicates.map(d => ({
              practice_name: d.match.practice_name,
              city: d.match.city,
              reasons: d.reasons,
              confidence: d.confidence
            })),
            note: "Staged, not saved. Relay the exact proposed change (and warning if duplicates exist) to the user and ask them to reply yes to save.",
          };
        }

        const { data, error } = await supabase
          .from("accounts")
          .insert(fields)
          .select("id")
          .single();

        if (error) return { error: error.message };

        const accountId = data.id;
        const { data: creator } = await supabase.from("users").select("name").eq("id", userId).maybeSingle();
        await supabase.from("activities").insert({
          account_id: accountId,
          date: chicagoToday(),
          kairos_owner_id: userId,
          activity_type: "Account created",
          summary: `Created via chatbot by ${creator?.name ?? "a team member"}`,
          is_system: true,
        });

        return { ok: true, created: { id: accountId, ...fields } };
      }
      case "add_contact": {
        const name = String(args.name ?? "").trim();
        if (!args.account_id) return { error: "account_id is required" };
        if (!name) return { error: "name is required" };
        if (!commit) {
          const { data: existingContacts } = await supabase
            .from("contacts")
            .select("name, role")
            .eq("account_id", Number(args.account_id));
          const existingNames = (existingContacts ?? []).map((c: { name: string }) => c.name).filter(Boolean);
          const similar = topSimilar(name, existingNames);
          if (similar.length && !args.confirm_new) {
            // Not staged: a plain "yes" must not add a possible duplicate person
            // before the user has said whether it's really a different person.
            return {
              status: "needs_clarification",
              similar_existing_contacts: similar,
              note: `"${name}" looks similar to existing contact(s) already on this account: ${similar.join(", ")}. Do NOT stage or propose anything yet. Ask the user whether this is the same person (if so, use update_account or just skip - do not add) or a genuinely different person. If they confirm it's a different person, call add_contact again with confirm_new: true, then make the normal 'Reply yes to save' proposal.`,
            };
          }
          return {
            status: "needs_confirmation",
            note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save.",
          };
        }
        const row = {
          account_id: Number(args.account_id),
          name,
          role: args.role ? String(args.role).trim() : null,
          email: args.email ? String(args.email).trim() : null,
          phone: args.phone ? String(args.phone).trim() : null,
        };
        const { error } = await supabase.from("contacts").insert(row);
        if (!error) {
          await supabase.from("activities").insert({
            account_id: Number(args.account_id),
            date: chicagoToday(),
            kairos_owner_id: userId,
            activity_type: "Contact added",
            summary: name,
            is_system: true,
          });
        }
        return error ? { error: error.message } : { ok: true, added: row };
      }
      case "log_demo": {
        if (!args.account_id) return { error: "account_id is required" };
        const status = args.status ? String(args.status).trim() : "Scheduled";
        if (!DEMO_STATUSES.includes(status)) {
          return { error: `status must be one of: ${DEMO_STATUSES.join(", ")}` };
        }
        if (args.demo_date && !isDate(args.demo_date)) {
          return { error: "demo_date must be YYYY-MM-DD" };
        }
        if (!commit) {
          return {
            status: "needs_confirmation",
            note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save.",
          };
        }
        const row = {
          account_id: Number(args.account_id),
          demo_date: isDate(args.demo_date) ? args.demo_date : null,
          status,
          attendees: args.attendees ? String(args.attendees).trim() : null,
          pain_points: args.pain_points ? String(args.pain_points).trim() : null,
          objections: args.objections ? String(args.objections).trim() : null,
          follow_up_required: args.follow_up_required ? String(args.follow_up_required).trim() : null,
        };
        const { error } = await supabase.from("demos").insert(row);
        if (!error) {
          await supabase.from("activities").insert({
            account_id: Number(args.account_id),
            date: chicagoToday(),
            kairos_owner_id: userId,
            activity_type: "Demo updated",
            summary: row.demo_date ? `${status} for ${row.demo_date}` : status,
            is_system: true,
          });
        }
        return error ? { error: error.message } : { ok: true, demo: row };
      }
      case "list_settings": {
        const [usersRes, channelsRes, cadencesRes, stepsRes, templatesRes] = await Promise.all([
          supabase.from("users").select("id, name, active").order("name"),
          supabase.from("channel_types").select("id, label, active").order("label"),
          supabase.from("cadences").select("id, name, description, active").order("name"),
          supabase.from("cadence_steps").select("*").order("cadence_id").order("step_order").order("id"),
          supabase.from("email_templates").select("*").order("name"),
        ]);
        const stepsByCadence = new Map<number, ToolArgs[]>();
        for (const step of stepsRes.data ?? []) {
          const list = stepsByCadence.get(step.cadence_id) ?? [];
          list.push(step);
          stepsByCadence.set(step.cadence_id, list);
        }
        const cadences = (cadencesRes.data ?? []).map((c: ToolArgs) => ({
          ...c,
          steps: stepsByCadence.get(c.id) ?? [],
        }));
        return {
          users: usersRes.data ?? [],
          channel_types: channelsRes.data ?? [],
          cadences,
          email_templates: templatesRes.data ?? [],
        };
      }
      case "manage_user": {
        const action = String(args.action ?? "");
        if (action === "add") {
          const nameVal = String(args.name ?? "").trim();
          if (!nameVal) return { error: "name is required" };
          if (!commit) {
            const { data } = await supabase.from("users").select("name");
            const similar = topSimilar(nameVal, (data ?? []).map((u: { name: string }) => u.name).filter(Boolean));
            if (similar.length && !args.confirm_new) {
              return {
                status: "needs_clarification",
                similar_existing: similar,
                note: `"${nameVal}" is similar to existing team member(s): ${similar.join(", ")}. Do NOT stage. Ask the user whether they meant one of those or really want to add a new person; if new, re-call with confirm_new: true.`,
              };
            }
            return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          }
          const { data: existing } = await supabase.from("users").select("id").ilike("name", nameVal).maybeSingle();
          if (existing) {
            const { error } = await supabase.from("users").update({ active: true }).eq("id", existing.id);
            return error ? { error: error.message } : { ok: true, user_id: existing.id };
          }
          const { data: created, error } = await supabase.from("users").insert({ name: nameVal }).select("id").single();
          return error ? { error: error.message } : { ok: true, user_id: created.id };
        }
        if (action === "deactivate" || action === "reactivate") {
          if (!args.user_id) return { error: "user_id is required" };
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const { error } = await supabase.from("users").update({ active: action === "reactivate" }).eq("id", Number(args.user_id));
          return error ? { error: error.message } : { ok: true };
        }
        return { error: `Unknown action ${action}` };
      }
      case "manage_channel_type": {
        const action = String(args.action ?? "");
        if (action === "add") {
          const label = String(args.label ?? "").trim();
          if (!label) return { error: "label is required" };
          if (!commit) {
            const { data } = await supabase.from("channel_types").select("label");
            const similar = topSimilar(label, (data ?? []).map((c: { label: string }) => c.label).filter(Boolean));
            if (similar.length && !args.confirm_new) {
              return {
                status: "needs_clarification",
                similar_existing: similar,
                note: `"${label}" is similar to existing channel type(s): ${similar.join(", ")}. Do NOT stage. Ask the user whether they meant one of those or really want a new channel type; if new, re-call with confirm_new: true.`,
              };
            }
            return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          }
          const { data: existing } = await supabase.from("channel_types").select("id").ilike("label", label).maybeSingle();
          if (existing) {
            const { error } = await supabase.from("channel_types").update({ active: true }).eq("id", existing.id);
            return error ? { error: error.message } : { ok: true, channel_type_id: existing.id };
          }
          const { data: created, error } = await supabase.from("channel_types").insert({ label }).select("id").single();
          return error ? { error: error.message } : { ok: true, channel_type_id: created.id };
        }
        if (action === "deactivate" || action === "reactivate") {
          if (!args.channel_type_id) return { error: "channel_type_id is required" };
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const { error } = await supabase.from("channel_types").update({ active: action === "reactivate" }).eq("id", Number(args.channel_type_id));
          return error ? { error: error.message } : { ok: true };
        }
        return { error: `Unknown action ${action}` };
      }
      case "manage_cadence": {
        const action = String(args.action ?? "");
        if (action === "create") {
          const nameVal = String(args.name ?? "").trim();
          if (!nameVal) return { error: "name is required" };
          if (!commit) {
            const { data } = await supabase.from("cadences").select("name");
            const similar = topSimilar(nameVal, (data ?? []).map((c: { name: string }) => c.name).filter(Boolean));
            if (similar.length && !args.confirm_new) {
              return {
                status: "needs_clarification",
                similar_existing: similar,
                note: `"${nameVal}" is similar to existing cadence(s): ${similar.join(", ")}. Do NOT stage. Ask the user whether they meant one of those or really want a new cadence; if new, re-call with confirm_new: true.`,
              };
            }
            return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          }
          const { data: created, error } = await supabase
            .from("cadences")
            .insert({ name: nameVal, description: args.description ? String(args.description).trim() : null })
            .select("id")
            .single();
          return error ? { error: error.message } : { ok: true, cadence_id: created.id };
        }
        if (action === "update" || action === "deactivate" || action === "reactivate") {
          if (!args.cadence_id) return { error: "cadence_id is required" };
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const fields: ToolArgs = {};
          if (action === "update") {
            if (args.name !== undefined) fields.name = String(args.name).trim();
            if (args.description !== undefined) fields.description = args.description ? String(args.description).trim() : null;
            if (!Object.keys(fields).length) return { error: "No editable fields provided" };
          } else {
            fields.active = action === "reactivate";
          }
          const { error } = await supabase.from("cadences").update(fields).eq("id", Number(args.cadence_id));
          return error ? { error: error.message } : { ok: true, updated: fields };
        }
        return { error: `Unknown action ${action}` };
      }
      case "manage_cadence_step": {
        const action = String(args.action ?? "");
        if (action === "add") {
          if (!args.cadence_id) return { error: "cadence_id is required" };
          if (!args.channel) return { error: "channel is required" };
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const gapMin = args.day_gap_min !== undefined ? Number(args.day_gap_min) : 0;
          const gapMax = Math.max(args.day_gap_max !== undefined ? Number(args.day_gap_max) : gapMin, gapMin);
          const row = {
            cadence_id: Number(args.cadence_id),
            step_order: args.step_order !== undefined ? Number(args.step_order) : 1,
            channel: String(args.channel).trim(),
            day_gap_min: gapMin,
            day_gap_max: gapMax,
            note: args.note ? String(args.note).trim() : null,
            email_template_id: args.email_template_id ? Number(args.email_template_id) : null,
          };
          const { error } = await supabase.from("cadence_steps").insert(row);
          return error ? { error: error.message } : { ok: true, added: row };
        }
        if (action === "update") {
          if (!args.step_id) return { error: "step_id is required" };
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const fields: ToolArgs = {};
          if (args.step_order !== undefined) fields.step_order = Number(args.step_order);
          if (args.channel !== undefined) fields.channel = String(args.channel).trim();
          if (args.day_gap_min !== undefined) fields.day_gap_min = Number(args.day_gap_min);
          if (args.day_gap_max !== undefined) fields.day_gap_max = Number(args.day_gap_max);
          if (fields.day_gap_min !== undefined && fields.day_gap_max !== undefined) {
            fields.day_gap_max = Math.max(fields.day_gap_max, fields.day_gap_min);
          }
          if (args.note !== undefined) fields.note = args.note ? String(args.note).trim() : null;
          if (args.email_template_id !== undefined) fields.email_template_id = args.email_template_id ? Number(args.email_template_id) : null;
          if (!Object.keys(fields).length) return { error: "No editable fields provided" };
          const { error } = await supabase.from("cadence_steps").update(fields).eq("id", Number(args.step_id));
          return error ? { error: error.message } : { ok: true, updated: fields };
        }
        if (action === "delete") {
          if (!args.step_id) return { error: "step_id is required" };
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const { error } = await supabase.from("cadence_steps").delete().eq("id", Number(args.step_id));
          return error ? { error: error.message } : { ok: true };
        }
        return { error: `Unknown action ${action}` };
      }
      case "manage_email_template": {
        const action = String(args.action ?? "");
        if (args.category !== undefined && !TEMPLATE_CATEGORIES.includes(args.category)) {
          return { error: `category must be one of: ${TEMPLATE_CATEGORIES.join(", ")}` };
        }
        if (action === "create") {
          const nameVal = String(args.name ?? "").trim();
          if (!nameVal) return { error: "name is required" };
          if (!args.category) return { error: "category is required" };
          if (!commit) {
            const { data } = await supabase.from("email_templates").select("name");
            const similar = topSimilar(nameVal, (data ?? []).map((t: { name: string }) => t.name).filter(Boolean));
            if (similar.length && !args.confirm_new) {
              return {
                status: "needs_clarification",
                similar_existing: similar,
                note: `"${nameVal}" is similar to existing template(s): ${similar.join(", ")}. Do NOT stage. Ask the user whether they meant one of those or really want a new template; if new, re-call with confirm_new: true.`,
              };
            }
            return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          }
          const row = {
            name: nameVal,
            category: args.category,
            situation: args.situation ? String(args.situation).trim() : null,
            subject: args.subject ? String(args.subject).trim() : null,
            body: args.body ? String(args.body) : null,
            notes: args.notes ? String(args.notes).trim() : null,
          };
          const { data: created, error } = await supabase.from("email_templates").insert(row).select("id").single();
          return error ? { error: error.message } : { ok: true, template_id: created.id };
        }
        if (action === "update") {
          if (!args.template_id) return { error: "template_id is required" };
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const fields: ToolArgs = {};
          for (const k of ["name", "category", "situation", "subject", "body", "notes"]) {
            if (args[k] !== undefined) fields[k] = k === "body" ? (args[k] || null) : (args[k] ? String(args[k]).trim() : null);
          }
          if (!Object.keys(fields).length) return { error: "No editable fields provided" };
          const { error } = await supabase.from("email_templates").update(fields).eq("id", Number(args.template_id));
          return error ? { error: error.message } : { ok: true, updated: fields };
        }
        if (action === "delete") {
          if (!args.template_id) return { error: "template_id is required" };
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const { error } = await supabase.from("email_templates").delete().eq("id", Number(args.template_id));
          return error ? { error: error.message } : { ok: true };
        }
        return { error: `Unknown action ${action}` };
      }
      case "edit_contact": {
        const action = String(args.action ?? "");
        if (!args.contact_id) return { error: "contact_id is required" };
        if (action === "update") {
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const fields: ToolArgs = {};
          for (const k of ["name", "role", "email", "phone"]) {
            if (args[k] !== undefined) fields[k] = args[k] ? String(args[k]).trim() : null;
          }
          if (!Object.keys(fields).length) return { error: "No editable fields provided" };
          const { data: before } = await supabase.from("contacts").select("account_id, name").eq("id", Number(args.contact_id)).maybeSingle();
          if (!before) return { error: `No contact with id ${args.contact_id}` };
          const { error } = await supabase.from("contacts").update(fields).eq("id", Number(args.contact_id));
          if (!error) {
            const changed = Object.keys(fields).map((k) => k.replaceAll("_", " ")).join(", ");
            await supabase.from("activities").insert({
              account_id: before.account_id, date: chicagoToday(), kairos_owner_id: userId,
              activity_type: "Contact updated", summary: `${before.name}: ${changed}`, is_system: true,
            });
          }
          return error ? { error: error.message } : { ok: true, updated: fields };
        }
        if (action === "delete") {
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const { data: before } = await supabase.from("contacts").select("account_id, name").eq("id", Number(args.contact_id)).maybeSingle();
          if (!before) return { error: `No contact with id ${args.contact_id}` };
          const { error } = await supabase.from("contacts").delete().eq("id", Number(args.contact_id));
          if (!error) {
            await supabase.from("activities").insert({
              account_id: before.account_id, date: chicagoToday(), kairos_owner_id: userId,
              activity_type: "Contact removed", summary: before.name, is_system: true,
            });
          }
          return error ? { error: error.message } : { ok: true };
        }
        return { error: `Unknown action ${action}` };
      }
      case "edit_demo": {
        const action = String(args.action ?? "");
        if (!args.demo_id) return { error: "demo_id is required" };
        if (args.status !== undefined && !DEMO_STATUSES.includes(args.status)) {
          return { error: `status must be one of: ${DEMO_STATUSES.join(", ")}` };
        }
        if (args.demo_date && !isDate(args.demo_date)) {
          return { error: "demo_date must be YYYY-MM-DD" };
        }
        if (action === "update") {
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const fields: ToolArgs = {};
          if (args.demo_date !== undefined) fields.demo_date = isDate(args.demo_date) ? args.demo_date : null;
          if (args.status !== undefined) fields.status = args.status;
          for (const k of ["attendees", "pain_points", "objections", "follow_up_required"]) {
            if (args[k] !== undefined) fields[k] = args[k] ? String(args[k]).trim() : null;
          }
          if (!Object.keys(fields).length) return { error: "No editable fields provided" };
          const { data: before } = await supabase.from("demos").select("account_id").eq("id", Number(args.demo_id)).maybeSingle();
          if (!before) return { error: `No demo with id ${args.demo_id}` };
          const { error } = await supabase.from("demos").update(fields).eq("id", Number(args.demo_id));
          if (!error) {
            const changed = Object.keys(fields).map((k) => k.replaceAll("_", " ")).join(", ");
            await supabase.from("activities").insert({
              account_id: before.account_id, date: chicagoToday(), kairos_owner_id: userId,
              activity_type: "Demo updated", summary: changed, is_system: true,
            });
          }
          return error ? { error: error.message } : { ok: true, updated: fields };
        }
        if (action === "delete") {
          if (!commit) return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
          const { data: before } = await supabase.from("demos").select("account_id, demo_date").eq("id", Number(args.demo_id)).maybeSingle();
          if (!before) return { error: `No demo with id ${args.demo_id}` };
          const { error } = await supabase.from("demos").delete().eq("id", Number(args.demo_id));
          if (!error) {
            await supabase.from("activities").insert({
              account_id: before.account_id, date: chicagoToday(), kairos_owner_id: userId,
              activity_type: "Demo removed", summary: before.demo_date || "no date", is_system: true,
            });
          }
          return error ? { error: error.message } : { ok: true };
        }
        return { error: `Unknown action ${action}` };
      }
      case "list_donut_runs": {
        const { data: runs, error } = await supabase
          .from("donut_runs")
          .select("id, run_name, area_name, status, total_clinics, new_clinics, reused_clinics, created_at")
          .eq("created_by", userId)
          .order("created_at", { ascending: false });
        if (error) return { error: error.message };
        if (!runs?.length) return { runs: [], note: "No donut scrape runs for this user yet." };
        const ids = runs.map((r: { id: number }) => r.id);
        const { data: results } = await supabase
          .from("donut_run_results")
          .select("donut_run_id, promoted_account_id")
          .in("donut_run_id", ids);
        const promotedByRun = new Map<number, number>();
        for (const r of results ?? []) {
          if (r.promoted_account_id) {
            promotedByRun.set(r.donut_run_id, (promotedByRun.get(r.donut_run_id) ?? 0) + 1);
          }
        }
        return { runs: runs.map((r: { id: number }) => ({ ...r, promoted_count: promotedByRun.get(r.id) ?? 0 })) };
      }
      case "find_donut_run": {
        const query = String(args.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const { data, error } = await supabase
          .from("donut_runs")
          .select("id, run_name, area_name, status, total_clinics, created_at")
          .eq("created_by", userId)
          .or(`run_name.ilike.%${query}%,area_name.ilike.%${query}%`)
          .order("created_at", { ascending: false })
          .limit(8);
        if (error) return { error: error.message };
        if (!data?.length) return { matches: [], note: "No donut scrape runs matched. Ask the user to rephrase." };
        return { matches: data };
      }
      case "get_donut_run_detail": {
        const runId = Number(args.run_id);
        const { data: run } = await supabase.from("donut_runs").select("*").eq("id", runId).maybeSingle();
        if (!run) return { error: `No donut run with id ${runId}` };
        if (run.created_by !== userId) return { error: "That scrape run belongs to a different user." };
        const { data: results } = await supabase
          .from("donut_run_results")
          .select("id, clinic_name, phone, email, head_dentist, address, classification, inclusion_zone, call_status, call_notes, promoted_account_id")
          .eq("donut_run_id", runId)
          .order("clinic_name");
        return { run, results: results ?? [] };
      }
      case "update_donut_result": {
        const resultId = Number(args.result_id);
        if (!resultId) return { error: "result_id is required" };
        if (args.call_status !== undefined && !DONUT_CALL_STATUSES.includes(args.call_status)) {
          return { error: `call_status must be one of: ${DONUT_CALL_STATUSES.join(", ")}` };
        }
        const { data: before } = await supabase.from("donut_run_results").select("donut_run_id, clinic_name, promoted_account_id").eq("id", resultId).maybeSingle();
        if (!before) return { error: `No donut run result with id ${resultId}` };
        const { data: run } = await supabase.from("donut_runs").select("created_by").eq("id", before.donut_run_id).maybeSingle();
        if (run?.created_by !== userId) return { error: "That scrape run belongs to a different user." };
        const fields: ToolArgs = {};
        if (args.call_status !== undefined) fields.call_status = args.call_status;
        if (args.call_notes !== undefined) fields.call_notes = String(args.call_notes).trim() || null;
        if (!Object.keys(fields).length) return { error: "No editable fields provided" };
        if (!commit) {
          return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
        }
        const { error } = await supabase.from("donut_run_results").update(fields).eq("id", resultId);
        if (error) return { error: error.message };

        // Mirrors db/queries.py update_donut_run_result: record a pre-CRM
        // activity entry, and if this clinic is already promoted, also mirror
        // the update into the CRM account's activity timeline so the app and
        // bot always agree on what "Latest Update" shows.
        const { data: actor } = await supabase.from("users").select("name").eq("id", userId).maybeSingle();
        const actorName = actor?.name ?? "Team User";
        const summaryParts: string[] = [];
        if (fields.call_status) summaryParts.push(`Updated call status to '${fields.call_status}' by ${actorName}`);
        if (fields.call_notes) summaryParts.push(`Call Note: ${fields.call_notes}`);
        const summary = summaryParts.length ? summaryParts.join(" — ") : `Updated by ${actorName}`;
        await supabase.from("donut_result_activities").insert({
          donut_run_result_id: resultId,
          user_id: userId,
          activity_type: fields.call_status ? "Call Update" : "Note",
          summary,
          notes: fields.call_notes ?? null,
        });
        if (before.promoted_account_id) {
          await supabase.from("activities").insert({
            account_id: before.promoted_account_id,
            date: chicagoToday(),
            kairos_owner_id: userId,
            activity_type: fields.call_status ? "Call" : "Note",
            summary: `Scraper Checklist: ${summary}`,
            is_system: false,
          });
        }
        return { ok: true, clinic_name: before.clinic_name, updated: fields };
      }
      case "promote_donut_result": {
        const resultId = Number(args.result_id);
        if (!resultId) return { error: "result_id is required" };
        const { data: r } = await supabase.from("donut_run_results").select("*").eq("id", resultId).maybeSingle();
        if (!r) return { error: `No donut run result with id ${resultId}` };
        const { data: run } = await supabase.from("donut_runs").select("id, run_name, created_by").eq("id", r.donut_run_id).maybeSingle();
        if (run?.created_by !== userId) return { error: "That scrape run belongs to a different user." };
        if (r.promoted_account_id) return { ok: true, already_promoted: true, account_id: r.promoted_account_id };

        const candidate = {
          practice_name: r.clinic_name,
          practice_phone: r.phone,
          practice_email: r.email,
          website: r.website,
          city: cityFromAddress(r.address ?? ""),
        };
        const { data: existingAccounts } = await supabase
          .from("account_overview")
          .select("id, practice_name, city, practice_phone, practice_email, website");
        const duplicates = findDuplicates(candidate, existingAccounts ?? []);

        if (!commit) {
          return {
            status: "needs_confirmation",
            duplicates: duplicates.map((d) => ({
              practice_name: d.match.practice_name,
              city: d.match.city,
              reasons: d.reasons,
              confidence: d.confidence,
            })),
            note: "Staged, not saved. Relay the exact proposed change (and warning if duplicates exist) to the user and ask them to reply yes to save.",
          };
        }

        // Mirrors db/queries.py promote_donut_result: call_status maps directly
        // onto pipeline_stage (both use the same literal stage names now), and
        // Not Interested/Dead set a lost_reason so the stage is meaningful.
        const callStatus = r.call_status || "Not Called";
        const pipelineStage = callStatus === "Not Called" ? "New Lead" : callStatus;
        let lostReason: string | null = null;
        if (callStatus === "Not Interested") lostReason = "Dentist/owner not interested";
        else if (callStatus === "Dead") lostReason = "Other";

        const notesParts: string[] = [];
        if (r.notes) notesParts.push(r.notes);
        if (r.call_notes) notesParts.push(`Call Notes: ${r.call_notes}`);
        const initialEncounterSummary = notesParts.length ? notesParts.join("\n\n") : null;

        const channelId = await getDonutChannelId();
        const fields: ToolArgs = {
          practice_name: r.clinic_name,
          practice_email: r.email || null,
          practice_phone: r.phone || null,
          website: r.website || null,
          city: cityFromAddress(r.address ?? ""),
          state: stateFromAddress(r.address ?? ""),
          pipeline_stage: pipelineStage,
          source_detail: `Donut Scrape — ${r.classification || "dental clinic"}`,
          initial_encounter_summary: initialEncounterSummary,
          creation_source: "donut_scrape",
          kairos_owner_id: userId,
          creation_user_id: userId,
          donut_run_id: r.donut_run_id,
          channel_type_id: channelId,
        };
        if (lostReason) fields.lost_reason = lostReason;
        const { data: account, error } = await supabase.from("accounts").insert(fields).select("id").single();
        if (error) return { error: error.message };
        await supabase.from("donut_run_results").update({
          promoted_account_id: account.id,
          promoted_by: userId,
          promoted_at: new Date().toISOString(),
        }).eq("id", resultId);
        const { data: creator } = await supabase.from("users").select("name").eq("id", userId).maybeSingle();

        // File the pre-CRM activity log (donut_result_activities) into the CRM
        // timeline, exactly like db/queries.py promote_donut_result — never just
        // a single "created" note when the checklist has real call history.
        const { data: preActivities } = await supabase
          .from("donut_result_activities")
          .select("*")
          .eq("donut_run_result_id", resultId)
          .order("created_at", { ascending: true });
        if (preActivities?.length) {
          const rows = preActivities.map((act: ToolArgs) => {
            let actType = "Note";
            if (act.activity_type === "Scraped") actType = "Donut Visit";
            else if (act.activity_type === "Call Update" || act.activity_type === "Status Change") actType = "Call";
            return {
              account_id: account.id,
              date: act.created_at ? String(act.created_at).slice(0, 10) : chicagoToday(),
              kairos_owner_id: act.user_id ?? userId,
              activity_type: actType,
              summary: act.summary || "Pre-CRM Scraper Activity",
              is_system: false,
            };
          });
          await supabase.from("activities").insert(rows);
        } else {
          await supabase.from("activities").insert({
            account_id: account.id,
            date: chicagoToday(),
            kairos_owner_id: userId,
            activity_type: "Donut Visit",
            summary: `Imported from Donut Scrape (Run #${r.donut_run_id}) by ${creator?.name ?? "a team member"}`,
            is_system: false,
          });
        }
        return { ok: true, created: { id: account.id, practice_name: r.clinic_name } };
      }
      case "unpromote_donut_result": {
        const resultId = Number(args.result_id);
        if (!resultId) return { error: "result_id is required" };
        const { data: r } = await supabase.from("donut_run_results").select("donut_run_id, promoted_account_id, clinic_name").eq("id", resultId).maybeSingle();
        if (!r) return { error: `No donut run result with id ${resultId}` };
        const { data: run } = await supabase.from("donut_runs").select("created_by").eq("id", r.donut_run_id).maybeSingle();
        if (run?.created_by !== userId) return { error: "That scrape run belongs to a different user." };
        if (!commit) {
          return {
            status: "needs_confirmation",
            note: "Staged, not saved. This permanently deletes the linked CRM account (matches the app's unpromote button) - make that explicit in your proposal, then relay it and ask the user to reply yes to save.",
          };
        }
        const accountId = r.promoted_account_id;
        const { error } = await supabase.from("donut_run_results").update({
          promoted_account_id: null,
          promoted_by: null,
          promoted_at: null,
        }).eq("id", resultId);
        if (error) return { error: error.message };
        // Mirrors db/queries.py unpromote_donut_result: unpromoting deletes the
        // CRM account entirely, it does not just unlink it.
        if (accountId) await supabase.from("accounts").delete().eq("id", accountId);
        return { ok: true, clinic_name: r.clinic_name, deleted_account_id: accountId ?? null };
      }
      case "set_donut_run_status": {
        const runId = Number(args.run_id);
        const status = String(args.status ?? "");
        if (!["confirmed", "unsaved", "archived"].includes(status)) {
          return { error: "status must be one of: confirmed, unsaved, archived" };
        }
        const { data: run } = await supabase.from("donut_runs").select("created_by, run_name").eq("id", runId).maybeSingle();
        if (!run) return { error: `No donut run with id ${runId}` };
        if (run.created_by !== userId) return { error: "That scrape run belongs to a different user." };
        if (!commit) {
          return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
        }
        const { error } = await supabase.from("donut_runs").update({ status }).eq("id", runId);
        return error ? { error: error.message } : { ok: true, run_name: run.run_name };
      }
      case "update_donut_run_notes": {
        const runId = Number(args.run_id);
        if (!runId) return { error: "run_id is required" };
        const { data: run } = await supabase.from("donut_runs").select("created_by, run_name").eq("id", runId).maybeSingle();
        if (!run) return { error: `No donut run with id ${runId}` };
        if (run.created_by !== userId) return { error: "That scrape run belongs to a different user." };
        if (!commit) {
          return { status: "needs_confirmation", note: "Staged, not saved. Relay the exact proposed change to the user and ask them to reply yes to save." };
        }
        const { error } = await supabase.from("donut_runs").update({ map_notes: String(args.map_notes ?? "") }).eq("id", runId);
        return error ? { error: error.message } : { ok: true, run_name: run.run_name };
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  } catch (e) {
    return { error: String(e) };
  }
}

const AFFIRMATIVE_RE =
  /^\s*(y|ya|yes+|yep|yeah|yup|ok|okay|k|sure|confirm|confirmed|go ahead|sounds good|do it|save( it)?|yes please)[\s!.?]*$/i;

const PENDING_TTL_MS = 60 * 60 * 1000;

async function loadPending(userId: number, sessionId: number): Promise<StagedCall[]> {
  const { data } = await supabase
    .from("bot_pending_writes")
    .select("calls, created_at")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (!data || Date.now() - new Date(data.created_at).getTime() > PENDING_TTL_MS) return [];
  return data.calls as StagedCall[];
}

async function savePending(userId: number, sessionId: number, calls: StagedCall[]) {
  await supabase
    .from("bot_pending_writes")
    .upsert({ user_id: userId, session_id: sessionId, calls, created_at: new Date().toISOString() });
}

async function clearPending(userId: number, sessionId: number) {
  await supabase.from("bot_pending_writes").delete().eq("user_id", userId).eq("session_id", sessionId);
}

// Phone/iMessage traffic has no session UI, so it always lands in the user's
// single default "Texts" session; the dashboard passes an explicit session_id.
async function defaultSessionId(userId: number): Promise<number> {
  const { data } = await supabase
    .from("chat_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("is_default", true)
    .maybeSingle();
  if (data) return data.id;
  const { data: created } = await supabase
    .from("chat_sessions")
    .insert({ user_id: userId, title: "Texts", is_default: true })
    .select("id")
    .single();
  return created!.id;
}

async function accountName(id: number): Promise<string> {
  const { data } = await supabase.from("accounts").select("practice_name").eq("id", id).maybeSingle();
  return data?.practice_name ?? `account ${id}`;
}

// Distinct activity types the team has actually logged (excluding system-generated
// ones). Merged with the fixed ACTIVITY_TYPES so the bot knows which types already
// exist and can flag when it is coining a genuinely new one.
async function knownActivityTypes(): Promise<string[]> {
  const { data } = await supabase
    .from("activities")
    .select("activity_type")
    .not("is_system", "is", true);
  const set = new Set<string>();
  for (const r of data ?? []) {
    const t = String(r.activity_type ?? "").trim();
    if (t) set.add(t);
  }
  return [...set];
}

const ACCOUNT_SCOPED_TOOLS = new Set(["log_activity", "update_account", "create_account", "add_contact", "log_demo"]);

// Past-tense wording for settings-tool confirmation lines. Not a uniform "+d"
// suffix: "add" -> "added" (not "addd") is the case that breaks a naive rule.
const PAST_TENSE: Record<string, string> = {
  add: "added",
  create: "created",
  update: "updated",
  delete: "deleted",
  deactivate: "deactivated",
  reactivate: "reactivated",
};

async function executePending(
  userId: number,
  calls: StagedCall[],
): Promise<{ text: string; nav: NavTarget | null }> {
  const lines: string[] = [];
  let nav: NavTarget | null = null;
  for (const call of calls) {
    if (ACCOUNT_SCOPED_TOOLS.has(call.name)) {
      const result = (await execTool(call.name, call.args, userId, true)) as ToolArgs;
      const name = call.name === "create_account"
        ? (call.args.practice_name ?? "new account")
        : (await accountName(Number(call.args.account_id)));
      if (result?.error) {
        lines.push(`Could not save the change on ${name}: ${result.error}`);
      } else if (call.name === "create_account") {
        lines.push(`Saved. Created account "${name}".`);
      } else if (call.name === "log_activity") {
        let line = `Saved. ${call.args.activity_type} logged on ${name}`;
        if (call.args.next_action) {
          line += `; next action "${call.args.next_action}"`;
          if (call.args.next_action_due_date) line += ` due ${call.args.next_action_due_date}`;
        }
        lines.push(line + ".");
      } else if (call.name === "add_contact") {
        const role = call.args.role ? ` (${call.args.role})` : "";
        lines.push(`Saved. Added contact ${call.args.name}${role} to ${name}.`);
      } else if (call.name === "log_demo") {
        const status = call.args.status ?? "Scheduled";
        const when = call.args.demo_date ? ` for ${call.args.demo_date}` : "";
        lines.push(`Saved. Demo ${String(status).toLowerCase()}${when} logged on ${name}.`);
      } else {
        const fields = Object.entries(call.args)
          .filter(([k]) => k !== "account_id")
          .map(([k, v]) => `${k.replaceAll("_", " ")}: ${v}`)
          .join(", ");
        lines.push(`Saved. Updated ${name} - ${fields}.`);
      }
      if (!result?.error) {
        const navId = call.name === "create_account"
          ? Number((result as ToolArgs)?.created?.id)
          : Number(call.args.account_id);
        if (navId) nav = { page: "accounts", label: name, account_id: navId };
      }
      continue;
    }

    if (call.name === "edit_contact" || call.name === "edit_demo") {
      const isContact = call.name === "edit_contact";
      const table = isContact ? "contacts" : "demos";
      const idVal = Number(isContact ? call.args.contact_id : call.args.demo_id);
      const { data: row } = await supabase.from(table).select("account_id").eq("id", idVal).maybeSingle();
      const accountId = row?.account_id ? Number(row.account_id) : null;
      const practice = accountId ? await accountName(accountId) : "the account";
      const result = (await execTool(call.name, call.args, userId, true)) as ToolArgs;
      const entity = isContact ? "contact" : "demo";
      if (result?.error) {
        lines.push(`Could not save the change on ${practice}: ${result.error}`);
      } else if (call.args.action === "delete") {
        lines.push(`Saved. Removed a ${entity} from ${practice}.`);
      } else {
        lines.push(`Saved. Updated a ${entity} on ${practice}.`);
      }
      if (!result?.error && accountId) nav = { page: "accounts", label: practice, account_id: accountId };
      continue;
    }

    const DONUT_RESULT_TOOLS = new Set(["update_donut_result", "promote_donut_result", "unpromote_donut_result"]);
    if (DONUT_RESULT_TOOLS.has(call.name)) {
      const resultId = Number(call.args.result_id);
      const { data: before } = await supabase.from("donut_run_results").select("clinic_name, donut_run_id").eq("id", resultId).maybeSingle();
      const clinicName = before?.clinic_name ?? "that clinic";
      const result = (await execTool(call.name, call.args, userId, true)) as ToolArgs;
      if (result?.error) {
        lines.push(`Could not save the change on ${clinicName}: ${result.error}`);
      } else if (call.name === "update_donut_result") {
        const fields = Object.entries(call.args)
          .filter(([k]) => k !== "result_id")
          .map(([k, v]) => `${k.replaceAll("_", " ")}: ${v}`)
          .join(", ");
        lines.push(`Saved. Updated ${clinicName} - ${fields}.`);
      } else if (call.name === "promote_donut_result") {
        lines.push(result?.already_promoted
          ? `${clinicName} was already promoted to the CRM.`
          : `Saved. Promoted ${clinicName} to the CRM.`);
      } else {
        lines.push(`Saved. Deleted ${clinicName}'s CRM account and unlinked it (still in the scrape run).`);
      }
      if (!result?.error) nav = { page: "donut_scraper", label: clinicName, account_id: null };
      continue;
    }

    if (call.name === "set_donut_run_status") {
      const result = (await execTool(call.name, call.args, userId, true)) as ToolArgs;
      const runName = result?.run_name ?? "the run";
      if (result?.error) {
        lines.push(`Could not update ${runName}: ${result.error}`);
      } else {
        const pastStatus: Record<string, string> = { confirmed: "confirmed", unsaved: "unconfirmed", archived: "archived" };
        lines.push(`Saved. ${runName} ${pastStatus[String(call.args.status)] ?? "updated"}.`);
      }
      if (!result?.error) nav = { page: "donut_scraper", label: runName, account_id: null };
      continue;
    }

    if (call.name === "update_donut_run_notes") {
      const result = (await execTool(call.name, call.args, userId, true)) as ToolArgs;
      const runName = result?.run_name ?? "the run";
      if (result?.error) {
        lines.push(`Could not update ${runName}: ${result.error}`);
      } else {
        lines.push(`Saved. Route notes updated on ${runName}.`);
      }
      if (!result?.error) nav = { page: "donut_scraper", label: runName, account_id: null };
      continue;
    }

    // Settings-domain tools: no account context, no nav.
    const result = (await execTool(call.name, call.args, userId, true)) as ToolArgs;
    if (result?.error) {
      lines.push(`Could not save that change: ${result.error}`);
      continue;
    }
    const a = call.args;
    const past = PAST_TENSE[String(a.action ?? "")] ?? String(a.action ?? "updated");
    if (call.name === "manage_user") {
      lines.push(a.action === "add" ? `Saved. Added team member "${a.name}".` : `Saved. Team member ${past}.`);
    } else if (call.name === "manage_channel_type") {
      lines.push(a.action === "add" ? `Saved. Added channel type "${a.label}".` : `Saved. Channel type ${past}.`);
    } else if (call.name === "manage_cadence") {
      lines.push(a.action === "create" ? `Saved. Created cadence "${a.name}".` : `Saved. Cadence ${past}.`);
    } else if (call.name === "manage_cadence_step") {
      lines.push(`Saved. Cadence step ${past}.`);
    } else if (call.name === "manage_email_template") {
      lines.push(a.action === "delete" ? "Saved. Email template deleted." : `Saved. Email template "${a.name ?? ""}" ${past}.`);
    } else {
      lines.push("Saved.");
    }
  }
  return { text: lines.join("\n"), nav };
}

function systemPrompt(
  userName: string,
  users: { id: number; name: string }[],
  channelTypes: { id: number; label: string }[],
  customActivityTypes: string[],
): string {
  const usersList = users.map((u) => `${u.name} (ID: ${u.id})`).join(", ");
  const channelsList = channelTypes.map((c) => `${c.label} (ID: ${c.id})`).join(", ");
  const customTypesLine = customActivityTypes.length
    ? ` Existing custom types the team has already used: ${customActivityTypes.join(", ")}.`
    : "";
  return [
    `You are the Kairos CRM assistant, texting with ${userName}, a member of the Kairos dental-AI sales team.`,
    `Today is ${chicagoWeekday()}, ${chicagoToday()} (America/Chicago). All dates use YYYY-MM-DD. Resolve relative days like 'Friday' or 'tomorrow' from this exact date and double-check the weekday arithmetic.`,
    "You answer questions about their sales pipeline and make edits, using the provided tools. Never invent accounts or data; if a tool returns nothing, say so.",
    "Always resolve an account name with find_account before reading details or editing. If multiple accounts plausibly match, list them briefly and ask which one instead of guessing.",
    "When the user reports something that happened (a call, a visit, an email, a demo), log it with log_activity and include any new next action there. Use update_account only for direct field edits like stage or contact info.",
    "To create a new dental practice account, use the create_account tool. If the user specifies an owner or channel type by name, use the corresponding ID from the lists below. Owner defaults to the texting user if unspecified.",
    "Capture everything. These texts are field reports: extract every concrete fact and route it to the correct field instead of dumping it all into the summary. On every create_account and update_account, fill in as many fields as the message actually supports (the tool's field descriptions say what each field holds) - not just the one field the user named. Add contacts with add_contact and demos with log_demo when the message contains them. Do not narrate the fields you are setting to the user beyond the confirmation proposal.",
    "Never invent, assume, or fill a field the message gives you no basis for - empty is always better than wrong. But DO make the obvious inferences a smart teammate would: (1) Best contact - if exactly one person at the practice has been named or spoken to, that person is the best_contact; set it. (2) Decision maker - the dentist/practice owner is the decision maker; if the user reached only staff or the office manager and not the owner, set decision_maker_reached to No; if they spoke to the owner directly, Yes. (3) A person's email/phone belongs on that person's best_contact_/decision_maker_ field; a generic office address like info@ or staff@ is the practice_email/practice_phone. (4) A named competing patient-communication tool (Weave, Adit, NexHealth, etc.) goes in competitor_tool; practice-management software (Open Dental, Dentrix, etc.) goes in pms. (5) Channel type - a walk-in or drop-by is a Cold Visit or Donut Visit, a conference lead is Conference, a referral is Referral. (6) Pipeline stage - infer from sentiment: a positive first meeting where they want to keep talking is Interested, a booked demo is Demo Scheduled, a flat rejection is Closed Lost (set a lost_reason).",
    "When a field you inferred is a genuine judgement call rather than obvious, still set it, but note the assumption in one short line in your proposal so the user can correct it before saving.",
    "Writes are two-step and the system enforces it. When the user requests a change, call create_account, log_activity, or update_account right away with professionalized field values - the system stages the change instead of saving it and returns needs_confirmation. Then reply with one short proposal naming the account/action and quoting exactly what will be saved, ending with 'Reply yes to save.'",
    "Duplicate check on account creation: When calling create_account, if the tool response returns a list of duplicates, you must warn the user of the duplicates, list them briefly (with their practice name and city), and ask if they still want to save this new account.",
    "Same principle for any other new creation: log_activity (new activity_type), add_contact (new person), and adding a new user/channel type/cadence/email template all check what already exists first. If the tool response has status needs_clarification, that call is NOT staged - do not say 'reply yes to save' or anything implying it was proposed. Instead relay the similar existing entries it found and ask the user whether they meant one of those or really want a new one, then stop and wait. Once the user answers: if they picked an existing one, call the tool again with that existing value; if they confirmed a new one, call it again with the same value plus confirm_new: true - only then make the normal proposal ending in 'Reply yes to save.'",
    "You cannot save anything yourself. The system saves the staged change only when the user replies with an affirmative, and it sends its own saved-confirmation text. Never claim that something was logged, saved, or updated. If the user replies with corrections instead of yes, call the tool again with corrected values and propose again.",
    "Professionalize everything you save. The team texts in quick casual language, all caps, slang, shorthand - never store their words verbatim. Rewrite summaries, next actions, and other fields into concise, dashboard-ready CRM language: proper capitalization, full words, neutral professional tone, third person, facts preserved exactly. Show the professionalized wording in your confirmation proposal so the user approves the final text.",
    `Pipeline stages: ${PIPELINE_STAGES.join(", ")}.`,
    `Activity types: ${ACTIVITY_TYPES.join(", ")}.${customTypesLine} Prefer one of these when it fits. If the rep describes something none of them captures (for example a text message, which has no existing type), you may log a new short type in the same sentence-case style (e.g. "Text sent"). When you do, you MUST state in your proposal that you are creating a NEW activity type by that name so the rep can correct it before replying yes. Do not spin up a near-duplicate of an existing type - reuse the existing one.`,
    `Kairos Owners: ${usersList}.`,
    `Channel Types: ${channelsList}.`,
    "You can also manage settings the same way the app's Settings and Email Templates pages do: manage_user, manage_channel_type, manage_cadence, manage_cadence_step, and manage_email_template (add/create, update, deactivate/reactivate, and delete steps or templates), and edit_contact / edit_demo to update or delete an existing contact or demo (add_contact and log_demo remain the tools for adding new ones). Call list_settings first whenever you need to look up a cadence, step, template, or an inactive user/channel ID by name - the lists above only carry active users and channel types.",
    "Safety limits on this settings surface: you may deactivate but must NEVER delete an entire account directly - if asked to delete an account outright, say that has to be done in the app and do not call any tool. The one exception is unpromote_donut_result, which deletes the linked CRM account by design (same as the app's unpromote button) - that is allowed, but always say explicitly in the proposal that the account will be deleted. You may delete cadence steps, email templates, contacts, and demos, but only after the normal 'Reply yes to save' confirmation like any other write.",
    `Email template category must be one of: ${TEMPLATE_CATEGORIES.join(", ")}. Cadence step channel should be one of: ${CADENCE_CHANNELS.join(", ")} (a custom channel name is allowed, like the app). The same two-step confirm and near-duplicate pushback rules described above apply to all of these tools.`,
    "You can also work the Donut Scraper: scrape runs are private per user, exactly like accounts - only show/edit runs owned by the texting user. Use list_donut_runs or find_donut_run to resolve a run by name/area before get_donut_run_detail, and get_donut_run_detail to resolve a clinic to a result_id before update_donut_result / promote_donut_result / unpromote_donut_result. update_donut_result logs a call outcome exactly like calling through the app's checklist, and also mirrors onto the account's CRM timeline if that clinic is already promoted. promote_donut_result creates a standalone CRM account tagged to the run, maps the clinic's call_status onto pipeline_stage (Not Called becomes New Lead, Not Interested/Dead set a lost_reason), carries over its call notes and full pre-CRM activity history, and checks for duplicates first - warn the user of any duplicates the same way create_account does. unpromote_donut_result deletes that CRM account entirely, not just unlinks it - always say so plainly in the proposal. set_donut_run_status confirms/unconfirms/archives a whole run (separate from promoting individual clinics). update_donut_run_notes replaces the free-text 'Route Notes' box on a run's Route Map tab (route/visit planning notes, not a per-clinic field) - get_donut_run_detail returns the current value as run.map_notes if the user wants to append rather than replace. You cannot start a brand-new scrape (drawing an area and running Google Places search) from texts yet - if asked, say that has to be started from the Donut Scraper page in the app.",
    `Donut call statuses: ${DONUT_CALL_STATUSES.join(", ")}.`,
    "You are texting: reply in plain conversational text. No markdown, no asterisks, no emojis, no headers. Keep replies compact - short lines, one item per line for lists. Round nothing; quote fields as stored.",
  ].join("\n");
}

// deno-lint-ignore no-explicit-any
type Content = { role: string; parts: any[] };

async function geminiRequest(model: string, sys: string, contents: Content[]) {
  const reqBody = {
    system_instruction: { parts: [{ text: sys }] },
    contents,
    tools: [{ function_declarations: TOOL_DECLARATIONS }],
    generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
  };
  // console.log("Gemini Request Payload:", JSON.stringify(reqBody, null, 2));
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(reqBody),
    },
  );
  if (!resp.ok) {
    console.error("Gemini HTTP Error:", resp.status, await resp.clone().text());
  } else {
    const clone = await resp.clone().json();
    console.log("Gemini Response Payload:", JSON.stringify(clone, null, 2));
  }
  return resp;
}

async function runAgent(
  userId: number,
  userName: string,
  contents: Content[],
  users: { id: number; name: string }[],
  channelTypes: { id: number; label: string }[],
  customActivityTypes: string[],
): Promise<{ text: string; staged: StagedCall[] }> {
  const sys = systemPrompt(userName, users, channelTypes, customActivityTypes);
  let model = GEMINI_MODEL;
  let emptyRetries = 0;
  const staged: StagedCall[] = [];
  for (let step = 0; step < 8; step++) {
    const resp = await geminiRequest(model, sys, contents);
    if (!resp.ok) {
      if (model !== GEMINI_FALLBACK_MODEL && (resp.status === 429 || resp.status >= 500)) {
        model = GEMINI_FALLBACK_MODEL;
        continue;
      }
      const detail = await resp.text();
      console.error(`Gemini error ${resp.status}: ${detail.slice(0, 500)}`);
      return {
        text: "Sorry, the assistant is unavailable right now (model error). Try again in a minute.",
        staged: [],
      };
    }
    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    // deno-lint-ignore no-explicit-any
    const calls = parts.filter((p: any) => p.functionCall);
    if (!calls.length) {
      // deno-lint-ignore no-explicit-any
      const text = parts.map((p: any) => (p.thought ? "" : p.text ?? "")).join("").trim();
      if (text) return { text, staged };
      // Gemini intermittently returns a candidate with no text and no tool
      // call; retry, then switch models before giving up.
      console.error(`Empty Gemini response (finishReason=${data.candidates?.[0]?.finishReason ?? "none"})`);
      emptyRetries += 1;
      if (emptyRetries === 2 && model !== GEMINI_FALLBACK_MODEL) model = GEMINI_FALLBACK_MODEL;
      if (emptyRetries <= 3) continue;
      return { text: "Sorry, I did not get a response. Try rephrasing.", staged };
    }
    contents.push({ role: "model", parts });
    const responses = await Promise.all(
      // deno-lint-ignore no-explicit-any
      calls.map(async (c: any) => {
        const name = c.functionCall.name;
        const args = c.functionCall.args ?? {};
        const result = (await execTool(name, args, userId)) as ToolArgs;
        if (WRITE_TOOLS.has(name) && result?.status === "needs_confirmation") {
          const entry = { name, args };
          if (!staged.some((s) => JSON.stringify(s) === JSON.stringify(entry))) staged.push(entry);
        }
        return { functionResponse: { name, response: { result } } };
      }),
    );
    contents.push({ role: "user", parts: responses });
  }
  return { text: "Sorry, that request took too many steps. Try something more specific.", staged };
}

function sendblueHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": SENDBLUE_API_KEY_ID,
    "sb-api-secret-key": SENDBLUE_API_SECRET_KEY,
  };
}

async function sendText(number: string, content: string, fromNumber: string) {
  const body: Record<string, unknown> = { number, content };
  // SendBlue rejects sends whose from_number is not an authorized line on the
  // account ("This from number is not authorized on this account"). The inbound
  // webhook's sendblue_number is the line the message arrived on and is always
  // authorized; the env var is a fallback for non-webhook callers.
  const from = fromNumber || SENDBLUE_FROM_NUMBER;
  if (from) body.from_number = from;
  const resp = await fetch("https://api.sendblue.com/api/send-message", {
    method: "POST",
    headers: sendblueHeaders(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error(`SendBlue send failed ${resp.status} (from=${from || "unset"}): ${(await resp.text()).slice(0, 300)}`);
  }
}

function sendTypingIndicator(number: string, fromNumber: string) {
  if (!SENDBLUE_API_KEY_ID) return;
  fetch("https://api.sendblue.com/api/send-typing-indicator", {
    method: "POST",
    headers: sendblueHeaders(),
    body: JSON.stringify({ number, from_number: fromNumber || SENDBLUE_FROM_NUMBER }),
  }).catch(() => {});
}

async function loadHistory(sessionId: number): Promise<Content[]> {
  // A session is already a bounded conversation, so scope context to it. Order
  // by id, not created_at: the user/model pair is inserted in one statement and
  // can share a timestamp, which scrambles the turn order.
  const { data } = await supabase
    .from("bot_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("id", { ascending: false })
    .limit(12);
  return (data ?? []).reverse().map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
}

async function saveExchange(userId: number, sessionId: number, userText: string, reply: string) {
  await supabase.from("bot_messages").insert([
    { user_id: userId, session_id: sessionId, role: "user", content: userText },
    { user_id: userId, session_id: sessionId, role: "model", content: reply },
  ]);
  const patch: Record<string, unknown> = { last_message_at: new Date().toISOString() };
  const { data: sess } = await supabase.from("chat_sessions").select("title").eq("id", sessionId).maybeSingle();
  if (sess && !sess.title) {
    patch.title = userText.length > 40 ? userText.slice(0, 40).trim() + "..." : userText.trim();
  }
  await supabase.from("chat_sessions").update(patch).eq("id", sessionId);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!BOT_WEBHOOK_TOKEN || url.searchParams.get("token") !== BOT_WEBHOOK_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("ok");

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (payload.is_outbound === true) return new Response("ignored outbound");
  const fromNumber = String(payload.from_number ?? "");
  const content = String(payload.content ?? "").trim().slice(0, 2000);
  if ((!fromNumber && !payload.user_id) || !content) return new Response("ignored empty");

  const { data: users } = await supabase.from("users").select("id, name, phone").eq("active", true);
  const { data: channelTypes } = await supabase.from("channel_types").select("id, label").eq("active", true);
  const customActivityTypes = (await knownActivityTypes()).filter(
    (t) => !ACTIVITY_TYPES.some((f) => f.toLowerCase() === t.toLowerCase()),
  );
  
  let user = null;
  if (payload.user_id) {
    user = (users ?? []).find((u) => u.id === Number(payload.user_id));
  } else {
    user = (users ?? []).find((u) => u.phone && phoneDigits(u.phone) === phoneDigits(fromNumber));
  }
  if (!user) {
    console.log(`Ignored message from unknown number ${fromNumber}`);
    return new Response("ignored unknown sender");
  }

  const debug = url.searchParams.get("debug") === "1";
  // sendblue_number is the authorized line the message arrived on; to_number
  // from the real webhook is not accepted as a from_number by the send API.
  const lineNumber = String(payload.sendblue_number ?? payload.to_number ?? "");
  sendTypingIndicator(fromNumber, lineNumber);
  const sender = user;
  // The dashboard passes an explicit chat session; phone traffic has none and
  // falls back to the user's default "Texts" session.
  const sessionId = payload.session_id ? Number(payload.session_id) : await defaultSessionId(sender.id);

  async function respond(reply: string, nav: NavTarget | null = null): Promise<Response> {
    if (debug) {
      await saveExchange(sender.id, sessionId, content, reply);
      return new Response(JSON.stringify({ user: sender.name, reply, nav }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    await Promise.all([sendText(fromNumber, reply, lineNumber), saveExchange(sender.id, sessionId, content, reply)]);
    return new Response("ok");
  }

  // The confirmation gate lives here, not in the model: an affirmative reply
  // executes the staged writes deterministically; anything else discards them
  // and falls through to the model, which can re-propose with corrections.
  const pending = await loadPending(sender.id, sessionId);
  if (pending.length && AFFIRMATIVE_RE.test(content)) {
    const { text, nav } = await executePending(sender.id, pending);
    await clearPending(sender.id, sessionId);
    return await respond(text, nav);
  }
  if (pending.length) await clearPending(sender.id, sessionId);

  const contents = await loadHistory(sessionId);
  contents.push({ role: "user", parts: [{ text: content }] });
  let { text: reply, staged } = await runAgent(sender.id, sender.name, contents, users ?? [], channelTypes ?? [], customActivityTypes);

  // The model sometimes writes proposal text without making the tool call, so
  // there is nothing staged and the user's yes dead-ends. Detect that and force
  // one retry turn that must produce the staged call.
  if (!staged.length && /reply yes to save/i.test(reply)) {
    contents.push({ role: "model", parts: [{ text: reply }] });
    contents.push({
      role: "user",
      parts: [{
        text: "SYSTEM: Your proposal was not staged because you did not call the tool. Call the matching write tool (log_activity, update_account, create_account, add_contact, or log_demo) now with exactly the values you proposed, then repeat the proposal.",
      }],
    });
    const retry = await runAgent(sender.id, sender.name, contents, users ?? [], channelTypes ?? [], customActivityTypes);
    if (retry.staged.length) {
      reply = retry.text;
      staged = retry.staged;
    } else {
      reply = "Something went wrong staging that change - please resend the request.";
    }
  }

  if (staged.length) await savePending(sender.id, sessionId, staged);
  return await respond(reply);
});
