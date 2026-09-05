"""Fixed application-level enums. users and channel_types are admin-editable
tables instead (spec section 4) — everything here stays hardcoded for v1."""

PIPELINE_STAGES = [
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
]

CLOSED_STAGES = {"Closed Won", "Closed Lost", "Nurture Later", "Not Interested", "Dead"}

ACTIVITY_TYPES = [
    "In-person visit",
    "Phone call",
    "Email sent",
    "Demo scheduled",
    "Demo completed",
    "Follow-up completed",
    "Pricing/onboarding info sent",
    "No response",
    "Other",
]

LOST_REASONS = [
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
]

COMPETITOR_TOOLS = [
    "Weave",
    "Adit",
    "Dentina",
    "NexHealth",
    "Mango",
    "Dental Intelligence",
    "Patient Prism",
    "None / front desk only",
    "Unknown",
]

DEMO_STATUSES = ["Scheduled", "Completed", "No-show", "Rescheduled"]

DECISION_MAKER_REACHED = ["Unknown", "Yes", "No"]

TEMPLATE_CATEGORIES = [
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
]

CADENCE_CHANNELS = ["Phone call", "Email", "Text", "In-person visit"]

STALE_DAYS = 14
WAITING_STALE_DAYS = 7

DONUT_CALL_STATUSES = [
    "Not Called",
    "No Answer",
    "Left Voicemail",
    "Interested",
    "Not Interested",
    "Dead",
    "Call Back Later",
]

CREATION_SOURCES = ["manual", "chatbot", "donut_scrape", "csv_import"]
