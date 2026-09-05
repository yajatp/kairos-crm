from __future__ import annotations

import logging
import math
import time
from typing import Callable

import requests

logger = logging.getLogger(__name__)

PLACES_BASE = "https://places.googleapis.com/v1"

_MAX_RESULTS = 20
_SQRT2 = math.sqrt(2.0)

# Adaptive grid. Each region is a square searched by one Nearby Search circle that
# circumscribes it (radius = half_side * sqrt2), so the whole square is covered. A
# square that comes back saturated (returns _MAX_RESULTS -> more may exist past the
# cap) is split into four and recursed; sparse areas resolve in a single call while
# dense clusters subdivide only where needed, and nothing is silently dropped.
_TOP_HALF_SIDE_M = 1800.0   # top square ~3.6 km/side (circumscribing circle ~2.5 km)
_MIN_HALF_SIDE_M = 300.0    # stop subdividing below this (leaf circle ~0.42 km)

CIRCLE_WARNING_THRESHOLD = 200

BUFFER_FLOOR_MI = 0.2
BUFFER_CAP_MI = 0.5
_BUFFER_SCALE_K = 0.08


def adaptive_buffer_miles(area_sqmi: float) -> float:
    """Suggested buffer (mi) to catch clinics just outside a drawn area.

    Edge/hand-draw uncertainty is roughly fixed, so we floor at 0.2 mi even for
    tiny areas. Larger areas are drawn more coarsely, so we add a mild
    sqrt(area) term — k=0.08 expands a square's area by ~30% (vs. the old
    0.2 coefficient which nearly doubled it). Capped at 0.5 mi: past a short
    drive a clinic is no longer "just outside" the target.
    """
    raw = max(BUFFER_FLOOR_MI, _BUFFER_SCALE_K * math.sqrt(max(area_sqmi, 0.0)))
    return round(min(BUFFER_CAP_MI, raw), 1)


def _meters_to_lat_deg(meters: float) -> float:
    return meters / 111320.0


def _meters_to_lng_deg(meters: float, lat: float) -> float:
    cos_lat = math.cos(math.radians(lat))
    return meters / (111320.0 * max(cos_lat, 1e-9))


def compute_bounding_box(coords: list[list[float]]) -> tuple[float, float, float, float]:
    """coords: [[lng, lat], ...] GeoJSON order. Returns (min_lat, max_lat, min_lng, max_lng)."""
    lats = [c[1] for c in coords]
    lngs = [c[0] for c in coords]
    return min(lats), max(lats), min(lngs), max(lngs)


def _expand_bbox(
    min_lat: float, max_lat: float, min_lng: float, max_lng: float, buffer_miles: float,
) -> tuple[float, float, float, float]:
    """Grow the bounding box by buffer_miles on every side so the grid actually
    searches the buffer zone (filter_by_polygon keeps clinics within this margin)."""
    if buffer_miles <= 0:
        return min_lat, max_lat, min_lng, max_lng
    dlat = buffer_miles / 69.0
    center_lat = (min_lat + max_lat) / 2.0
    dlng = buffer_miles / (69.0 * max(math.cos(math.radians(center_lat)), 1e-9))
    return min_lat - dlat, max_lat + dlat, min_lng - dlng, max_lng + dlng


def _buffered_polygon(polygon_coords: list[list[float]], buffer_miles: float):
    """Shapely polygon (lng, lat) expanded by buffer_miles, mirroring
    filter_by_polygon's 1 mi ~= 1/69 deg buffer. Returns None if shapely is
    unavailable, in which case callers fall back to searching the whole bbox."""
    try:
        from shapely.geometry import Polygon
    except ImportError:
        return None
    try:
        poly = Polygon([(c[0], c[1]) for c in polygon_coords])
        if buffer_miles > 0:
            poly = poly.buffer(buffer_miles / 69.0)
        return poly if poly.is_valid else poly.buffer(0)
    except Exception:
        return None


def _square_touches_polygon(center_lat: float, center_lng: float, half_side_m: float, poly) -> bool:
    """True if the square of side 2*half_side centered here intersects the polygon.
    Squares tile the whole bbox, so any polygon area is covered by some square; a
    square that misses the polygon contributes nothing and is safely skipped."""
    if poly is None:
        return True
    from shapely.geometry import box

    dlat = _meters_to_lat_deg(half_side_m)
    dlng = _meters_to_lng_deg(half_side_m, center_lat)
    return poly.intersects(
        box(center_lng - dlng, center_lat - dlat, center_lng + dlng, center_lat + dlat)
    )


