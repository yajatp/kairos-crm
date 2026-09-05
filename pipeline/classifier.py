from __future__ import annotations

import difflib

# Known DSO brand names — fuzzy-matched against clinic name at query time.
# This list is best-effort; add entries as you encounter unmatched DSOs in the field.
_DSO_NAMES = [
    "Heartland Dental",
    "Aspen Dental",
    "Pacific Dental Services",
    "Smile Brands",
    "Dental Care Alliance",
    "Western Dental",
    "Affordable Care",
    "Dental Depot",
    "ClearChoice",
    "Clear Choice",
    "Bright Now Dental",
    "Brident Dental",
    "Comfort Dental",
    "Castle Dental",
    "Midwest Dental",
    "Great Expressions Dental",
    "Ideal Dental",
    "Tend Dental",
    "Tend",
    "Forman Dental",
    "Dental Works",
    "DentalWorks",
    "Kool Smiles",
    "Jefferson Dental",
    "Gentle Dental",
    "Coast Dental",
    "Smilist Dental",
    "Guardian Dentistry Partners",
    "Mortenson Dental Partners",
    "Dental Express",
    "OrthoSynetics",
    "MB2 Dental",
    "ProHEALTH Dental",
    "Sage Dental",
    "North American Dental Group",
    "NADG",
    "Dental Specialty Associates",
    "Tend",
]

_FUZZY_THRESHOLD = 0.82


def _is_dso(name: str) -> bool:
    n = name.lower().strip()
    for dso in _DSO_NAMES:
        d = dso.lower().strip()
        if d in n or n in d:
            return True
        if difflib.SequenceMatcher(None, n, d).ratio() >= _FUZZY_THRESHOLD:
            return True
    return False


def classify_clinic(name: str, num_locations: int = 1) -> str:
    """
    Returns 'DSO' | 'chain' | 'independent' | 'unknown'.

    Best-effort heuristic — NOT verified data. DSO detection uses fuzzy name
    matching against a curated list. Chain detection requires num_locations > 1,
    which the pipeline currently always sets to 1 (multi-location detection is
    not yet implemented), so 'chain' will not appear until that signal is wired up.
    """
    if _is_dso(name):
        return "DSO"
    if num_locations > 1:
        return "chain"
    if num_locations == 1:
        return "independent"
    return "unknown"
