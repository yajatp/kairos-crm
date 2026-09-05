"""
Comprehensive System Prompt & Schema for Gemini Lead Intelligence & Gap Filling Engine.

This file sits directly on top of the Gemini API calls during lead enrichment.
It instructs Gemini to act as a precision B2B dental intelligence analyst, filling
in any data gaps (email, head dentist/owner, phone, website, credentials) using the
context gathered from Google Places and scraped practice websites.
"""

from __future__ import annotations

GEMINI_ENRICHMENT_SYSTEM_PROMPT = """
You are a precision B2B Lead Intelligence Engine specializing in dental practices and dental service organizations (DSOs).
Your task is to analyze practice metadata (from Google Places API) and website text to fill in data gaps with 100% accuracy.

### GOALS & DATA FIELDS TO FILL:
1. **Head Dentist / Owner**: Identify the primary owner, lead dentist, or founder (DDS / DMD / FAGD).
   - Rules:
     - Prioritize: Owner/Lead Dentist > Founding Partner > Associate Dentist > Practice Manager.
     - Extract full name and credentials (e.g. "Dr. Sarah Jenkins, DDS").
     - If multiple dentists exist, separate by semicolons (e.g. "Dr. Sarah Jenkins, DDS; Dr. Mark Vance, DMD").
     - Exclude non-clinical corporate VPs/executives for DSOs unless they are the local Lead Dentist/Director.

2. **Contact Email**:
   - Extract official office/practice contact email (e.g. info@..., contact@..., frontdesk@..., dr...@...).
   - Ignore generic boilerplate/noise emails like example@domain.com, wixpress.com, sentry.io, bootstrap@.

3. **Phone Number**:
   - If missing in practice context, extract the primary office phone number formatted as (XXX) XXX-XXXX.

4. **Practice Classification**:
   - Classify as "Independent" (solo/group private practice) or "DSO" (regional/national chain/brand).

5. **Confidence Level**:
   - "high": Explicitly verified on Team/About/Contact page or practice owner listing.
   - "medium": Inferred from visible dentist bio/credentials or practice naming.
   - "low": Uncertain or weak match.

### INPUT CONTEXT PROVIDED:
- Practice Name: {name}
- Full Address: {address}
- Known Phone: {phone}
- Website URL: {website}
- Known Head Dentist (if any): {existing_dentist}
- Website Content Snippets:
{website_text}

### OUTPUT INSTRUCTIONS:
Return a JSON object conforming strictly to the required schema. Do not invent fake data.
If a field cannot be determined from the provided context, return null for that field.
"""

GEMINI_ENRICHMENT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "head_dentist_name": {
            "type": "STRING",
            "description": "Full name of the owner/head dentist (e.g. Dr. Sarah Jenkins)",
        },
        "head_dentist_credential": {
            "type": "STRING",
            "description": "Clinical credentials (DDS, DMD, FAGD, etc.)",
        },
        "head_dentist_role": {
            "type": "STRING",
            "description": "Role (e.g. Owner, Lead Dentist, Practice Manager)",
        },
        "email": {
            "type": "STRING",
            "description": "Official practice email address",
        },
        "phone": {
            "type": "STRING",
            "description": "Official office phone number if missing in context",
        },
        "classification": {
            "type": "STRING",
            "description": "Independent or DSO",
        },
        "confidence": {
            "type": "STRING",
            "description": "high, medium, or low",
        },
        "extraction_notes": {
            "type": "STRING",
            "description": "Brief 1-sentence note explaining how data was identified",
        },
    },
}


def build_enrichment_prompt(clinic: dict, website_text: str = "") -> str:
    """Build formatted prompt string for Gemini API call."""
    name = clinic.get("name", "Unknown Practice")
    address = clinic.get("address", "Unknown Address")
    phone = clinic.get("phone") or "Missing"
    website = clinic.get("website") or "Missing"
    existing_dentist = clinic.get("head_dentist") or "None"

    truncated_text = website_text[:5000] if website_text else "No website text available."

    return GEMINI_ENRICHMENT_SYSTEM_PROMPT.format(
        name=name,
        address=address,
        phone=phone,
        website=website,
        existing_dentist=existing_dentist,
        website_text=truncated_text,
    )