def _top_square_centers(
    min_lat: float, max_lat: float, min_lng: float, max_lng: float, half_side_m: float,
) -> list[tuple[float, float]]:
    """Centers of the top-level squares (side 2*half_side) tiling the bbox with no gaps."""
    center_lat = (min_lat + max_lat) / 2.0
    dlat = _meters_to_lat_deg(half_side_m)
    dlng = _meters_to_lng_deg(half_side_m, center_lat)
    span_lat_m = max((max_lat - min_lat) * 111320.0, 1.0)
    span_lng_m = max((max_lng - min_lng) * 111320.0 * math.cos(math.radians(center_lat)), 1.0)
    n_rows = max(1, math.ceil(span_lat_m / (2 * half_side_m)))
    n_cols = max(1, math.ceil(span_lng_m / (2 * half_side_m)))

    centers: list[tuple[float, float]] = []
    for r in range(n_rows):
        lat = min_lat + dlat + r * 2 * dlat
        for c in range(n_cols):
            centers.append((lat, min_lng + dlng + c * 2 * dlng))
    return centers


def estimate_circle_count(
    coords: list[list[float]], buffer_miles: float = 0.0,
) -> int:
    """Lower-bound estimate of Nearby Search calls for the pre-run cost preview:
    the count of top-level squares whose area touches the polygon. The live run
    adds calls only where a square saturates and subdivides, so this is a floor."""
    min_lat, max_lat, min_lng, max_lng = compute_bounding_box(coords)
    min_lat, max_lat, min_lng, max_lng = _expand_bbox(min_lat, max_lat, min_lng, max_lng, buffer_miles)
    centers = _top_square_centers(min_lat, max_lat, min_lng, max_lng, _TOP_HALF_SIDE_M)
    poly = _buffered_polygon(coords, buffer_miles)
    if poly is None:
        return len(centers)
    return sum(
        1 for (lat, lng) in centers
        if _square_touches_polygon(lat, lng, _TOP_HALF_SIDE_M, poly)
    )


def _nearby_search_page(
    lat: float, lng: float, radius_m: float, api_key: str,
) -> dict:
    body: dict = {
        "locationRestriction": {
            "circle": {
                "center": {"latitude": lat, "longitude": lng},
                "radius": float(radius_m),
            }
        },
        "includedTypes": ["dentist"],
        "maxResultCount": _MAX_RESULTS,
    }

    resp = requests.post(
        f"{PLACES_BASE}/places:searchNearby",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
            # Pull contact + hours fields here so we don't need a per-clinic
            # Place Details call afterward (one search call returns everything).
            "X-Goog-FieldMask": (
                "places.id,places.displayName,places.formattedAddress,"
                "places.location,places.businessStatus,places.primaryType,"
                "places.nationalPhoneNumber,places.websiteUri,"
                "places.regularOpeningHours"
            ),
        },
        json=body,
        timeout=15,
    )
    return resp.json()


def _parse_weekday_hours(opening_hours: dict) -> dict[str, str]:
    hours_by_day: dict[str, str] = {}
    for desc in opening_hours.get("weekdayDescriptions", []):
        if ":" in desc:
            day, times = desc.split(":", 1)
            hours_by_day[day.strip()] = times.strip()
    return hours_by_day


def _places_from_response(data: dict) -> tuple[list[dict], int]:
    """Parse a Nearby Search response into clinic dicts. Returns (clinics, raw_count)
    where raw_count is the number of places the API returned before our dentist/closed
    filtering -- raw_count == _MAX_RESULTS signals the cap was hit (subdivide)."""
    places = data.get("places", [])
    results: list[dict] = []
    for place in places:
        if place.get("businessStatus") == "CLOSED_PERMANENTLY":
            continue
        if place.get("primaryType") != "dentist":
            continue
        loc = place.get("location", {})
        results.append({
            "place_id": place["id"],
            "name": place.get("displayName", {}).get("text", ""),
            "address": place.get("formattedAddress", ""),
            "phone": place.get("nationalPhoneNumber", ""),
            "website": place.get("websiteUri", ""),
            "lat": loc.get("latitude"),
            "lng": loc.get("longitude"),
            "hours_by_day": _parse_weekday_hours(place.get("regularOpeningHours", {})),
        })
    return results, len(places)


