"""Duplicate detection for accounts, on manual entry and CSV import.

Adapted from kairosintern's pipeline/dedup.py, which merges same-practice
Google Places listings using identity signals (normalized phone, website
domain, stripped name core). The CRM problem differs: most rows have no Place
ID (Apollo, conference, referral leads), so matching is exact on
phone/email/website plus fuzzy name-within-city. Matches are surfaced as
warnings for the user to judge — never auto-blocked or auto-merged.
"""

from __future__ import annotations

import re

from rapidfuzz import fuzz

# Starting default per Yajat, same spirit as the Donut Scraper's 0.85 IoU
# threshold: loose enough for "Sunshine Dentistry" vs "Sunshine Dental",
# strict enough not to flag unrelated practices sharing a common word.
# Flag to Yajat if it misbehaves in real usage — do not silently adjust.
NAME_SIMILARITY_THRESHOLD = 85

_GENERIC_NAME_WORDS = re.compile(
    r"\b(?:dental|dentistry|orthodontics|orthodontist|endodontics|pediatric|"
    r"family|center|centre|clinic|associates|group|partners|specialists|"
    r"surgery|implant|smile|smiles|braces|oral|cosmetic|care|of|the|and)\b",
    re.IGNORECASE,
)


def normalize_phone(phone) -> str:
    digits = re.sub(r"\D", "", str(phone or ""))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits[:10] if len(digits) >= 10 else digits


def normalize_email(email) -> str:
    return str(email or "").strip().lower()


def normalize_domain(url) -> str:
    s = str(url or "").strip().lower()
    if not s:
        return ""
    s = re.sub(r"^https?://", "", s).strip("/")
    return s.split("/")[0].removeprefix("www.")


def _norm_city(city) -> str:
    s = str(city or "").strip().lower()
    # Remove standard 2-letter state codes at the end (e.g. "dallas, tx", "dallas tx")
    s = re.sub(r"[,\s]+\b[a-z]{2}\b$", "", s)
    s = s.removesuffix("texas").strip()
    return re.sub(r"\s+", " ", s)



def _norm_name(name) -> str:
    s = re.sub(r"[^a-z0-9\s]", " ", str(name or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def _name_core(name) -> str:
    s = _GENERIC_NAME_WORDS.sub(" ", _norm_name(name))
    return re.sub(r"\s+", " ", s).strip()


def find_duplicates(
    candidate: dict,
    existing: list[dict],
    threshold: int = NAME_SIMILARITY_THRESHOLD,
) -> list[dict]:
    """Compare one candidate account against existing rows.

    Returns [{"match": row, "reasons": [...], "confidence": "exact"|"fuzzy"}],
    exact matches first. Rows sharing the candidate's id are skipped so edits
    don't flag themselves.
    """
    c_phone = normalize_phone(candidate.get("practice_phone"))
    c_email = normalize_email(candidate.get("practice_email"))
    c_domain = normalize_domain(candidate.get("website"))
    c_city = _norm_city(candidate.get("city"))
    c_name = _norm_name(candidate.get("practice_name"))
    c_core = _name_core(candidate.get("practice_name"))

    results = []
    for row in existing:
        if candidate.get("id") is not None and row.get("id") == candidate.get("id"):
            continue

        reasons = []
        if c_phone and len(c_phone) >= 10 and c_phone == normalize_phone(row.get("practice_phone")):
            reasons.append("Same phone number")
        if c_email and c_email == normalize_email(row.get("practice_email")):
            reasons.append("Same email")
        if c_domain and c_domain == normalize_domain(row.get("website")):
            reasons.append("Same website")

        confidence = "exact" if reasons else ""

        if not reasons and c_name and c_city and c_city == _norm_city(row.get("city")):
            r_name = _norm_name(row.get("practice_name"))
            r_core = _name_core(row.get("practice_name"))
            score = fuzz.token_sort_ratio(c_name, r_name)
            core_match = len(c_core) >= 4 and c_core == r_core
            if score >= threshold or core_match:
                reasons.append(f"Similar name in same city ({score:.0f}% match)")
                confidence = "fuzzy"

        if reasons:
            results.append({"match": row, "reasons": reasons, "confidence": confidence})

    results.sort(key=lambda r: r["confidence"] != "exact")
    return results


def find_batch_duplicates(rows: list[dict], existing: list[dict]) -> dict[int, list[dict]]:
    """Check every import row against existing accounts AND earlier rows in the
    same batch. Returns {row_index: matches}; batch-internal matches carry a
    "batch_row" key with the other row's index instead of a DB id.
    """
    flagged: dict[int, list[dict]] = {}
    for i, row in enumerate(rows):
        matches = find_duplicates(row, existing)
        for j in range(i):
            for m in find_duplicates(row, [rows[j]]):
                m["batch_row"] = j
                matches.append(m)
        if matches:
            flagged[i] = matches
    return flagged
