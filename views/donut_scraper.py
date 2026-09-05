"""Donut Scraper — integrated into the CRM.

Draw a polygon on a map, scrape dental clinics in the area, review results,
call through the checklist, then promote confirmed leads into CRM accounts.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import date, datetime

import folium
import pandas as pd
import streamlit as st
from folium.plugins import Draw, MeasureControl
from streamlit_folium import st_folium
from branca.element import MacroElement, Template

from db import queries
from utils.constants import DONUT_CALL_STATUSES
from utils.dedup import find_duplicates
from utils.tz import CENTRAL

logger = logging.getLogger(__name__)


# ── Folium helpers (ported from leadgen) ─────────────────────────────────────

class _ImperialScale(MacroElement):
    _name = "ImperialScale"
    _template = Template("""
        {% macro script(this, kwargs) %}
        L.control.scale({maxWidth: 100, metric: false, imperial: true}).addTo({{ this._parent.get_name() }});
        {% endmacro %}
    """)


class _ZoomLabels(MacroElement):
    _name = "ZoomLabels"

    def __init__(self, min_zoom: int = 16):
        super().__init__()
        self.min_zoom = min_zoom
        self._template = Template("""
            {% macro script(this, kwargs) %}
            (function(){
                var map = {{ this._parent.get_name() }};
                var thr = {{ this.min_zoom }};
                function _upd(){
                    var el = map.getContainer();
                    if (map.getZoom() >= thr) { el.classList.add('ds-show-labels'); }
                    else { el.classList.remove('ds-show-labels'); }
                }
                map.on('zoomend', _upd);
                _upd();
            })();
            {% endmacro %}
        """)


# ── Secrets ──────────────────────────────────────────────────────────────────

def _get_secret(key: str) -> str:
    val = os.getenv(key, "")
    if not val:
        try:
            val = st.secrets.get(key, "")
        except Exception:
            pass
    return val


# ── Pipeline imports ─────────────────────────────────────────────────────────

from pipeline.donut_search import (
    CIRCLE_WARNING_THRESHOLD,
    adaptive_buffer_miles,
    estimate_circle_count,
    filter_by_polygon,
    run_grid_search,
    compute_polygon_area_sqmi,
    compute_polygon_centroid,
    compute_buffered_outline,
)
from pipeline.places import geocode, reverse_geocode
from pipeline.donut_enrichment import enrich_clinic


# ── Session state ────────────────────────────────────────────────────────────

def _init_pipeline_state() -> None:
    if "_donut_pipeline" not in st.session_state:
        st.session_state._donut_pipeline = {
            "running": False,
            "progress": 0,
            "message": "",
            "messages": [],
            "clinics": None,
            "error": None,
            "polygon_coords": None,
            "buffer_miles": 0.5,
            "area_name": "",
            "last_calculated_polygon": None,
            "area_sqmi": 0.0,
            "city_state": "",
            "auto_buffer_miles": 0.5,
            "pending_auto_buffer": None,
            "new_count": 0,
            "reused_count": 0,
            "saved_run_id": None,
        }


# ── Background pipeline ─────────────────────────────────────────────────────

def _run_pipeline(
    p: dict,
    polygon_coords: list[list[float]],
    buffer_miles: float,
    area_name: str,
    api_key: str,
    gemini_key: str,
    is_fresh: bool = False,
) -> None:
    """Runs in a background thread; writes results back into session state."""

    def progress(msg: str, pct: int = 0) -> None:
        p["message"] = msg
        p["progress"] = pct
        if "messages" not in p or p["messages"] is None:
            p["messages"] = []
        if not p["messages"] or p["messages"][-1] != msg:
            p["messages"].append(msg)

    try:
        exclude_covered = None
        if not is_fresh:
            try:
                from shapely.ops import unary_union
                from shapely.geometry import Polygon
                past_runs = queries.list_donut_runs()
                polys = []
                for r in past_runs:
                    raw_geo = r.get("polygon_geojson")
                    if raw_geo:
                        try:
                            coords = json.loads(raw_geo) if isinstance(raw_geo, str) else raw_geo
                            if coords and len(coords) >= 3:
                                poly = Polygon([(c[0], c[1]) for c in coords])
                                if poly.is_valid:
                                    polys.append(poly)
                        except Exception:
                            pass
                if polys:
                    exclude_covered = unary_union(polys)
            except Exception as e:
                logger.warning("Could not calculate past coverage geometry: %s", e)

        progress("Starting grid search...", 3)
        raw_clinics, search_calls = run_grid_search(
            polygon_coords,
            api_key,
            buffer_miles=buffer_miles,
            progress_cb=progress,
            exclude_covered=exclude_covered,
        )

        progress(f"Filtering {len(raw_clinics)} clinics by polygon + buffer...", 90)
        clinics = filter_by_polygon(raw_clinics, polygon_coords, buffer_miles)

        progress("Deduplicating clinics and extracting doctor names...", 91)
        from pipeline.dedup import deduplicate_clinics
        clinics = deduplicate_clinics(clinics)

        progress(f"Enriching {len(clinics)} clinics (email + dentist extraction)...", 92)
        for i, clinic in enumerate(clinics):
            progress(
                f"Enriching clinic {i + 1} of {len(clinics)}: {clinic.get('name', '')}...",
                92 + int(7 * (i + 1) / max(len(clinics), 1)),
            )
            enrich_clinic(clinic, gemini_key=gemini_key)

        p["clinics"] = clinics
        p["new_count"] = len(clinics)
        p["error"] = None
        progress("Done.", 100)

    except Exception as e:
        p["error"] = str(e)
        p["clinics"] = None
        progress("Error.", 0)
    finally:
        p["running"] = False


AREA_CAP_SQMI = 50.0


def _launch_donut_run(
    p: dict,
    polygon_coords: list[list[float]],
    buffer_miles: float,
    area_name: str,
    api_key: str,
    gemini_key: str,
    is_fresh: bool = False,
) -> None:
    p.update({
        "running": True, "error": None, "clinics": None,
        "saved_run_id": None, "buffer_miles": buffer_miles,
        "area_name": area_name, "progress": 0, "message": "",
        "messages": [], "new_count": 0, "reused_count": 0,
    })
    threading.Thread(
        target=_run_pipeline,
        args=(p, polygon_coords, buffer_miles, area_name, api_key, gemini_key, is_fresh),
        daemon=True,
    ).start()


# ── Save results to Supabase ─────────────────────────────────────────────────

def _save_results_to_db(clinics: list[dict], p: dict, status: str = "unsaved") -> int:
    """Write scrape results to donut_runs + donut_run_results. Returns run ID."""
    user_id = st.session_state["current_user"]["id"]
    area_name = p.get("area_name") or p.get("city_state") or "Donut area"
    
    if not p.get("area_name") and ("Unknown Location" in area_name or area_name == "Donut area"):
        from collections import Counter
        from db.queries import _city_from_address
        cities = []
        for c in clinics:
            addr = c.get("address")
            if addr:
                city = _city_from_address(addr)
                if city:
                    cities.append(city)
        if cities:
            area_name = Counter(cities).most_common(1)[0][0]

    run_name = area_name + " — " + date.today().isoformat()

    run = queries.create_donut_run({
        "run_name": run_name,
        "area_name": area_name,
        "polygon_geojson": p.get("polygon_coords"),
        "buffer_miles": p.get("buffer_miles", 0.5),
        "total_clinics": len(clinics),
        "new_clinics": p.get("new_count", len(clinics)),
        "reused_clinics": p.get("reused_count", 0),
        "status": status,
        "created_by": user_id,
    })
    run_id = run["id"]
    _save_run_results_rows(run_id, clinics)
    return run_id


def _resync_run_results(p: dict, selected_clinics: list[dict], status: str) -> bool:
    """Re-save the current in-memory scrape selection to its donut_run row.

    If the run already has promoted results, this refuses to delete-and-recreate
    the result rows: doing so would wipe promoted_account_id links (the in-memory
    `clinics` list has no row IDs, so a "sync" can only work as delete-then-reinsert),
    silently orphaning already-created CRM accounts and letting a later bulk-promote
    recreate duplicates for the same clinics. Returns False (and shows an error)
    when it refuses; True on success.
    """
    run_id = p.get("saved_run_id")
    if run_id:
        existing = queries.list_donut_run_results(run_id)
        if any(r.get("promoted_account_id") for r in existing):
            st.error(
                "This run already has leads promoted to the CRM. Re-saving the "
                "checked selection here would disconnect those accounts from this "
                "run. Manage individual leads from the **Scrape Runs** tab instead."
            )
            return False
        queries.update_donut_run(run_id, {"status": status, "total_clinics": len(selected_clinics)})
        try:
            queries.get_client().table("donut_run_results").delete().eq("donut_run_id", run_id).execute()
            _save_run_results_rows(run_id, selected_clinics)
        except Exception as e:
            logger.warning("Re-sync results failed: %s", e)
            st.error(f"Failed to re-sync results: {e}")
            return False
    else:
        run_id = _save_results_to_db(selected_clinics, p, status=status)
        p["saved_run_id"] = run_id
    return True


def _save_run_results_rows(run_id: int, clinics: list[dict]) -> None:
    rows = []
    for c in clinics:
        rows.append({
            "donut_run_id": run_id,
            "place_id": c.get("place_id"),
            "clinic_name": c.get("name", "Unknown"),
            "classification": c.get("classification"),
            "address": c.get("address"),
            "lat": c.get("lat"),
            "lng": c.get("lng"),
            "inclusion_zone": c.get("inclusion_zone"),
            "phone": c.get("phone"),
            "website": c.get("website"),
            "email": c.get("email"),
            "email_source": c.get("email_source"),
            "head_dentist": c.get("head_dentist"),
            "staff_source": c.get("staff_source"),
            "hours_json": json.dumps(c.get("hours_by_day", {})),
            "notes": c.get("notes"),
            "call_status": "Not Called",
        })
    if rows:
        queries.bulk_create_donut_run_results(rows)


# ── Map rendering ────────────────────────────────────────────────────────────

@st.cache_data(show_spinner=False)
def _geocode_for_map(location_str: str, api_key: str):
    try:
        lat, lng, label = geocode(location_str, api_key)
        return lat, lng, label
    except Exception:
        return None


def _clear_polygon_state(p: dict) -> None:
    p["polygon_coords"] = None
    p["last_calculated_polygon"] = None
    p["area_sqmi"] = 0.0
    p["city_state"] = None
    p["auto_buffer_miles"] = 0.5
    p.pop("last_synced_ids", None)


def _render_draw_map(buffer_miles: float = 0.0) -> list[list[float]] | None:
    p = st.session_state._donut_pipeline

    center_lat, center_lng, zoom = 32.7767, -96.7970, 11

    search_q = st.session_state.get("ds_area_search", "")
    search_center = None
    if search_q and len(search_q) >= 3:
        api_key = _get_secret("GOOGLE_PLACES_API_KEY")
        if api_key:
            geo = _geocode_for_map(search_q, api_key)
            if geo:
                search_center = (geo[0], geo[1])

    if p.get("polygon_coords"):
        coords = p["polygon_coords"]
        lats = [c[1] for c in coords]
        lngs = [c[0] for c in coords]
        center_lat = sum(lats) / len(lats)
        center_lng = sum(lngs) / len(lngs)
    elif search_center:
        center_lat, center_lng = search_center
        zoom = 12

    m = folium.Map(location=[center_lat, center_lng], zoom_start=zoom, tiles=None)
    folium.TileLayer("OpenStreetMap", name="Street (OSM)", control=True, show=True).add_to(m)
    folium.TileLayer("CartoDB positron", name="Light Streets", control=True, show=False).add_to(m)
    folium.LayerControl(position="bottomright", collapsed=True).add_to(m)
    m.add_child(_ImperialScale())

    Draw(
        export=False,
        position="topleft",
        draw_options={
            "polygon": {
                "allowIntersection": False,
                "shapeOptions": {"color": "#183e34", "weight": 2, "fillOpacity": 0.08},
            },
            "polyline": False, "rectangle": False, "circle": False,
            "marker": False, "circlemarker": False,
        },
        edit_options={"edit": False, "remove": False},
    ).add_to(m)

    MeasureControl(
        position="topright",
        primary_length_unit="miles",
        secondary_length_unit="feet",
        primary_area_unit="sqmiles",
    ).add_to(m)

    if p.get("polygon_coords"):
        coords = p["polygon_coords"]
        m.get_root().html.add_child(folium.Element(
            "<style>.ds-buffer-ring,.ds-core-poly{pointer-events:none !important;}</style>"
        ))
        if buffer_miles > 0:
            outline = compute_buffered_outline(coords, buffer_miles)
            if outline:
                folium.Polygon(
                    locations=[[c[1], c[0]] for c in outline],
                    color="#3abdaf", weight=2, dash_array="6,6",
                    fill=True, fill_color="#3abdaf", fill_opacity=0.06,
                    class_name="ds-buffer-ring",
                ).add_to(m)
        folium.Polygon(
            locations=[[c[1], c[0]] for c in coords],
            color="#183e34", weight=2,
            fill=True, fill_color="#183e34", fill_opacity=0.08,
            class_name="ds-core-poly",
        ).add_to(m)

    st_kwargs: dict = {}
    if not search_q:
        p["applied_search_center"] = None
    elif search_center and search_center != p.get("applied_search_center"):
        st_kwargs["center"] = search_center
        st_kwargs["zoom"] = 12
        p["applied_search_center"] = search_center

    result = st_folium(
        m, width="100%", height=440,
        key=f"donut_draw_map_{p.get('map_nonce', 0)}",
        returned_objects=["last_active_drawing"],
        **st_kwargs,
    )

    polygon_coords = None
    if result and result.get("last_active_drawing"):
        drawing = result["last_active_drawing"]
        geo = drawing.get("geometry", {})
        if geo.get("type") == "Polygon":
            coords = geo.get("coordinates", [[]])[0]
            if len(coords) >= 3:
                polygon_coords = coords

    return polygon_coords


def _render_results_map(
    clinics: list[dict],
    zone_filter: str = "All",
    polygon_coords: list[list[float]] | None = None,
    buffer_miles: float = 0.0,
    key_prefix: str = "donut_results_map",
) -> None:
    """Display-only map with clinic pins and optional polygon/buffer overlays."""
    display = list(clinics)
    if zone_filter == "Core only":
        display = [c for c in display if c.get("inclusion_zone") == "core"]
    elif zone_filter == "Buffer only":
        display = [c for c in display if c.get("inclusion_zone") == "buffer"]

    center_lat, center_lng = 32.7767, -96.7970
    if display:
        lats = [c.get("lat", 0) for c in display if c.get("lat")]
        lngs = [c.get("lng", 0) for c in display if c.get("lng")]
        if lats:
            center_lat, center_lng = sum(lats) / len(lats), sum(lngs) / len(lngs)
    elif polygon_coords and len(polygon_coords) >= 3:
        lats = [c[1] for c in polygon_coords]
        lngs = [c[0] for c in polygon_coords]
        if lats:
            center_lat, center_lng = sum(lats) / len(lats), sum(lngs) / len(lngs)

    m = folium.Map(location=[center_lat, center_lng], zoom_start=12, tiles=None)
    folium.TileLayer("OpenStreetMap", name="Street", control=False, show=True).add_to(m)
    m.add_child(_ImperialScale())

    m.get_root().html.add_child(folium.Element(
        "<style>.leaflet-tooltip.ds-zoom-label{display:none;background:#183e34;color:#fff;"
        "border:none;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.3);"
        "font-weight:600;font-size:11px;padding:2px 6px;}"
        ".leaflet-tooltip.ds-zoom-label:before{display:none;}"
        ".ds-show-labels .leaflet-tooltip.ds-zoom-label{display:block;}"
        ".ds-buffer-ring,.ds-core-poly{pointer-events:none !important;}"
        "</style>"
    ))
    m.add_child(_ZoomLabels(min_zoom=14))

    pts = []

    # Draw polygon & buffer if present
    if polygon_coords and len(polygon_coords) >= 3:
        for c in polygon_coords:
            pts.append([c[1], c[0]])
        if buffer_miles > 0:
            outline = compute_buffered_outline(polygon_coords, buffer_miles)
            if outline:
                folium.Polygon(
                    locations=[[c[1], c[0]] for c in outline],
                    color="#3abdaf", weight=2, dash_array="6,6",
                    fill=True, fill_color="#3abdaf", fill_opacity=0.06,
                    class_name="ds-buffer-ring",
                ).add_to(m)
                for c in outline:
                    pts.append([c[1], c[0]])
        folium.Polygon(
            locations=[[c[1], c[0]] for c in polygon_coords],
            color="#183e34", weight=2,
            fill=True, fill_color="#183e34", fill_opacity=0.08,
            class_name="ds-core-poly",
        ).add_to(m)

    for c in display:
        lat, lng = c.get("lat"), c.get("lng")
        if lat and lng:
            is_core = c.get("inclusion_zone") == "core"
            color = "#183e34" if is_core else "#4b5563"
            fill = "#3abdaf" if is_core else "#9ca3af"
            name = c.get("name") or c.get("clinic_name", "Clinic")
            call_st = c.get("call_status", "")
            badge = f" ({call_st})" if call_st and call_st != "Not Called" else ""

            popup_lines = [f"<b>{name}</b>"]
            if c.get("classification"):
                popup_lines.append(f"Class: {c['classification']}")
            if c.get("address"):
                popup_lines.append(f"Address: {c['address']}")
            popup_lines.append(f"Zone: {(c.get('inclusion_zone') or '').capitalize()}")
            if call_st:
                popup_lines.append(f"Call Status: {call_st}")
            if c.get("phone"):
                popup_lines.append(f"Phone: {c['phone']}")

            popup_html = "<br>".join(popup_lines)

            folium.CircleMarker(
                location=[lat, lng], radius=6,
                tooltip=folium.Tooltip(f"{name}{badge}", permanent=True, direction="top",
                                       className="ds-zoom-label"),
                popup=folium.Popup(popup_html, max_width=250),
                color=color, fill=True, fill_color=fill, fill_opacity=0.8, weight=1.5,
            ).add_to(m)
            pts.append([lat, lng])

    if pts:
        m.fit_bounds(pts, padding=(30, 30))

    st_folium(m, use_container_width=True, height=400,
              key=f"{key_prefix}_{zone_filter}",
              returned_objects=["last_object_clicked", "zoom"])


# ── Sidebar controls ─────────────────────────────────────────────────────────

_SIDEBAR_CSS = """
<style>
.block-container {
    padding-left: 2rem !important;
    padding-right: 2rem !important;
    max-width: 85rem !important;
}
.ds-section-label {
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em;
    text-transform: uppercase; color: #8a8f98; margin: 14px 0 4px;
}
.ds-stat-row { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.ds-stat { flex: 1; min-width: 80px; background: #fff; border: 1px solid #ededed;
    border-radius: 8px; padding: 10px 12px; }
.ds-stat .sv { font-size: 19px; font-weight: 700; letter-spacing: -0.03em; color: #282a30; }
.ds-stat .sl { font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; color: #6b6f76; margin-top: 2px; }
.ds-control-card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 18px 20px;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.02);
    margin-top: 14px;
    margin-bottom: 14px;
    font-family: 'Outfit', sans-serif;
}
.ds-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: #64748b;
    margin-bottom: 6px;
    font-family: 'Outfit', sans-serif;
}
.ds-sub-caption {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #94a3b8;
    margin-top: 4px;
    font-family: 'Outfit', sans-serif;
}
.ds-footer-text {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #94a3b8;
    margin-top: 12px;
    font-family: 'Outfit', sans-serif;
    line-height: 1.4;
}
</style>
"""


def _render_controls_panel() -> tuple[float, str, bool, bool]:
    """Render configuration panel below the search bar.
    Returns (buffer_miles, area_name, run_clicked, fresh_run_clicked)."""
    p = st.session_state._donut_pipeline
    if "buffer_slider" not in st.session_state:
        st.session_state.buffer_slider = 0.5

    pending = p.get("pending_auto_buffer")
    if pending is not None:
        st.session_state.buffer_slider = pending
        p["pending_auto_buffer"] = None

    with st.container(border=True):
        c1, c2 = st.columns([3, 2], gap="medium", vertical_alignment="bottom")
        with c1:
            st.caption("AREA LABEL (OPTIONAL)")
            area_name = st.text_input(
                "Area label",
                placeholder="e.g. Prosper test zone",
                key="ds_area_label_main",
                label_visibility="collapsed",
            )
        with c2:
            st.caption("BUFFER DISTANCE (MILES)")
            buffer_miles = st.number_input(
                "Buffer distance",
                min_value=0.0, max_value=5.0, step=0.1, format="%.1f",
                key="buffer_slider", label_visibility="collapsed",
            )

        sub1, sub2 = st.columns([3, 2], gap="medium")
        with sub1:
            st.caption("")
        with sub2:
            st.caption(f"{buffer_miles:.1f} mi buffer around polygon")

        btn_c1, btn_c2, _ = st.columns([2, 2, 3], gap="small", vertical_alignment="center")
        with btn_c1:
            run_clicked = st.button(":material/play_arrow: Run", type="primary", key="ds_run_normal", use_container_width=True)
        with btn_c2:
            fresh_run_clicked = st.button(":material/refresh: Fresh run", key="ds_run_fresh", use_container_width=True)

        st.caption("Run reuses cached areas in database; Fresh run re-scrapes all areas.")

    return buffer_miles, area_name, run_clicked, fresh_run_clicked


# ── Call status badge ────────────────────────────────────────────────────────

_CALL_STATUS_COLORS = {
    "Not Called": {"bg": "#f1f5f9", "fg": "#475569"},
    "No Answer": {"bg": "#ffedd5", "fg": "#c2410c"},
    "Left Voicemail": {"bg": "#fef9c3", "fg": "#854d0e"},
    "Interested": {"bg": "#dcfce7", "fg": "#16a34a"},
    "Not Interested": {"bg": "#fee2e2", "fg": "#dc2626"},
    "Dead": {"bg": "#fecaca", "fg": "#991b1b"},
    "Call Back Later": {"bg": "#e0e7ff", "fg": "#4f46e5"},
}


def _call_status_badge(status: str) -> str:
    style = _CALL_STATUS_COLORS.get(status, {"bg": "#e2e8f0", "fg": "#1e293b"})
    bg = style["bg"]
    fg = style["fg"]
    return (
        f"<span style='display:inline-block;padding:0.2rem 0.5rem;font-size:0.7rem;"
        f"font-weight:700;border-radius:10rem;background:{bg};color:{fg};"
        f"font-family:Outfit,sans-serif;letter-spacing:0.3px;border:1px solid rgba(0,0,0,0.03);'>"
        f"{status}</span>"
    )




# ── Tab: New Scrape ──────────────────────────────────────────────────────────

def _tab_new_scrape() -> None:
    p = st.session_state._donut_pipeline

    buffer_miles = p.get("buffer_miles", 0.5)

    if p["running"]:
        st.info("Map is locked while the scraper is running.")
    elif not p.get("clinics"):
        st.markdown("**Draw your target area** — polygon only, one shape at a time")
        new_polygon_coords = _render_draw_map(buffer_miles)

        _col_search, _col_action = st.columns([3, 2], vertical_alignment="center")
        with _col_search:
            st.text_input(
                "Search area", key="ds_area_search",
                placeholder="Jump to a city or ZIP — e.g. Plano, TX or 75024",
                label_visibility="collapsed",
            )
        with _col_action:
            if p.get("polygon_coords"):
                if st.button("Clear shape", key="ds_clear_shape", use_container_width=True):
                    _clear_polygon_state(p)
                    p["map_nonce"] = p.get("map_nonce", 0) + 1
                    st.rerun()
            else:
                _sq = st.session_state.get("ds_area_search", "")
                if _sq and len(_sq) >= 3:
                    _api_key = _get_secret("GOOGLE_PLACES_API_KEY")
                    _geo = _geocode_for_map(_sq, _api_key) if _api_key else None
                    if _geo:
                        st.caption(f":material/location_on: Centered on {_geo[2]}")

        if new_polygon_coords:
            p["polygon_coords"] = new_polygon_coords
            if new_polygon_coords != p.get("last_calculated_polygon"):
                area = compute_polygon_area_sqmi(new_polygon_coords)
                lat, lng = compute_polygon_centroid(new_polygon_coords)
                api_key = _get_secret("GOOGLE_PLACES_API_KEY")
                city_state = reverse_geocode(lat, lng, api_key) if api_key else "Unknown Location"
                auto_buf = adaptive_buffer_miles(area)
                p["area_sqmi"] = area
                p["city_state"] = city_state
                p["auto_buffer_miles"] = auto_buf
                p["last_calculated_polygon"] = new_polygon_coords
                p["pending_auto_buffer"] = auto_buf
                st.rerun()

        # Render configuration controls panel directly below search bar
        buffer_miles, area_name, run_clicked, fresh_run_clicked = _render_controls_panel()

        polygon_coords = p.get("polygon_coords")

        # Pre-run summary
        if polygon_coords and not p["running"] and not p.get("clinics"):
            from pipeline.donut_search import CIRCLE_WARNING_THRESHOLD
            area = p.get("area_sqmi", 0.0)
            city = p.get("city_state", "Unknown")
            n_queries = estimate_circle_count(polygon_coords, buffer_miles=buffer_miles)
            st.markdown(
                f"<div style='background:#f7f7f8;border:1px solid #ededed;border-radius:8px;padding:14px;"
                f"margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;font-family:Outfit,sans-serif;'>"
                f"<div style='flex:1;min-width:100px;'>"
                f"<div style='font-size:10px;font-weight:600;color:#6b6f76;text-transform:uppercase;'>Area</div>"
                f"<div style='font-size:15px;font-weight:600;color:#183e34;margin-top:3px;'>{area:.1f} sq mi</div></div>"
                f"<div style='flex:1;min-width:100px;'>"
                f"<div style='font-size:10px;font-weight:600;color:#6b6f76;text-transform:uppercase;'>Location</div>"
                f"<div style='font-size:15px;font-weight:600;color:#183e34;margin-top:3px;'>{city}</div></div>"
                f"<div style='flex:1;min-width:100px;'>"
                f"<div style='font-size:10px;font-weight:600;color:#6b6f76;text-transform:uppercase;'>Grid Queries</div>"
                f"<div style='font-size:15px;font-weight:600;color:#183e34;margin-top:3px;'>{n_queries}</div></div>"
                f"</div>",
                unsafe_allow_html=True,
            )

        # Launch run handlers
        if run_clicked or fresh_run_clicked:
            api_key = _get_secret("GOOGLE_PLACES_API_KEY")
            gemini_key = _get_secret("GEMINI_API_KEY")
            if not polygon_coords:
                st.error("Draw a polygon on the map before running.")
            elif not api_key:
                st.error("GOOGLE_PLACES_API_KEY not configured.")
            elif p["running"]:
                st.warning("A run is already in progress.")
            else:
                _launch_donut_run(p, polygon_coords, buffer_miles, area_name, api_key, gemini_key, is_fresh=fresh_run_clicked)
                st.rerun()

    # Progress
    if p["running"]:
        prog_pct = p.get("progress", 0)
        st.progress(prog_pct / 100, text=f"Scraping… {prog_pct}%")
        recent = p.get("messages", [])[-6:]
        if recent:
            lines = "".join(
                f"<div style='padding:2px 0;border-bottom:1px solid #ededed;font-size:11.5px;color:#6b6f76'>{m}</div>"
                for m in recent
            )
            st.markdown(
                f"<div style='font-family:ui-monospace,monospace;padding:10px 12px;"
                f"background:#f7f7f8;border-radius:7px;border:1px solid #ededed;margin-top:8px'>{lines}</div>",
                unsafe_allow_html=True,
            )
        st.caption("This takes 30–90 seconds. Do not navigate away.")
        time.sleep(0.5)
        st.rerun()

    # Error
    if p.get("error"):
        st.error(f":material/error: Run failed: {p['error']}")

    # Results — save to CRM
    if p.get("clinics") is not None and not p["running"]:
        clinics = p["clinics"]
        if clinics:
            # Determine selected_clinics from data editor session state
            edited_state = st.session_state.get("ds_results_editor", {}).get("edited_rows", {})
            selected_clinics = []
            for idx, c in enumerate(clinics):
                is_transfer = edited_state.get(idx, {}).get("Transfer", True)
                if is_transfer:
                    selected_clinics.append(c)

            # Auto-save/resync to DB so scrape run record stays 100% in sync with checked items
            current_ids = [c.get("place_id") or c.get("name") for c in selected_clinics]
            if not p.get("saved_run_id"):
                run_id = _save_results_to_db(selected_clinics, p, status="unsaved")
                p["saved_run_id"] = run_id
                p["last_synced_ids"] = current_ids
            elif current_ids != p.get("last_synced_ids"):
                current_status = "confirmed" if p.get("is_confirmed") else "unsaved"
                ok = _resync_run_results(p, selected_clinics, status=current_status)
                if ok:
                    p["last_synced_ids"] = current_ids

            st.markdown("---")

            # 1. MAP ON TOP
            zone = st.segmented_control(
                "Map filter", ["All", "Core only", "Buffer only"],
                default="All", key="ds_map_zone", label_visibility="collapsed",
            ) or "All"
            _render_results_map(
                selected_clinics,
                zone,
                polygon_coords=p.get("polygon_coords"),
                buffer_miles=p.get("buffer_miles", 0.0),
                key_prefix="ds_new_scrape_results_map",
            )

            # 2. METRICS BAR
            core = [c for c in selected_clinics if c.get("inclusion_zone") == "core"]
            buf = [c for c in selected_clinics if c.get("inclusion_zone") == "buffer"]
            st.markdown(
                f"<div class='ds-stat-row'>"
                f"<div class='ds-stat'><div class='sv'>{len(selected_clinics)} / {len(clinics)}</div><div class='sl'>Selected</div></div>"
                f"<div class='ds-stat'><div class='sv'>{len(core)}</div><div class='sl'>Core</div></div>"
                f"<div class='ds-stat'><div class='sv'>{len(buf)}</div><div class='sl'>Buffer</div></div>"
                f"<div class='ds-stat'><div class='sv'>{len([c for c in selected_clinics if c.get('phone')])}</div><div class='sl'>With Phone</div></div>"
                f"<div class='ds-stat'><div class='sv'>{len([c for c in selected_clinics if c.get('email')])}</div><div class='sl'>With Email</div></div>"
                f"</div>",
                unsafe_allow_html=True,
            )

            # 3. SCRAPED RESULTS TABLE UNDERNEATH MAP
            st.markdown("**Scraped Results** — check/uncheck locations to include or exclude from CRM transfer and map view:")
            rows = []
            for c in clinics:
                rows.append({
                    "Transfer": True,
                    "Clinic Name": c.get("name", ""),
                    "Classification": c.get("classification", ""),
                    "Zone": (c.get("inclusion_zone") or "").capitalize(),
                    "Phone": c.get("phone", ""),
                    "Email": c.get("email", ""),
                    "Head Dentist": c.get("head_dentist", ""),
                    "Address": c.get("address", ""),
                    "Website": c.get("website", ""),
                })
            df = pd.DataFrame(rows)

            edited_df = st.data_editor(
                df,
                use_container_width=True,
                hide_index=True,
                key="ds_results_editor",
                column_config={
                    "Transfer": st.column_config.CheckboxColumn("Transfer", help="Uncheck to exclude from CRM save and hide from map", default=True),
                    "Website": st.column_config.LinkColumn("Website", display_text="Visit"),
                },
                disabled=["Clinic Name", "Classification", "Zone", "Phone", "Email", "Head Dentist", "Address", "Website"],
            )

            # 4. SAVE ACTION BUTTONS
            if p.get("is_confirmed"):
                c_msg, c_unconfirm = st.columns([3, 1], vertical_alignment="center")
                with c_msg:
                    st.success(f":material/check_circle: Saved & Confirmed {len(selected_clinics)} selected leads as Run #{p['saved_run_id']}. Go to **Scrape Runs** tab to call through the checklist.")
                with c_unconfirm:
                    if st.button("Unconfirm", key="ds_unconfirm_main_results", use_container_width=True):
                        run_id = p.get("saved_run_id")
                        if run_id:
                            queries.update_donut_run(run_id, {"status": "unsaved"})
                        p["is_confirmed"] = False
                        st.rerun()
            else:
                if p.get("saved_to_list"):
                    st.info(f":material/bookmark: Saved {len(selected_clinics)} selected leads to Scrape Runs list (Run #{p['saved_run_id']}).")

                c1, c2, c3 = st.columns([2, 2, 3], gap="small", vertical_alignment="center")
                with c1:
                    if st.button(":material/save: Save to CRM", type="primary", use_container_width=True, disabled=not selected_clinics):
                        with st.spinner("Saving to CRM…"):
                            ok = _resync_run_results(p, selected_clinics, status="confirmed")
                            if ok:
                                p["is_confirmed"] = True
                                p["saved_to_list"] = False
                        st.rerun()
                with c2:
                    if st.button(":material/list_alt: Save to List", use_container_width=True, disabled=not selected_clinics):
                        with st.spinner("Saving to Scrape Runs list…"):
                            ok = _resync_run_results(p, selected_clinics, status="unsaved")
                            if ok:
                                p["saved_to_list"] = True
                                p["is_confirmed"] = False
                        st.rerun()
                with c3:
                    st.caption(f"Save to CRM confirms into CRM; Save to List preserves {len(selected_clinics)} checked leads in Scrape Runs.")

            # New scrape button
            if st.button("Start new scrape", icon=":material/refresh:"):
                _clear_polygon_state(p)
                p["clinics"] = None
                p["saved_run_id"] = None
                p["is_confirmed"] = False
                p["map_nonce"] = p.get("map_nonce", 0) + 1
                st.rerun()
        else:
            st.info("No dental clinics found in the drawn area.")


# ── Tab: Scrape Runs ─────────────────────────────────────────────────────────

# ── Tab: Scrape Runs ─────────────────────────────────────────────────────────

_STATUS_ROW_STYLES = {
    "unsaved": {"bg": "#eff6ff", "border": "#93c5fd"},
    "pending": {"bg": "#eff6ff", "border": "#93c5fd"},
    "confirmed": {"bg": "#f0fdf4", "border": "#86efac"},
    "saved": {"bg": "#f0fdf4", "border": "#86efac"},
    "archived": {"bg": "#f8fafc", "border": "#cbd5e1"},
}


def _tab_scrape_runs() -> None:
    selected_map_run_id = st.session_state.get("_ds_view_map_for_run")
    if selected_map_run_id:
        _render_map_view(selected_map_run_id)
        return

    # If viewing a specific run
    selected_run_id = st.session_state.get("_ds_view_run")
    if selected_run_id:
        _render_run_detail(selected_run_id)
        return

    _render_runs_list_fragment()


@st.fragment(run_every=30)
def _render_runs_list_fragment() -> None:
    runs = queries.list_donut_runs()  # Universal: fetch runs across all users
    if not runs:
        st.info("No donut scrape runs yet. Run a scrape from the **New Scrape** tab.")
        return

    left, right = st.columns([5, 1], vertical_alignment="center")
    left.markdown(
        "### All Scrape Runs "
        "<span style='font-size:0.8rem;color:#16a34a;font-weight:600;margin-left:10px;display:inline-flex;align-items:center;gap:4px;'>"
        "<svg style='width:13px;height:13px;fill:none;stroke:#16a34a;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;' viewBox='0 0 24 24'><polyline points='23 4 23 10 17 10'></polyline><path d='M20.49 15a9 9 0 1 1-2.12-9.36L23 10'></path></svg> "
        "Live sync active (30s)</span>",
        unsafe_allow_html=True,
    )
    if right.button("Refresh", icon=":material/refresh:", use_container_width=True, key="ds_refresh_runs"):
        st.rerun()

    # Top Key / Legend
    st.markdown(
        "<div style='display:flex;gap:20px;align-items:center;background:#ffffff;border:1px solid #e2e8f0;"
        "border-radius:8px;padding:10px 16px;margin-bottom:16px;font-family:Outfit,sans-serif;font-size:0.8rem;color:#475569;'>"
        "<span style='font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;'>Key:</span>"
        "<div style='display:flex;align-items:center;gap:6px;'>"
        "<span style='width:12px;height:12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:3px;display:inline-block;'></span>"
        "<span style='font-weight:600;color:#1e40af;'>Unsaved Scrape</span></div>"
        "<div style='display:flex;align-items:center;gap:6px;'>"
        "<span style='width:12px;height:12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:3px;display:inline-block;'></span>"
        "<span style='font-weight:600;color:#15803d;'>Saved to CRM</span></div>"
        "<div style='display:flex;align-items:center;gap:6px;'>"
        "<span style='width:12px;height:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:3px;display:inline-block;'></span>"
        "<span style='font-weight:600;color:#64748b;'>Archived</span></div>"
        "</div>",
        unsafe_allow_html=True,
    )

    users_all = queries.list_users(active_only=False)
    user_names = {u["id"]: u["name"] for u in users_all}

    for run in runs:
        status = run.get("status", "unsaved").lower()
        st_cfg = _STATUS_ROW_STYLES.get(status, _STATUS_ROW_STYLES["unsaved"])

        created_str = ""
        try:
            dt = datetime.fromisoformat(str(run["created_at"]).replace("Z", "+00:00")).astimezone(CENTRAL)
            created_str = dt.strftime("%b %-d, %Y at %-I:%M %p CT")
        except Exception:
            created_str = str(run.get("created_at", ""))[:10]

        creator_name = user_names.get(run.get("created_by"), "Team User")

        # Results summary
        run_results = queries.list_donut_run_results(run["id"])
        promoted_count = sum(1 for r in run_results if r.get("promoted_account_id"))
        total_clinics = len(run_results) or run.get("total_clinics", 0)

        with st.container(border=True):
            st.markdown(
                f"<div style='background:{st_cfg['bg']};border:1.5px solid {st_cfg['border']};"
                f"border-radius:10px;padding:14px 16px;margin-bottom:10px;"
                f"font-family:Outfit,sans-serif;display:flex;gap:20px;flex-wrap:wrap;"
                f"align-items:flex-start;'>"
                f"<div style='flex:2.2;min-width:180px;'>"
                f"<div style='font-size:0.98rem;font-weight:700;color:#0f172a;line-height:1.3;'>{run['run_name']}</div>"
                + (f"<div style='font-size:0.78rem;color:#64748b;margin-top:3px;'>{run['area_name']}</div>" if run.get("area_name") else "")
                + "</div>"
                f"<div style='flex:1.8;min-width:160px;font-size:0.82rem;line-height:1.6;color:#334155;'>"
                f"<strong>{total_clinics}</strong> total clinics<br>"
                f"<span style='color:#64748b;font-size:0.75rem;'>{run.get('new_clinics', total_clinics)} new · {run.get('reused_clinics', 0)} reused</span><br>"
                f"<span style='color:#15803d;font-weight:600;font-size:0.75rem;'>{promoted_count} promoted to CRM</span>"
                f"</div>"
                f"<div style='flex:1.4;min-width:140px;font-size:0.78rem;color:#64748b;line-height:1.6;'>"
                f"Created by: <strong>{creator_name}</strong><br>"
                f"Date: {created_str}"
                f"</div>"
                f"</div>",
                unsafe_allow_html=True,
            )

            if status in ("confirmed", "saved"):
                ac1, ac2, ac3, ac4 = st.columns([1.1, 1.3, 1.1, 1.1])
                with ac1:
                    if st.button("Open", key=f"ds_open_run_{run['id']}", type="primary", use_container_width=True):
                        st.session_state["_ds_view_run"] = run["id"]
                        st.rerun()
                with ac2:
                    if st.button("Unconfirm", key=f"ds_unconfirm_run_{run['id']}", use_container_width=True):
                        queries.update_donut_run(run["id"], {"status": "unsaved"})
                        st.rerun()
                with ac3:
                    if st.button("Map", key=f"ds_map_run_{run['id']}", use_container_width=True):
                        st.session_state["_ds_view_map_for_run"] = run["id"]
                        st.rerun()
                with ac4:
                    if st.button("Archive", key=f"ds_archive_{run['id']}", use_container_width=True):
                        queries.update_donut_run(run["id"], {"status": "archived"})
                        st.rerun()
            elif status == "archived":
                ac1, ac2, ac3 = st.columns([1.1, 1.3, 1.1])
                with ac1:
                    if st.button("Open", key=f"ds_open_run_{run['id']}", type="primary", use_container_width=True):
                        st.session_state["_ds_view_run"] = run["id"]
                        st.rerun()
                with ac2:
                    if st.button("Map", key=f"ds_map_run_{run['id']}", use_container_width=True):
                        st.session_state["_ds_view_map_for_run"] = run["id"]
                        st.rerun()
                with ac3:
                    if st.button("Unarchive", key=f"ds_unarchive_run_{run['id']}", use_container_width=True):
                        queries.update_donut_run(run["id"], {"status": "unsaved"})
                        st.rerun()
            else:  # unsaved / pending
                ac1, ac2, ac3, ac4 = st.columns([1.1, 1.3, 1.1, 1.1])
                with ac1:
                    if st.button("Open", key=f"ds_open_run_{run['id']}", type="primary", use_container_width=True):
                        st.session_state["_ds_view_run"] = run["id"]
                        st.rerun()
                with ac2:
                    if st.button("Confirm", key=f"ds_confirm_run_{run['id']}", use_container_width=True):
                        queries.update_donut_run(run["id"], {"status": "confirmed"})
                        st.rerun()
                with ac3:
                    if st.button("Map", key=f"ds_map_run_{run['id']}", use_container_width=True):
                        st.session_state["_ds_view_map_for_run"] = run["id"]
                        st.rerun()
                with ac4:
                    if st.button("Archive", key=f"ds_archive_{run['id']}", use_container_width=True):
                        queries.update_donut_run(run["id"], {"status": "archived"})
                        st.rerun()


def _render_map_view(run_id: int) -> None:
    """Map view for a single run highlighting specific call statuses."""
    run = queries.get_donut_run(run_id)
    if not run:
        st.session_state.pop("_ds_view_map_for_run", None)
        st.rerun()
        return

    btn_col1, btn_col2, _ = st.columns([2, 2, 6])
    with btn_col1:
        if st.button(":material/arrow_back: Back to run details", use_container_width=True):
            st.session_state.pop("_ds_view_map_for_run", None)
            st.session_state["_ds_view_run"] = run_id
            st.rerun()
    with btn_col2:
        if st.button(":material/arrow_back: Back to runs list", use_container_width=True):
            st.session_state.pop("_ds_view_map_for_run", None)
            st.session_state.pop("_ds_view_run", None)
            st.rerun()

    st.title(f"Route Map: {run['run_name']}")
    st.caption("Plan your in-person visits and routes for positive leads.")

    results = queries.list_donut_run_results(run_id)
    if not results:
        st.info("No scraped results to display on map.")
        return

    # 1. Filter Multi-select
    default_statuses = ["Interested", "Call Back Later", "No Answer", "Left Voicemail", "Not Called"]
    
    selected_statuses = st.multiselect(
        "Show locations with Call Status:",
        options=DONUT_CALL_STATUSES,
        default=default_statuses,
        key=f"ds_map_filter_{run_id}"
    )

    # 2. Filter Results
    filtered_results = [r for r in results if r.get("call_status", "Not Called") in selected_statuses and r.get("lat") and r.get("lng")]

    # 3. Layout Map and Notes (Left) / List (Right)
    map_col, list_col = st.columns([7, 3])

    with map_col:
        if not filtered_results:
            st.warning("No locations match the selected criteria.")
        else:
            # Calculate center
            lats = [float(r["lat"]) for r in filtered_results]
            lngs = [float(r["lng"]) for r in filtered_results]
            center_lat = sum(lats) / len(lats)
            center_lng = sum(lngs) / len(lngs)

            m = folium.Map(location=[center_lat, center_lng], zoom_start=11)
            
            for r in filtered_results:
                clinic_name = r.get("clinic_name", "Unknown")
                address = r.get("address", "Unknown")
                status = r.get("call_status", "Not Called")
                tooltip = f"<b>{clinic_name}</b><br>{address}<br><i>{status}</i>"
                
                # Use different colors based on status priority
                color = "green" if status == "Interested" else "orange" if status == "Call Back Later" else "blue"
                
                folium.Marker(
                    [float(r["lat"]), float(r["lng"])],
                    tooltip=tooltip,
                    icon=folium.Icon(color=color)
                ).add_to(m)

            st_folium(m, width=700, height=500, returned_objects=[])

        # 5. Notes Text Box (directly under the map, same column)
        st.markdown(
            "<hr style='margin: 10px 0; border: none; border-top: 1px solid #e2e8f0;'>"
            "<h3 style='margin-bottom: 5px; margin-top: 5px;'>Route Notes</h3>",
            unsafe_allow_html=True
        )
        
        current_notes = run.get("map_notes") or ""
        new_notes = st.text_area(
            "Plan your route or leave notes here...",
            value=current_notes,
            height=200,
            key=f"ds_map_notes_{run_id}"
        )
        if st.button("Save Notes", type="primary", key=f"ds_save_map_notes_{run_id}"):
            queries.update_donut_run(run_id, {"map_notes": new_notes})
            st.success("Notes saved successfully!")
            st.rerun()

    with list_col:
        st.markdown("### Location List")
        if not filtered_results:
            st.info("No locations to show.")
        else:
            for r in filtered_results:
                st.markdown(
                    f"<div style='font-size: 0.8rem; line-height: 1.3; margin-bottom: 12px; color: #334155;'>"
                    f"<strong style='color: #0f172a; font-size: 0.85rem;'>{r.get('clinic_name', 'Unknown')}</strong><br>"
                    f"{r.get('address', 'Unknown')}<br>"
                    f"<span style='color: #64748b; font-style: italic;'>{r.get('call_status', 'Not Called')}</span>"
                    f"</div>",
                    unsafe_allow_html=True
                )


def _render_run_detail(run_id: int) -> None:
    """Full-page detail for a single donut run with call-through checklist."""
    run = queries.get_donut_run(run_id)
    if not run:
        st.session_state.pop("_ds_view_run", None)
        st.rerun()
        return

    current_user_id = st.session_state.get("current_user", {}).get("id")
    users_all = queries.list_users(active_only=False)
    user_names = {u["id"]: u["name"] for u in users_all}
    creator_name = user_names.get(run.get("created_by"), "Team User")

    btn_col1, btn_col2, _ = st.columns([2, 2, 6])
    with btn_col1:
        if st.button(":material/arrow_back: Back to runs", use_container_width=True):
            st.session_state.pop("_ds_view_run", None)
            st.rerun()
    with btn_col2:
        if st.button(":material/map: Open Map", use_container_width=True):
            st.session_state["_ds_view_map_for_run"] = run_id
            st.rerun()

    st.title(run["run_name"])

    created = ""
    try:
        dt = datetime.fromisoformat(str(run["created_at"]).replace("Z", "+00:00")).astimezone(CENTRAL)
        created = dt.strftime("%b %-d, %Y at %-I:%M %p CT")
    except Exception:
        created = str(run.get("created_at", ""))[:10]

    st.caption(f"Created by **{creator_name}** on {created}  ·  {run['total_clinics']} clinics  ·  Status: **{run['status'].title()}**")

    _render_run_checklist_fragment(run_id, current_user_id, user_names, run)


@st.fragment(run_every=30)
def _render_run_checklist_fragment(run_id: int, current_user_id: int | None, user_names: dict[int, str], run: dict) -> None:
    creator_name = user_names.get(run.get("created_by"), "Team User")
    results = queries.list_donut_run_results(run_id)
    if not results:
        st.info("No results in this run.")
        return

    # Map visualization of the run
    zone_run_map = st.segmented_control(
        "Map filter", ["All", "Core only", "Buffer only"],
        default="All", key=f"ds_run_map_zone_{run_id}", label_visibility="collapsed",
    ) or "All"

    poly_raw = run.get("polygon_geojson")
    polygon_coords = None
    if isinstance(poly_raw, list):
        polygon_coords = poly_raw
    elif isinstance(poly_raw, str):
        try:
            polygon_coords = json.loads(poly_raw)
        except Exception:
            polygon_coords = None

    buffer_miles = float(run.get("buffer_miles") or 0.0)

    _render_results_map(
        clinics=results,
        zone_filter=zone_run_map,
        polygon_coords=polygon_coords,
        buffer_miles=buffer_miles,
        key_prefix=f"ds_run_detail_map_{run_id}",
    )

    st.markdown("<div style='margin-bottom:12px;'></div>", unsafe_allow_html=True)

    # Stats
    statuses = {}
    for r in results:
        s = r.get("call_status", "Not Called")
        statuses[s] = statuses.get(s, 0) + 1
    promoted = sum(1 for r in results if r.get("promoted_account_id"))

    cols = st.columns(5)
    cols[0].metric("Total", len(results))
    cols[1].metric("Not Called", statuses.get("Not Called", 0))
    cols[2].metric("Interested", statuses.get("Interested", 0))
    cols[3].metric("Dead / Not Interested", statuses.get("Dead", 0) + statuses.get("Not Interested", 0))
    cols[4].metric("Promoted to CRM", promoted)

    # Bulk actions
    st.markdown("---")
    act_cols = st.columns([2, 2, 2], gap="small")
    with act_cols[0]:
        if st.button(":material/rocket_launch: Promote all eligible", type="primary", use_container_width=True,
                     help="Creates CRM accounts for all results NOT marked Dead or Not Interested"):
            user_id = current_user_id or st.session_state["current_user"]["id"]
            with st.spinner("Promoting…"):
                created, errors, flagged = queries.bulk_promote_donut_results(run_id, user_id)
                if created:
                    queries.update_donut_run(run_id, {"status": "confirmed"})
            if created:
                st.success(f"Promoted {len(created)} accounts to CRM.")
            if flagged:
                st.warning(
                    f"{len(flagged)} clinic(s) look like existing CRM accounts and were "
                    "NOT auto-promoted — review and promote them individually below if they're "
                    "genuinely new:\n"
                    + "\n".join(f"- {f['clinic_name']}" for f in flagged)
                )
            if errors:
                st.error(
                    f"{len(errors)} clinic(s) could not be promoted:\n"
                    + "\n".join(f"- {e['clinic_name']}: {e['reason']}" for e in errors)
                )
            st.rerun()
    with act_cols[1]:
        run_st = (run.get("status") or "unsaved").lower()
        if run_st in ("confirmed", "saved"):
            if st.button(":material/undo: Unconfirm", key=f"ds_detail_unconfirm_{run_id}", use_container_width=True):
                queries.update_donut_run(run_id, {"status": "unsaved"})
                st.rerun()
        else:
            if st.button(":material/check: Confirm", key=f"ds_detail_confirm_{run_id}", use_container_width=True):
                queries.update_donut_run(run_id, {"status": "confirmed"})
                st.rerun()
    with act_cols[2]:
        if st.button(":material/archive: Archive run", use_container_width=True):
            queries.update_donut_run(run_id, {"status": "archived"})
            st.session_state.pop("_ds_view_run", None)
            st.rerun()

    # Call-through checklist header with live indicator
    left_h, right_h = st.columns([4, 1], vertical_alignment="center")
    left_h.markdown(
        "### Call-Through Checklist "
        "<span style='font-size:0.8rem;color:#16a34a;font-weight:600;margin-left:10px;display:inline-flex;align-items:center;gap:4px;'>"
        "<svg style='width:13px;height:13px;fill:none;stroke:#16a34a;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;' viewBox='0 0 24 24'><polyline points='23 4 23 10 17 10'></polyline><path d='M20.49 15a9 9 0 1 1-2.12-9.36L23 10'></path></svg> "
        "Live sync active (30s)</span>",
        unsafe_allow_html=True,
    )
    if right_h.button("Refresh", icon=":material/refresh:", use_container_width=True, key=f"ds_refresh_checklist_{run_id}"):
        st.rerun()

    st.caption("Update each clinic's status as you call through them. Promote individual leads to the CRM.")

    # Filter
    filter_status = st.pills(
        "Filter by status",
        ["All"] + DONUT_CALL_STATUSES,
        default="All",
        key=f"ds_pill_filter_{run_id}",
        label_visibility="collapsed",
    )

    display_results = results
    if filter_status and filter_status != "All":
        display_results = [r for r in results if r.get("call_status") == filter_status]

    for r in display_results:
        is_promoted = bool(r.get("promoted_account_id"))
        call_status = r.get("call_status", "Not Called")
        promoted_by_name = user_names.get(r.get("promoted_by"))
        promoted_text = f" · IN CRM (by {promoted_by_name})" if (is_promoted and promoted_by_name) else (" · IN CRM" if is_promoted else "")
        is_expanded = (st.session_state.get("_ds_open_expander") == r["id"])

        activities = queries.list_donut_result_activities(r["id"])

        with st.expander(
            f"{r['clinic_name']}  ·  {call_status}{promoted_text}",
            expanded=is_expanded,
        ):
            # 1. ALWAYS-VISIBLE LATEST UPDATE Highlight Box
            if activities:
                latest = activities[-1]
                latest_user = user_names.get(latest.get("user_id"), creator_name)
                latest_time = ""
                if latest.get("created_at"):
                    try:
                        dt = datetime.fromisoformat(str(latest["created_at"]).replace("Z", "+00:00")).astimezone(CENTRAL)
                        latest_time = dt.strftime("%b %-d at %-I:%M %p CT")
                    except Exception:
                        latest_time = str(latest.get("created_at", ""))[:16]
                latest_summary = latest.get("summary", "")
                if latest.get("notes") and latest["notes"] not in latest_summary:
                    latest_summary += f" — Note: {latest['notes']}"
            else:
                # Fallback for existing runs or before donut_result_activities migration
                upd_user_id = r.get("updated_by") or r.get("promoted_by") or run.get("created_by")
                latest_user = user_names.get(upd_user_id, creator_name)

                raw_time = r.get("updated_at") or r.get("promoted_at") or r.get("created_at") or run.get("created_at")
                latest_time = ""
                if raw_time:
                    try:
                        dt = datetime.fromisoformat(str(raw_time).replace("Z", "+00:00")).astimezone(CENTRAL)
                        latest_time = dt.strftime("%b %-d at %-I:%M %p CT")
                    except Exception:
                        latest_time = str(raw_time)[:16]

                if is_promoted:
                    prom_by = user_names.get(r.get("promoted_by"), latest_user)
                    latest_summary = f"Promoted to CRM by {prom_by}"
                elif call_status != "Not Called":
                    latest_summary = f"Call status updated to '{call_status}' by {latest_user}"
                    if r.get("call_notes"):
                        latest_summary += f" — Note: {r['call_notes']}"
                else:
                    latest_summary = f"Scraped and added to run by {creator_name}"

            st.markdown(
                f"<div style='background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-family:Outfit,sans-serif;'>"
                f"<div style='font-size:0.72rem;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#0284c7;display:flex;align-items:center;gap:6px;'>"
                f"<svg style='width:13px;height:13px;fill:none;stroke:#0284c7;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;' viewBox='0 0 24 24'><circle cx='12' cy='12' r='10'></circle><polyline points='12 6 12 12 16 14'></polyline></svg> "
                f"LATEST UPDATE &nbsp;·&nbsp; {latest_user} &nbsp;·&nbsp; {latest_time}</div>"
                f"<div style='font-size:0.88rem;color:#0f172a;margin-top:4px;font-weight:600;'>"
                f"{latest_summary}</div></div>",
                unsafe_allow_html=True,
            )


            # Info row
            i1, i2, i3 = st.columns(3)
            i1.markdown(f"**Phone:** {r.get('phone') or '—'}")
            i2.markdown(f"**Email:** {r.get('email') or '—'}")
            i3.markdown(f"**Dentist:** {r.get('head_dentist') or '—'}")

            st.caption(f"Address: {r.get('address') or '—'}  ·  Zone: {(r.get('inclusion_zone') or '—').title()}  ·  Class: {r.get('classification') or '—'}")
            if r.get("website"):
                st.caption(f"Website: {r['website']}")

            # Update status inputs
            c1, c2 = st.columns([1, 2])
            with c1:
                current_idx = DONUT_CALL_STATUSES.index(r.get("call_status", "Not Called")) if r.get("call_status") in DONUT_CALL_STATUSES else 0
                new_status = st.selectbox(
                    "Call status", DONUT_CALL_STATUSES,
                    index=current_idx,
                    key=f"ds_status_{r['id']}",
                    label_visibility="collapsed",
                )
            with c2:
                call_notes = st.text_input(
                    "Call notes",
                    value=r.get("call_notes") or "",
                    key=f"ds_notes_{r['id']}",
                    placeholder="Notes from the call…",
                    label_visibility="collapsed",
                )

            # Collapsible Full Activity History timeline
            if activities:
                with st.expander(f":material/history: View activity history ({len(activities)})", expanded=False):
                    for act in reversed(activities):
                        act_user = user_names.get(act.get("user_id"), "Team User")
                        act_time = ""
                        if act.get("created_at"):
                            try:
                                dt = datetime.fromisoformat(str(act["created_at"]).replace("Z", "+00:00")).astimezone(CENTRAL)
                                act_time = dt.strftime("%b %-d, %Y at %-I:%M %p CT")
                            except Exception:
                                pass
                        st.markdown(
                            f"<div style='font-size:0.82rem;font-family:Outfit,sans-serif;margin-bottom:4px;'>"
                            f"<strong>{act_user}</strong> &nbsp;·&nbsp; <span style='color:#64748b;font-size:0.78rem;'>{act_time}</span><br>"
                            f"<span style='color:#0f172a;'>{act.get('summary', '')}</span>"
                            + (f"<br><em style='color:#475569;'>Note: {act['notes']}</em>" if act.get("notes") and act["notes"] not in act.get("summary", "") else "")
                            + "</div>",
                            unsafe_allow_html=True,
                        )
                        st.markdown("<hr style='margin:4px 0 8px 0;border:0;border-top:1px solid #f1f5f9;'>", unsafe_allow_html=True)


            if not is_promoted:
                btn_cols = st.columns([1, 1.2, 1.8])
                with btn_cols[0]:
                    if st.button("Update", key=f"ds_update_{r['id']}", use_container_width=True):
                        queries.update_donut_run_result(
                            r["id"],
                            {
                                "call_status": new_status,
                                "call_notes": call_notes.strip() or None,
                            },
                            user_id=current_user_id,
                        )
                        st.session_state["_ds_open_expander"] = r["id"]
                        st.rerun()
                with btn_cols[1]:
                    if st.button("Promote to CRM", key=f"ds_promote_{r['id']}", type="primary", use_container_width=True):
                        queries.update_donut_run_result(
                            r["id"],
                            {
                                "call_status": new_status,
                                "call_notes": call_notes.strip() or None,
                            },
                            user_id=current_user_id,
                        )
                        matches = queries.find_donut_result_duplicates(r)
                        if matches:
                            st.session_state[f"ds_pending_promote_{r['id']}"] = True
                        else:
                            queries.promote_donut_result(r["id"], current_user_id or st.session_state["current_user"]["id"])
                        st.session_state["_ds_open_expander"] = r["id"]
                        st.rerun()

                if st.session_state.get(f"ds_pending_promote_{r['id']}"):
                    from views.accounts import _show_matches
                    st.error("Possible duplicate — review before promoting:")
                    _show_matches(queries.find_donut_result_duplicates(r))
                    dc1, dc2 = st.columns(2)
                    if dc1.button("Promote anyway", key=f"ds_promote_anyway_{r['id']}", icon=":material/warning:"):
                        queries.promote_donut_result(r["id"], current_user_id or st.session_state["current_user"]["id"])
                        st.session_state.pop(f"ds_pending_promote_{r['id']}", None)
                        st.session_state["_ds_open_expander"] = r["id"]
                        st.rerun()
                    if dc2.button("Discard", key=f"ds_promote_discard_{r['id']}"):
                        st.session_state.pop(f"ds_pending_promote_{r['id']}", None)
                        st.rerun()
            else:
                btn_cols = st.columns([1, 1.2, 1.2, 0.6])
                with btn_cols[0]:
                    if st.button("Update", key=f"ds_update_{r['id']}", use_container_width=True):
                        queries.update_donut_run_result(
                            r["id"],
                            {
                                "call_status": new_status,
                                "call_notes": call_notes.strip() or None,
                            },
                            user_id=current_user_id,
                        )
                        st.session_state["_ds_open_expander"] = r["id"]
                        st.rerun()
                with btn_cols[1]:
                    if st.button("View in CRM", key=f"ds_view_acct_{r['id']}", type="primary", use_container_width=True):
                        st.session_state["selected_account_id"] = r["promoted_account_id"]
                        st.switch_page("views/accounts.py")
                with btn_cols[2]:
                    if st.button("Remove from CRM", key=f"ds_unpromote_{r['id']}", use_container_width=True):
                        queries.unpromote_donut_result(r["id"], user_id=current_user_id)
                        st.session_state["_ds_open_expander"] = r["id"]
                        st.rerun()



# ── Page entry point ─────────────────────────────────────────────────────────

st.markdown(_SIDEBAR_CSS, unsafe_allow_html=True)
_init_pipeline_state()

left, right = st.columns([5, 1], vertical_alignment="center")
left.title("Donut Scraper")
if right.button("Refresh", icon=":material/refresh:", use_container_width=True, key="ds_refresh_top"):
    st.rerun()

tab_scrape, tab_runs = st.tabs([":material/map: New Scrape", ":material/list: Scrape Runs"])

with tab_scrape:
    _tab_new_scrape()

with tab_runs:
    _tab_scrape_runs()