def _search_region(
    center_lat: float,
    center_lng: float,
    half_side_m: float,
    api_key: str,
    poly,
    seen: dict[str, dict],
    stats: dict[str, int],
) -> None:
    """Search one square; if it saturates, split into four and recurse. Squares
    outside the polygon are skipped without a call. Dedups into ``seen`` by place ID."""
    if not _square_touches_polygon(center_lat, center_lng, half_side_m, poly):
        return

    data = _nearby_search_page(center_lat, center_lng, half_side_m * _SQRT2, api_key)
    stats["calls"] += 1
    time.sleep(0.1)
    if "error" in data:
        logger.warning(
            "Nearby Search error at (%.5f,%.5f): %s", center_lat, center_lng, data["error"]
        )
        return

    clinics, raw_count = _places_from_response(data)
    for clinic in clinics:
        pid = clinic.get("place_id")
        if pid and pid not in seen:
            seen[pid] = clinic

    if raw_count >= _MAX_RESULTS and half_side_m > _MIN_HALF_SIDE_M:
        h = half_side_m / 2.0
        dlat = _meters_to_lat_deg(h)
        dlng = _meters_to_lng_deg(h, center_lat)
        for sy in (-1, 1):
            for sx in (-1, 1):
                _search_region(
                    center_lat + sy * dlat, center_lng + sx * dlng,
                    h, api_key, poly, seen, stats,
                )


def get_place_details_for_donut(place_id: str, api_key: str) -> dict:
    try:
        resp = requests.get(
            f"{PLACES_BASE}/places/{place_id}",
            headers={
                "X-Goog-Api-Key": api_key,
                "X-Goog-FieldMask": (
                    "id,displayName,formattedAddress,nationalPhoneNumber,"
                    "websiteUri,regularOpeningHours,location"
                ),
            },
            timeout=10,
        )
        time.sleep(0.2)
        data = resp.json()

        if "error" in data:
            logger.warning("Place details failed for %s: %s", place_id, data["error"])
            return {}

        loc = data.get("location", {})

        return {
            "place_id": place_id,
            "name": data.get("displayName", {}).get("text", ""),
            "address": data.get("formattedAddress", ""),
            "phone": data.get("nationalPhoneNumber", ""),
            "website": data.get("websiteUri", ""),
            "lat": loc.get("latitude"),
            "lng": loc.get("longitude"),
            "hours_by_day": _parse_weekday_hours(data.get("regularOpeningHours", {})),
        }
    except Exception as e:
        logger.warning("Error fetching details for %s: %s", place_id, e)
        return {}


def compute_polygon_iou(coords1: list[list[float]], coords2: list[list[float]]) -> float:
    """Intersection-over-union of two polygons. Coords in [[lng, lat], ...] GeoJSON format."""
    try:
        from shapely.geometry import Polygon

        p1 = Polygon([(c[0], c[1]) for c in coords1])
        p2 = Polygon([(c[0], c[1]) for c in coords2])
        if not p1.is_valid or not p2.is_valid:
            return 0.0
        intersection = p1.intersection(p2).area
        union = p1.union(p2).area
        return intersection / union if union > 0 else 0.0
    except Exception:
        return 0.0


def compute_polygon_area_sqmi(coords: list[list[float]]) -> float:
    """Approximate the area of the polygon in square miles."""
    try:
        from shapely.geometry import Polygon
        poly = Polygon([(c[0], c[1]) for c in coords])
        area_sq_deg = poly.area
        # Approx: 1 deg lat = 69 miles, 1 deg lng = 69 * cos(lat) miles
        centroid_lat = poly.centroid.y
        miles_per_deg_lng = 69.0 * math.cos(math.radians(centroid_lat))
        miles_per_deg_lat = 69.0
        # Area in sq miles = area_sq_deg * (miles_per_deg_lat * miles_per_deg_lng)
        return area_sq_deg * (miles_per_deg_lat * miles_per_deg_lng)
    except Exception:
        return 0.0


def compute_polygon_centroid(coords: list[list[float]]) -> tuple[float, float]:
    """Return (lat, lng) of the polygon's centroid."""
    try:
        from shapely.geometry import Polygon
        poly = Polygon([(c[0], c[1]) for c in coords])
        return (poly.centroid.y, poly.centroid.x)
    except Exception:
        if not coords:
            return (0.0, 0.0)
        lats = [c[1] for c in coords]
        lngs = [c[0] for c in coords]
        return (sum(lats) / len(lats), sum(lngs) / len(lngs))


