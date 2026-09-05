from __future__ import annotations

# Custom premium visual components for Streamlit HTML injection

def render_stage_badge(stage: str) -> str:
    """Returns a styled HTML badge for the given pipeline stage."""
    stage = (stage or "").strip()
    
    # Custom harmonious pastel palette for light mode
    colors = {
        "New Lead": {"bg": "#f1f5f9", "fg": "#475569"},            # Slate
        "Contacted": {"bg": "#ffedd5", "fg": "#c2410c"},           # Orange
        "Interested": {"bg": "#eff6ff", "fg": "#1d4ed8"},          # Blue
        "Demo Scheduled": {"bg": "#faf5ff", "fg": "#7e22ce"},      # Purple
        "Waiting on Decision": {"bg": "#fef9c3", "fg": "#854d0e"}, # Dark Yellow
        "Onboarding": {"bg": "#ecfdf5", "fg": "#047857"},          # Emerald
        "Closed Won": {"bg": "#dcfce7", "fg": "#16a34a"},          # Green
        "Closed Lost": {"bg": "#fee2e2", "fg": "#dc2626"},         # Red
        "Nurture Later": {"bg": "#e0e7ff", "fg": "#4f46e5"},       # Indigo
    }
    
    style = colors.get(stage, {"bg": "#e2e8f0", "fg": "#1e293b"})
    
    return f'''
    <span style="
        display: inline-block;
        padding: 0.25rem 0.6rem;
        font-size: 0.75rem;
        font-weight: 700;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
        vertical-align: baseline;
        border-radius: 10rem;
        background-color: {style["bg"]};
        color: {style["fg"]};
        font-family: 'Outfit', sans-serif;
        letter-spacing: 0.3px;
        border: 1px solid rgba(0, 0, 0, 0.03);
    ">{stage}</span>
    '''

def render_kpi_card(title: str, value: str | int, icon: str, color_hex: str) -> str:
    """Returns a beautiful custom card to replace standard Streamlit metric cards."""
    return f'''
    <div style="
        background: #ffffff;
        border-radius: 12px;
        padding: 16px 12px;
        border: 1px solid #e2e8f0;
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.02);
        margin-bottom: 12px;
        text-align: center;
        font-family: 'Outfit', sans-serif;
    ">
        <div style="font-size: 28px; margin-bottom: 6px;">{icon}</div>
        <div style="
            font-size: 11px;
            color: #64748b;
            text-transform: uppercase;
            font-weight: 700;
            letter-spacing: 0.6px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        ">{title}</div>
        <div style="
            font-size: 24px;
            font-weight: 800;
            color: {color_hex};
            margin-top: 6px;
        ">{value}</div>
    </div>
    '''

GLOBAL_PREMIUM_CSS = """
<style>
/* Load premium modern Google Font */
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');

html, body, [class*="css"], .stApp {
    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
}

/* Add custom styling for the sidebar acting info */
.sidebar .sidebar-content {
    background-color: #f8fafc;
}

/* Beautiful hover transitions and rounded corners for buttons */
div.stButton > button {
    border-radius: 8px !important;
    font-weight: 600 !important;
    transition: all 0.2s ease !important;
    border: 1px solid #cbd5e1 !important;
}

div.stButton > button:hover {
    border-color: #3abdaf !important;
    background-color: #f0fdfa !important;
    color: #0f766e !important;
    box-shadow: 0 2px 8px rgba(58, 189, 175, 0.15) !important;
}

/* Primary actions */
div.stButton > button[kind="primary"] {
    background-color: #3abdaf !important;
    color: #ffffff !important;
    border: none !important;
}

div.stButton > button[kind="primary"]:hover {
    background-color: #2da195 !important;
    box-shadow: 0 4px 12px rgba(58, 189, 175, 0.3) !important;
}

/* Stylize standard Streamlit expanders */
.stExpander {
    border: 1px solid #e2e8f0 !important;
    border-radius: 8px !important;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.01) !important;
    background-color: #ffffff !important;
    margin-bottom: 12px !important;
}

/* Inputs styling */
.stTextInput input, .stTextArea textarea, .stSelectbox select, .stDateInput input {
    border-radius: 8px !important;
    border-color: #e2e8f0 !important;
    font-family: 'Outfit', sans-serif !important;
}

.stTextInput input:focus, .stTextArea textarea:focus {
    border-color: #3abdaf !important;
    box-shadow: 0 0 0 1px #3abdaf !important;
}
</style>
"""