def compute_buffered_outline(coords: list[list[float]], buffer_miles: float) -> list[list[float]]:
    """Exterior ring [[lng, lat], ...] of the polygon expanded by buffer_miles.
    Mirrors the degree buffer (1 mi ~= 1/69 deg) used in filter_by_polygon so the
    drawn outline matches exactly which clinics get tagged 'buffer'."""
    if not coords or buffer_miles <= 0:
        return []
    try:
        from shapely.geometry import Polygon
        poly = Polygon([(c[0], c[1]) for c in coords])
        buffered = poly.buffer(buffer_miles / 69.0)
        return [[x, y] for x, y in buffered.exterior.coords]
    except Exception:
        return []


def filter_by_polygon(
    clinics: list[dict],
    polygon_coords: list[list[float]],
    buffer_miles: float = 0.5,
) -> list[dict]:
    """
    Tag each clinic with inclusion_zone 'core' or 'buffer'; discard anything outside.
    Uses a uniform degree buffer (1 mi ≈ 1/69°) — slightly asymmetric at non-equatorial
    latitudes but acceptable for the sub-mile scale of the DFW use case.
    """
    try:
        from shapely.geometry import Point, Polygon
    except ImportError:
        logger.error("shapely not installed; cannot filter by polygon")
        for c in clinics:
            c["inclusion_zone"] = "core"
        return clinics

    poly = Polygon([(c[0], c[1]) for c in polygon_coords])
    buffered = poly.buffer(buffer_miles / 69.0)

    result: list[dict] = []
    for clinic in clinics:
        lat, lng = clinic.get("lat"), clinic.get("lng")
        if lat is None or lng is None:
            continue
        pt = Point(lng, lat)
        if poly.contains(pt):
            clinic["inclusion_zone"] = "core"
            result.append(clinic)
        elif buffered.contains(pt):
            clinic["inclusion_zone"] = "buffer"
            result.append(clinic)

    return result


def run_grid_search(
    polygon_coords: list[list[float]],
    api_key: str,
    buffer_miles: float = 0.0,
    progress_cb: Callable[[str, float], None] | None = None,
    exclude_covered=None,
) -> tuple[list[dict], int]:
    """
    Adaptive grid search over the drawn polygon (expanded by buffer_miles).

    ``exclude_covered`` (a shapely geometry) is subtracted from the search area so
    regions already covered by prior runs are skipped entirely -- incremental runs
    only search the newly-drawn part and reuse the rest from cache.

    The buffered bounding box is tiled into top-level squares; each square whose
    area touches the polygon is searched with one Nearby Search circle that
    circumscribes it. A square that comes back saturated (>= _MAX_RESULTS, meaning
    the 20-result cap likely hid some) is split into four and recursed, so sparse
    areas cost a single call per top square while dense clusters subdivide only where
    needed -- and nothing is silently dropped. Squares entirely outside the polygon
    are never searched. Each Nearby Search returns contact + hours fields, so no
    per-clinic Place Details call is needed. Results are deduplicated by Place ID.

    Returns (raw un-filtered clinic list, number of Nearby Search calls made);
    call filter_by_polygon afterward.

    progress_cb(message, fraction_0_to_1)
    """
    min_lat, max_lat, min_lng, max_lng = compute_bounding_box(polygon_coords)
    min_lat, max_lat, min_lng, max_lng = _expand_bbox(min_lat, max_lat, min_lng, max_lng, buffer_miles)

    poly = _buffered_polygon(polygon_coords, buffer_miles)
    if exclude_covered is not None and poly is not None:
        try:
            poly = poly.difference(exclude_covered)
        except Exception as e:
            logger.warning("Could not subtract covered area, searching full polygon: %s", e)
    top_centers = _top_square_centers(min_lat, max_lat, min_lng, max_lng, _TOP_HALF_SIDE_M)
    total = len(top_centers)

    seen: dict[str, dict] = {}
    stats: dict[str, int] = {"calls": 0}
    for i, (lat, lng) in enumerate(top_centers):
        if progress_cb:
            progress_cb(
                f"Searching grid region {i + 1} of {total} ({stats['calls']} calls so far)...",
                int(2 + 88 * (i + 1) / max(total, 1)),
            )
        _search_region(lat, lng, _TOP_HALF_SIDE_M, api_key, poly, seen, stats)

    clinics = list(seen.values())
    if progress_cb:
        progress_cb(f"Found {len(clinics)} unique clinics in {stats['calls']} searches.", 90)

    return clinics, stats["calls"]
