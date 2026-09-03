"""Generates the design-canvas artboards for the AI Usage redesign.

Every value here is lifted from src/styles.css, src/overview.css and the
demo snapshot so the mockups match the running app. Run from this folder:
    python build.py
"""
import json
import math
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------- tokens (src/styles.css)
D = dict(
    bg="#0e1116", surface="#151920", surface2="#1b2029", surface3="#232935", line="#262c37",
    line_strong="#353d4b", text="#e8ecf2", text2="#c3c9d4", muted="#8b94a3", faint="#667082",
    accent="#5b8def", accent_text="#8fb3ff", ok="#3fb47f", ok_text="#6fd3a3", warn="#d99a3a",
    warn_text="#f0bd6a", bad="#e0614f", bad_text="#f4998c", codex="#6b9cf6", claude="#b48cf2",
    fable="#d69cf0", observed="#9aa4b5",
)
FONT = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
FONT_D = "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif"

# ---------------------------------------------------------------- demo data (src/data/demo.ts)
PROVIDERS = [
    dict(key="codex", name="Codex", plan="ChatGPT Pro · Weekly", left=78, expected=30, heavy=3, state="safe",
         resets="6 days 7h", resets_at="10 Sept, 03:21", runs="After reset", runs_note="on both projections",
         runs_tone="", pace=0.78, safe=0.95, hours=82,
         headline=("Lasts to reset with ", "~30% to spare", ". Even a heavier week than usual leaves 3%."),
         foot=["247 samples · 29 learned days · 89% confidence", "1 reset credit banked · never auto-redeemed",
               "observed 3 Sept, 20:05 · preview"], reset_days=6.3),
    dict(key="claude", name="Claude", plan="Claude Max · Weekly", left=95, expected=84, heavy=79, state="safe",
         resets="4 days 12h", resets_at="8 Sept, 08:03", runs="After reset", runs_note="on both projections",
         runs_tone="", pace=0.13, safe=1.16, hours=82,
         headline=("Lasts to reset with ", "~84% to spare", ". Even a heavier week than usual leaves 79%."),
         foot=["247 samples · 29 learned days · 89% confidence", "observed 3 Sept, 20:05 · preview"], reset_days=4.5),
    dict(key="fable", name="Fable 5", plan="Provider reading · Weekly", left=72, expected=41, heavy=0, state="risk",
         resets="4 days 12h", resets_at="8 Sept, 08:03", runs="Not expected", runs_note="heavier pattern: Tue 08:03",
         runs_tone="warm", pace=0.49, safe=0.88, hours=82,
         headline=("May reach the limit with only ", "~41% expected to spare",
                   ". Your heavier learned pattern may use the full allowance before reset."),
         foot=["247 samples · 29 learned days · 89% confidence", "observed 3 Sept, 20:05 · preview",
               "This device · 146 local requests · 32m tracked tokens"], reset_days=4.5),
]
STATE_COLOR = {"safe": (D["ok"], D["ok_text"]), "watch": (D["warn"], D["warn_text"]), "risk": (D["bad"], D["bad_text"])}
STATE_WORD = {"safe": "Safe", "watch": "Watch", "risk": "Risk"}

# ---------------------------------------------------------------- svg helpers
def icon_activity(size=14, color="#fff"):
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="2.2" '
            f'stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>')

def icon_refresh(size=15, color="#fff"):
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="2" '
            f'stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"></path>'
            f'<path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"></path><path d="M3 21v-5h5"></path></svg>')

def icon_info(size=14, color=D["faint"]):
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="2" '
            f'stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>')

def gauge(left, expected, fill_color, track=D["surface3"], size=118, text_color=D["text"], label_color=D["muted"], stroke=8):
    r, c = 50, 59
    circ = 2 * math.pi * r
    arc = 0.78 * circ
    start = 129.6
    def pt(fraction, radius):
        a = math.radians(start + 360 * 0.78 * fraction)
        return c + math.cos(a) * radius, c + math.sin(a) * radius
    ox, oy = pt(expected / 100, r + 5)
    ix, iy = pt(expected / 100, r - 7)
    return f'''<div style="position: relative; width: {size}px; height: {size}px; flex: 0 0 auto;">
  <svg width="{size}" height="{size}" viewBox="0 0 118 118">
    <g transform="rotate({start} {c} {c})">
      <circle cx="{c}" cy="{c}" r="{r}" fill="none" stroke="{track}" stroke-width="{stroke}" stroke-linecap="round" stroke-dasharray="{arc:.1f} {circ:.1f}"></circle>
      <circle cx="{c}" cy="{c}" r="{r}" fill="none" stroke="{fill_color}" stroke-width="{stroke}" stroke-linecap="round" stroke-dasharray="{arc * left / 100:.1f} {circ:.1f}"></circle>
    </g>
    <line x1="{ix:.1f}" y1="{iy:.1f}" x2="{ox:.1f}" y2="{oy:.1f}" stroke="{text_color}" stroke-width="2"></line>
  </svg>
  <div style="position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;">
    <div style="font-size: 22px; font-weight: 600; letter-spacing: -0.02em; line-height: 1; color: {text_color}; font-variant-numeric: tabular-nums;">{left}%</div>
    <div style="font-size: 11px; color: {label_color};">left</div>
  </div>
</div>'''

def forecast_svg(p, width=660, height=196, grid=D["surface3"], axis=D["faint"], obs=D["observed"], exp=D["ok"], heavy=D["warn"], now_c=D["faint"]):
    left, right, top, bottom = 36, 12, 16, 26
    pw, ph = width - left - right, height - top - bottom
    y = lambda v: top + (1 - v / 100) * ph
    x_now = left + pw * 0.36
    x_end = left + pw
    obs_pts = [(left, y(min(100, p["left"] + 18))), (left + pw * 0.12, y(min(100, p["left"] + 15))), (left + pw * 0.24, y(min(100, p["left"] + 8))), (x_now, y(p["left"]))]
    exp_pts = [(x_now, y(p["left"])), (x_end, y(p["expected"]))]
    hv_pts = [(x_now, y(p["left"])), (x_end, y(p["heavy"]))]
    path = lambda pts: " ".join(f"{'M' if i == 0 else 'L'}{px:.1f},{py:.1f}" for i, (px, py) in enumerate(pts))
    area = f"{path(exp_pts)} L{x_end:.1f},{y(0):.1f} L{x_now:.1f},{y(0):.1f} Z"
    ticks = "".join(f'<text x="{left + pw * f:.0f}" y="{height - 8}" text-anchor="middle">{lab}</text>' for f, lab in ((0.6, "Sat"), (0.8, "Mon"), (0.98, "Wed")))
    return f'''<svg viewBox="0 0 {width} {height}" width="100%" style="display: block; font: 500 10.5px {FONT}; fill: {axis};">
  <line x1="{left}" x2="{width - right}" y1="{y(100):.1f}" y2="{y(100):.1f}" stroke="{grid}"></line>
  <line x1="{left}" x2="{width - right}" y1="{y(50):.1f}" y2="{y(50):.1f}" stroke="{grid}"></line>
  <line x1="{left}" x2="{width - right}" y1="{y(0):.1f}" y2="{y(0):.1f}" stroke="{grid}"></line>
  <text x="5" y="{y(100) + 4:.1f}">100%</text><text x="5" y="{y(50) + 4:.1f}">50%</text><text x="5" y="{y(0) + 4:.1f}">0%</text>
  {ticks}
  <line x1="{x_now:.1f}" x2="{x_now:.1f}" y1="{top - 2}" y2="{y(0):.1f}" stroke="{now_c}" stroke-dasharray="2 3"></line>
  <text x="{x_now:.1f}" y="{height - 8}" text-anchor="middle">Now</text>
  <path d="{area}" fill="{exp}" fill-opacity="0.08"></path>
  <path d="{path(obs_pts)}" fill="none" stroke="{obs}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></path>
  <path d="{path(exp_pts)}" fill="none" stroke="{exp}" stroke-width="1.75" stroke-linecap="round"></path>
  <path d="{path(hv_pts)}" fill="none" stroke="{heavy}" stroke-width="1.5" stroke-dasharray="4 4" stroke-linecap="round"></path>
  <circle cx="{x_end:.1f}" cy="{y(p['expected']):.1f}" r="3.5" fill="{exp}"></circle>
  <circle cx="{x_end:.1f}" cy="{y(p['heavy']):.1f}" r="3.5" fill="{heavy}"></circle>
</svg>'''

def sparkline(p, width=160, height=36, obs=D["observed"], exp=D["ok"], heavy=D["warn"]):
    y = lambda v: 3 + (1 - v / 100) * (height - 6)
    xn = width * 0.38
    return f'''<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}" style="display: block;">
  <path d="M0,{y(min(100, p['left'] + 18)):.1f} L{xn * 0.6:.1f},{y(min(100, p['left'] + 8)):.1f} L{xn:.1f},{y(p['left']):.1f}" fill="none" stroke="{obs}" stroke-width="1.5"></path>
  <path d="M{xn:.1f},{y(p['left']):.1f} L{width - 2},{y(p['expected']):.1f}" fill="none" stroke="{exp}" stroke-width="1.5"></path>
  <path d="M{xn:.1f},{y(p['left']):.1f} L{width - 2},{y(p['heavy']):.1f}" fill="none" stroke="{heavy}" stroke-width="1.25" stroke-dasharray="3 3"></path>
  <line x1="{xn:.1f}" x2="{xn:.1f}" y1="2" y2="{height - 2}" stroke="{D['line_strong']}" stroke-dasharray="2 2"></line>
</svg>'''

# ---------------------------------------------------------------- shared chrome (Main direction)
def doc(body, extra_css="", bg=D["bg"], color=D["text"], width=1600, fonts_link=""):
    return f'''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  {fonts_link}
  <style>
    body {{ margin: 0; background: {bg}; color: {color}; font-family: {FONT}; font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }}
    a {{ color: {D['accent_text']}; }} a:hover {{ color: {D['text']}; }}
    * {{ box-sizing: border-box; }}
    {extra_css}
  </style>
</helmet>
<div style="width: {width}px; min-height: 100%; background: {bg};">
{body}
</div>
</x-dc>
</body>
</html>
'''

def header(active, verdict=True):
    tabs = ""
    for label, key in (("Overview", "overview"), ("Details", "details"), ("Data &amp; settings", "settings")):
        on = key == active
        tabs += (f'<div style="position: relative; display: flex; align-items: center; padding: 0 10px; font-size: 13px; font-weight: 500; '
                 f'color: {D["text"] if on else D["muted"]};">{label}'
                 f'<div style="position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px 2px 0 0; background: {D["accent"] if on else "transparent"};"></div></div>')
    chip = ""
    if verdict:
        chip = (f'<div style="display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 10px; border: 1px solid {D["line"]}; border-radius: 6px; '
                f'background: {D["surface"]}; color: {D["bad_text"]}; font-size: 12.5px; font-weight: 500; white-space: nowrap;">'
                f'<span style="width: 7px; height: 7px; border-radius: 50%; background: {D["bad"]};"></span>'
                f'<span>Fable 5 · Fable 5 weekly may hit the limit</span>'
                f'<span style="padding-left: 8px; border-left: 1px solid {D["line_strong"]}; color: {D["muted"]}; font-variant-numeric: tabular-nums;">Codex 78% · Claude 95% · Fable 72%</span></div>')
    return f'''<div style="display: flex; align-items: stretch; height: 64px; padding: 0 44px; gap: 22px; border-bottom: 1px solid {D['line']}; background: {D['bg']};">
  <div style="display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 600; letter-spacing: -0.01em;">
    <div style="width: 22px; height: 22px; border-radius: 6px; background: {D['accent']}; display: flex; align-items: center; justify-content: center;">{icon_activity()}</div>
    <span>AI Usage</span>
  </div>
  <div style="display: flex; align-items: stretch; gap: 4px;">{tabs}</div>
  <div style="display: flex; align-items: center;">{chip}</div>
  <div style="margin-left: auto; display: flex; align-items: center; gap: 14px; color: {D['muted']}; font-size: 12px; white-space: nowrap;">
    <span>Updated 3 Sept, 20:08</span>
    <div style="display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px; border-radius: 6px; background: {D['accent']}; color: #ffffff; font-size: 13px; font-weight: 500;">{icon_refresh()}<span>Refresh</span></div>
  </div>
</div>'''

def footer():
    return (f'<div style="display: flex; justify-content: space-between; padding: 0 44px 28px; color: {D["faint"]}; font-size: 12px;">'
            f'<span>Snapshot 03/09/2026, 20:08:20 · Europe/London</span><span>Local records only · Learned forecasts are estimates, not provider guarantees</span></div>')

def label(text, color=D["muted"]):
    return f'<div style="color: {color}; font-size: 12px; font-weight: 500;">{text}</div>'

def stat_cell(lbl, value, note="", value_color=D["text"], note_color=D["muted"], first=False):
    return (f'<div style="flex: 1 1 0; min-width: 0; padding: 16px 22px; border-left: {"0" if first else f"1px solid {D['line']}"};">'
            f'<div style="display: flex; align-items: center; gap: 6px; color: {D["muted"]}; font-size: 12px; font-weight: 500; min-height: 20px;">{lbl}</div>'
            f'<div style="font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin-top: 2px; line-height: 1.2; color: {value_color}; font-variant-numeric: tabular-nums;">{value}</div>'
            f'{f"<div style=\"font-size: 12px; margin-top: 4px; color: {note_color}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\">{note}</div>" if note else ""}</div>')

def stat_row(cells, margin="0"):
    return f'<div style="display: flex; align-items: stretch; background: {D["surface"]}; border: 1px solid {D["line"]}; border-radius: 10px; margin: {margin};">{"".join(cells)}</div>'

def panel(inner, style=""):
    return f'<div style="background: {D["surface"]}; border: 1px solid {D["line"]}; border-radius: 10px; padding: 22px; {style}">{inner}</div>'

def heading(title, desc="", aside=""):
    a = f'<div style="color: {D["muted"]}; font-size: 12px; padding-top: 2px; flex: 0 0 auto;">{aside}</div>' if aside else ""
    d = f'<div style="color: {D["muted"]}; font-size: 13px; margin-top: 4px; max-width: 720px;">{desc}</div>' if desc else ""
    return (f'<div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px;">'
            f'<div><div style="font-family: {FONT_D}; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.3;">{title}</div>{d}</div>{a}</div>')

# ---------------------------------------------------------------- Main: Overview
def quota_card(p):
    fill, txt = STATE_COLOR[p["state"]]
    ratio = p["pace"] / p["safe"]
    width = max(2, min(100, ratio / 1.5 * 100))
    tone = D["ok"] if ratio <= 1 else D["warn"] if ratio <= 1.2 else D["bad"]
    run_color = {"": D["text"], "warm": D["warn_text"], "hot": D["bad_text"]}[p["runs_tone"]]
    facts = "".join(
        f'<div style="min-width: 0;">{label(l)}<div style="font-size: 15px; font-weight: 600; line-height: 1.2; margin-top: 2px; color: {c}; font-variant-numeric: tabular-nums;">{v}</div>'
        f'<div style="font-size: 11.5px; color: {D["muted"]}; margin-top: 2px;">{s}</div></div>'
        for l, v, s, c in (("Resets", p["resets"], p["resets_at"], D["text"]),
                           ("Expected at reset", f'{p["expected"]}%', f'heavier end: {p["heavy"]}%', D["text"]),
                           ("Runs out", p["runs"], p["runs_note"], run_color)))
    foot = "".join(f'<div>{line}</div>' for line in p["foot"])
    return f'''<div style="display: flex; flex-direction: column; background: {D['surface']}; border: 1px solid {D['line']}; border-radius: 10px; padding: 18px 20px 14px; min-width: 0;">
  <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 14px;">
    <span style="width: 8px; height: 8px; border-radius: 2px; background: {D[p['key']]}; flex: 0 0 auto;"></span>
    <div style="display: flex; flex-direction: column; gap: 1px; min-width: 0;">
      <div style="font-family: {FONT_D}; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.25;">{p['name']}</div>
      <div style="color: {D['muted']}; font-size: 12px;">{p['plan']}</div>
    </div>
    <div style="margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: {txt};"><span style="width: 7px; height: 7px; border-radius: 50%; background: {fill};"></span>{STATE_WORD[p['state']]}</div>
  </div>
  <div style="display: grid; grid-template-columns: 118px minmax(0, 1fr); gap: 18px; align-items: center;">
    {gauge(p['left'], p['expected'], fill)}
    <div>
      <div style="font-size: 13.5px; font-weight: 500; line-height: 1.45; margin-bottom: 12px;">{p['headline'][0]}<span style="font-weight: 600; color: {txt};">{p['headline'][1]}</span><span style="color: {D['muted']}; font-weight: 400;">{p['headline'][2]}</span></div>
      <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 14px;">{facts}</div>
    </div>
  </div>
  <div style="margin: 14px 0 2px;">
    <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: {D['muted']}; margin-bottom: 6px;">
      <span style="color: {D['text2']}; font-weight: 500;">Recent pace {p['pace']:.2f}%/h</span><span style="font-variant-numeric: tabular-nums;">safe ≤ {p['safe']:.2f}%/h · {p['hours']} active hours left</span>
    </div>
    <div style="position: relative; height: 6px; border-radius: 3px; background: {D['surface3']};">
      <div style="position: absolute; left: 0; top: 0; bottom: 0; width: {width:.0f}%; border-radius: 3px; background: {tone};"></div>
      <div style="position: absolute; left: 66.7%; top: -3px; bottom: -3px; width: 2px; border-radius: 1px; background: {D['muted']};"></div>
    </div>
  </div>
  <div style="margin-top: 12px; flex: 1 1 auto; display: flex; flex-direction: column;">
    <div>{forecast_svg(p, 660, 330)}</div>
    <div style="display: flex; gap: 14px; font-size: 12px; color: {D['muted']}; margin-top: 6px;">
      <span><i style="display: inline-block; width: 10px; height: 2px; border-radius: 1px; margin-right: 6px; vertical-align: 3px; background: {D['observed']};"></i>Observed</span>
      <span><i style="display: inline-block; width: 10px; height: 2px; border-radius: 1px; margin-right: 6px; vertical-align: 3px; background: {D['ok']};"></i>Expected</span>
      <span><i style="display: inline-block; width: 10px; height: 2px; border-radius: 1px; margin-right: 6px; vertical-align: 3px; background: {D['warn']};"></i>Heavier</span>
    </div>
  </div>
  <div style="display: flex; flex-direction: column; gap: 4px; margin-top: auto; padding-top: 12px; border-top: 1px solid {D['line']}; color: {D['muted']}; font-size: 12px;">{foot}</div>
</div>'''

def overview_main():
    cards = "".join(quota_card(p) for p in PROVIDERS)
    strip = stat_row([
        stat_cell(f"API-equivalent cost · last 30 days {icon_info()}", "At least £1,755.87", "lower bound: some models are unpriced", first=True),
        stat_cell("Subscription value", "6.1×", "£1,755.87 of API value for £290.17 in fees"),
        stat_cell("Cache discount", "£10,202", "85% avoided", note_color=D["ok_text"]),
        stat_cell("Price coverage", "96%", "Unpriced: preview-unpriced-model"),
    ], margin="16px 0 0")
    body = header("overview") + f'''
<div style="padding: 26px 44px 34px; display: flex; flex-direction: column; min-height: 872px;">
  <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; flex: 1 1 auto; align-items: stretch;">{cards}</div>
  {strip}
</div>''' + footer()
    return doc(body)

# ---------------------------------------------------------------- Main: Details
def bars_chart(width=1000, height=300):
    left, right, top, bottom = 56, 20, 20, 44
    pw, ph = width - left - right, height - top - bottom
    codex = [12 + math.sin(i / 2.8) * 8 + i * 0.6 for i in range(30)]
    claude = [8 + math.cos(i / 3.2) * 5 + i * 0.32 for i in range(30)]
    mx = max(c + k for c, k in zip(codex, claude)) * 1.15
    slot = pw / 30
    bw = slot * 0.72
    y = lambda v: top + ph - v / mx * ph
    bars = ""
    for i, (c, k) in enumerate(zip(codex, claude)):
        x = left + i * slot + (slot - bw) / 2
        bars += f'<rect x="{x:.1f}" y="{y(c):.1f}" width="{bw:.1f}" height="{y(0) - y(c):.1f}" rx="1.5" fill="{D["codex"]}" fill-opacity="0.85"></rect>'
        bars += f'<rect x="{x:.1f}" y="{y(c + k):.1f}" width="{bw:.1f}" height="{y(c) - y(c + k) - 2:.1f}" rx="1.5" fill="{D["claude"]}" fill-opacity="0.85"></rect>'
    grid = ""
    for f in (0, 0.25, 0.5, 0.75, 1):
        grid += f'<line x1="{left}" x2="{width - right}" y1="{y(mx * f):.1f}" y2="{y(mx * f):.1f}" stroke="{D["surface3"]}"></line><text x="4" y="{y(mx * f) + 4:.1f}">£{mx * f:,.0f}</text>'
    ticks = "".join(f'<text x="{left + i * slot + slot / 2:.1f}" y="{height - 14}" text-anchor="middle">{lab}</text>'
                    for i, lab in ((1, "Thu 6"), (5, "Mon 10"), (9, "Fri 14"), (13, "Tue 18"), (17, "Sat 22"), (21, "Wed 26"), (25, "Sun 30"), (29, "Thu 3")))
    return f'<svg viewBox="0 0 {width} {height}" width="100%" style="display: block; font: 500 10.5px {FONT}; fill: {D["faint"]}; margin-top: 8px;">{grid}{bars}{ticks}</svg>'

def daily_codex_chart(width=1320, height=300):
    left, right, top, bottom = 64, 40, 14, 40
    pw, ph = width - left - right, height - top - bottom
    vals = [2_400_000 + math.sin(i / 2.4) * 1_100_000 + i * 90_000 for i in range(30)]
    mx = max(vals)
    slot = pw / 30
    bars = "".join(f'<rect x="{left + i * slot + slot * 0.14:.1f}" y="{top + ph - v / mx * ph:.1f}" width="{slot * 0.72:.1f}" height="{v / mx * ph:.1f}" rx="2" fill="{D["codex"]}" fill-opacity="0.8"></rect>' for i, v in enumerate(vals))
    grid = "".join(f'<line x1="{left}" x2="{width - right}" y1="{top + ph - ph * f:.1f}" y2="{top + ph - ph * f:.1f}" stroke="{D["surface3"]}"></line><text x="4" y="{top + ph - ph * f + 4:.1f}">{lab}</text>' for f, lab in ((0, "0"), (0.5, "2.6m"), (1, "5.2m")))
    ticks = "".join(f'<text x="{left + i * slot + slot / 2:.1f}" y="{height - 10}" text-anchor="middle">{lab}</text>' for i, lab in ((1, "Thu 6"), (5, "Mon 10"), (9, "Fri 14"), (13, "Tue 18"), (17, "Sat 22"), (21, "Wed 26"), (25, "Sun 30"), (29, "Thu 3")))
    return f'<svg viewBox="0 0 {width} {height}" width="100%" style="display: block; font: 500 10.5px {FONT}; fill: {D["faint"]}; margin-top: 6px;">{grid}{bars}{ticks}</svg>'

def mix(hex_a, hex_b, t):
    a = tuple(int(hex_a[i:i + 2], 16) for i in (1, 3, 5))
    b = tuple(int(hex_b[i:i + 2], 16) for i in (1, 3, 5))
    return "#%02x%02x%02x" % tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))

def heatmap():
    cells = '<span></span>' + "".join(f'<span style="text-align: center; padding-top: 2px;">{f"{h:02d}" if h % 3 == 0 else ""}</span>' for h in range(24))
    for di, day in enumerate(("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")):
        cells += f'<span style="align-self: center; padding-right: 6px; text-align: right;">{day}</span>'
        for h in range(24):
            working = 8 <= h < 22 and day != "Sun"
            peak = math.exp(-((h - 15) ** 2) / 18) * (0.5 if day == "Sat" else 1)
            level = max(0.12, math.sqrt(peak)) if working else 0
            cells += f'<i style="display: block; height: 18px; border-radius: 3px; background: {mix(D["surface3"], D["accent"], level)};"></i>'
    legend = "".join(f'<i style="display: inline-block; width: 14px; height: 9px; border-radius: 2px; background: {mix(D["surface3"], D["accent"], t)};"></i>' for t in (0, 0.25, 0.5, 0.75, 1))
    return panel(heading("When the work happens", "API-equivalent cost by local hour and weekday over the last 30 days. Busiest: Mon 15:00, £14.00.") +
                 f'<div style="display: grid; grid-template-columns: 34px repeat(24, minmax(0, 1fr)); gap: 3px; font-size: 11px; color: {D["muted"]}; font-variant-numeric: tabular-nums;">{cells}</div>'
                 f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 11.5px; color: {D["muted"]};">Less {legend} More</div>', "margin-top: 18px;")

def table(headers, rows, num_cols):
    th = "".join(f'<th style="text-align: {"right" if i in num_cols else "left"}; color: {D["muted"]}; font-weight: 500; font-size: 12px; padding: 8px 10px; border-bottom: 1px solid {D["line"]}; white-space: nowrap;">{h}</th>' for i, h in enumerate(headers))
    trs = ""
    for r, row in enumerate(rows):
        tds = "".join(f'<td style="text-align: {"right" if i in num_cols else "left"}; padding: 10px; color: {D["text2"]}; font-size: 13px; vertical-align: top; border-top: {"0" if r == 0 else f"1px solid {D['line']}"}; font-variant-numeric: tabular-nums;">{c}</td>' for i, c in enumerate(row))
        trs += f'<tr>{tds}</tr>'
    return f'<table style="width: 100%; border-collapse: collapse;"><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>'

def strong(t):
    return f'<span style="color: {D["text"]}; font-weight: 600;">{t}</span>'

def small(t, color=D["muted"]):
    return f'<div style="font-size: 12px; color: {color}; margin-top: 2px;">{t}</div>'

def cycle_card(name, key, peaks, rows):
    bars = "".join(f'<div style="flex: 1; height: 100%; display: flex; align-items: flex-end; border-bottom: 1px solid {D["line_strong"]};"><i style="display: block; width: 100%; height: {pk}%; background: {D["accent"] if i == len(peaks) - 1 else D["faint"]}; opacity: {1 if i == len(peaks) - 1 else 0.7}; border-radius: 2px 2px 0 0;"></i></div>' for i, pk in enumerate(peaks))
    return f'''<div style="border: 1px solid {D['line']}; border-radius: 8px; padding: 14px 16px; background: {D['surface2']}; min-width: 0;">
  <div style="display: flex; justify-content: space-between; align-items: baseline;"><span style="font-weight: 600; display: inline-flex; align-items: center; gap: 8px;"><span style="width: 8px; height: 8px; border-radius: 2px; background: {D[key]};"></span>{name}</span><span style="color: {D['muted']}; font-size: 12px;">{len(peaks)} windows</span></div>
  <div style="display: flex; align-items: flex-end; gap: 5px; height: 56px; margin: 12px 0 6px;">{bars}</div>
  {table(["Window ends", "Peak used", "Readings", "Tokens", "API-equivalent"], rows, {1, 2, 3, 4})}
</div>'''

def details_main():
    lead = f'''<div style="display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin: 4px 2px 18px;">
  <div>
    <div style="font-family: {FONT_D}; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 4px;">Costs <span style="font-size: 13px; color: {D['muted']}; font-weight: 500;">last 30 days, at API prices {icon_info()}</span></div>
    <div style="color: {D['muted']}; font-size: 13px; max-width: 760px;">Every tracked token is repriced with the current catalogue row for its model. GBP uses the manually saved rate of 0.736 per USD. The lower bound excludes Codex preview-unpriced-model (11.5m tokens).</div>
  </div>
  <div style="display: flex; gap: 2px; padding: 2px; border: 1px solid {D['line']}; border-radius: 7px; background: {D['surface2']};">
    <span style="padding: 0 10px; height: 26px; display: flex; align-items: center; border-radius: 5px; font-size: 12.5px; font-weight: 500; color: {D['muted']};">7d</span>
    <span style="padding: 0 10px; height: 26px; display: flex; align-items: center; border-radius: 5px; font-size: 12.5px; font-weight: 500; background: {D['surface']}; box-shadow: 0 0 0 1px {D['line_strong']};">30d</span>
    <span style="padding: 0 10px; height: 26px; display: flex; align-items: center; border-radius: 5px; font-size: 12.5px; font-weight: 500; color: {D['muted']};">90d</span>
  </div>
</div>'''
    ribbon = stat_row([
        stat_cell(f"API-equivalent cost {icon_info()}", "≥ £1,755.87", "Lower bound from priced token records", first=True),
        stat_cell("Cache discount", "£10,202", "85% below the uncached value"),
        stat_cell("Cache hit rate", "69%", "of prompt tokens read from cache"),
        stat_cell("Tokens tracked", "286.4m", "across Codex and Claude"),
        stat_cell("Price coverage", "96%", "Unpriced: Codex preview-unpriced-model (11.5m tokens)"),
    ], margin="0 0 18px")
    legend = (f'<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">'
              f'<div style="display: flex; gap: 16px; font-size: 12px; color: {D["muted"]};">'
              + "".join(f'<span><i style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; background: {c};"></i>{n}</span>' for n, c in (("Total", D["text2"]), ("Codex", D["codex"]), ("Claude + Fable", D["claude"]))) +
              f'</div><div style="display: flex; gap: 2px; padding: 2px; border: 1px solid {D["line"]}; border-radius: 7px; background: {D["surface2"]}; font-size: 12.5px; font-weight: 500;">'
              f'<span style="padding: 0 10px; height: 26px; display: flex; align-items: center; border-radius: 5px; background: {D["surface"]}; box-shadow: 0 0 0 1px {D["line_strong"]};">Stacked</span>'
              f'<span style="padding: 0 10px; height: 26px; display: flex; align-items: center; color: {D["muted"]};">Lines</span></div></div>')
    cost_panel = panel(heading("Daily cost", "API-equivalent value of each day's tracked tokens.") + legend + bars_chart())
    savings = panel(heading("Cache savings") + f'''
<div style="margin-top: 8px;"><div style="font-size: 30px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1;">85%</div><div style="color: {D['muted']}; font-size: 13px;">of the uncached value avoided</div></div>
<div style="color: {D['muted']}; font-size: 13px; margin-top: 10px;">Cache reads with known prices are compared with the same tokens at the uncached input rate. The difference is the discount.</div>
<div style="margin-top: auto; padding-top: 20px; display: grid; gap: 14px;">
  <div style="display: grid; gap: 6px; font-size: 12px; color: {D['muted']};"><span style="display: flex; justify-content: space-between;">With cache <b style="color: {D['text']}; font-weight: 600;">£1,755.87</b></span><i style="display: block; height: 8px; border-radius: 4px; background: {D['surface3']};"><i style="display: block; height: 100%; width: 14.7%; border-radius: 4px; background: {D['ok']};"></i></i></div>
  <div style="display: grid; gap: 6px; font-size: 12px; color: {D['muted']};"><span style="display: flex; justify-content: space-between;">Without cache <b style="color: {D['text']}; font-weight: 600;">£11,957.87</b></span><i style="display: block; height: 8px; border-radius: 4px; background: {D['surface3']};"><i style="display: block; height: 100%; width: 100%; border-radius: 4px; background: {D['faint']};"></i></i></div>
</div>''', "display: flex; flex-direction: column;")
    grid = f'<div style="display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 0.8fr); gap: 18px;">{cost_panel}{savings}</div>'
    rollups = stat_row([
        stat_cell("Today", "£35.58", "API-equivalent so far today", first=True),
        stat_cell("Last 7 days", "£305.72", f'<span style="color: {D["ok_text"]};">−1%</span> vs previous 7 days'),
        stat_cell("September to date", "£113.44", "3 of 30 days"),
        stat_cell("Projected for September", "£1,134.38", "at the month-to-date daily average"),
    ], margin="18px 0 0")
    cycles = panel(heading("Reset cycles", "Each past window of the primary bucket: the peak percentage the provider reported and what that window's tokens are worth at the current catalogue. The open window is marked as current.") +
                   f'<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px;">'
                   + cycle_card("Codex", "codex", [68, 74, 91, 22], [[f'Thu 10 Sept <span style="color: {D["accent_text"]}; margin-left: 4px;">current</span>', "22%", "212", "25.5m", "£212.4"], ["Thu 3 Sept", "91%", "640", "132.3m", "£1,102.3"], ["Thu 27 Aug", "74%", "640", "103.7m", "£864.1"], ["Thu 20 Aug", "68%", "640", "94.9m", "£790.7"]])
                   + cycle_card("Claude", "claude", [29, 41, 34, 5], [[f'Tue 8 Sept <span style="color: {D["accent_text"]}; margin-left: 4px;">current</span>', "5%", "212", "7.3m", "£61.2"], ["Tue 1 Sept", "34%", "640", "36.3m", "£302.9"], ["Tue 25 Aug", "41%", "640", "46.6m", "£388.6"], ["Tue 18 Aug", "29%", "640", "28.8m", "£240.1"]])
                   + cycle_card("Fable 5", "fable", [63, 88, 28], [[f'Tue 8 Sept <span style="color: {D["accent_text"]}; margin-left: 4px;">current</span>', "28%", "212", "47.8m", "£398.7"], ["Tue 1 Sept", "88%", "640", "145.5m", "£1,212.5"], ["Tue 25 Aug", "63%", "640", "100.8m", "£840.2"]])
                   + '</div>', "margin-top: 18px;")
    projects = panel(heading("By project", "Grouped by the working directory each session ran in. Only the folder path is recorded, never prompts.") +
                     table(["Project", "Sources", "Sessions", "Last activity", "Tokens", "Coverage", "API-equivalent"], [
                         [strong("ai-usage") + small("C:\\Users\\you\\Documents\\Codex\\ai-usage"), "Claude, Codex", "14", "2 Sept, 20:03", "53.2m", "93%", f'<span style="color: {D["warn_text"]}; font-weight: 600;">≥ £1,231.74</span>{small("Partly unpriced")}'],
                         [strong("architecture-review") + small("C:\\Users\\you\\Documents\\Claude\\architecture-review"), "Claude", "3", "1 Sept, 20:03", "32m", "100%", strong("£398.74")],
                         [strong("No project recorded"), "Claude", "6", "29 Aug, 20:03", "44.9m", "88%", f'<span style="color: {D["warn_text"]}; font-weight: 600;">≥ £125.39</span>{small("Partly unpriced")}'],
                     ], {2, 4, 5, 6}), "margin-top: 18px;")
    daily = panel(heading("Daily Codex usage", "Daily token totals reported by the local Codex service for the selected period, separate from the reconstructed per-session costs.") + daily_codex_chart(), "margin-top: 18px;")
    models = panel(heading("By model", aside="Prices are editable under Data &amp; settings") +
                   table(["Model", "Input", "Cache read", "Write 5m", "Write 1h", "Output (reasoning subset)", "Coverage", "API-equivalent"], [
                       [small("Codex") + strong("gpt-5.6-sol"), "30.2m", "23.4m", "0", "0", "11.5m" + small("2.1m reasoning"), "100%", strong("£1,128.32")],
                       [small("Claude") + strong("claude-fable-5"), "4.9m", "22m", "1.2m", "0.3m", "3.6m" + small("0 reasoning"), "100%", strong("£398.74")],
                       [small("Claude") + strong("claude-opus-5"), "7.1m", "31.2m", "1.6m", "0.3m", "4.7m" + small("0 reasoning"), "88%", strong("£228.81")],
                   ], {1, 2, 3, 4, 5, 6, 7}), "margin-top: 18px;")
    sessions = panel(heading("Largest sessions") +
                     table(["Source", "Project", "Session", "Model", "Last activity", "Tokens", "API-equivalent"], [
                         [f'<i style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 7px; background: {D["codex"]};"></i>Codex', strong("ai-usage"), f'<code style="font-size: 12px; background: {D["surface2"]}; border: 1px solid {D["line"]}; border-radius: 4px; padding: 1px 5px;">4f1c9a2e</code>', "gpt-5.6-sol", "2 Sept, 20:03", "18.4m", strong("£103.42")],
                         [f'<i style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 7px; background: {D["claude"]};"></i>Claude', strong("architecture-review"), f'<code style="font-size: 12px; background: {D["surface2"]}; border: 1px solid {D["line"]}; border-radius: 4px; padding: 1px 5px;">b83d10f7</code>', "claude-fable-5", "1 Sept, 20:03", "5.2m", strong("£64.18")],
                     ], {5, 6}), "margin-top: 18px;")
    body = header("details") + f'<div style="padding: 26px 44px 34px;">{lead}{ribbon}{grid}{rollups}{heatmap()}{cycles}{projects}{daily}{models}{sessions}</div>' + footer()
    return doc(body)

# ---------------------------------------------------------------- Main: Settings
def field(lbl, value, suffix="", width="100%"):
    sfx = f'<span style="position: absolute; right: 10px; top: 8px; font-size: 11.5px; color: {D["muted"]};">{suffix}</span>' if suffix else ""
    return (f'<div style="min-width: 0;"><div style="color: {D["muted"]}; font-size: 12px; font-weight: 500; margin-bottom: 6px;">{lbl}</div>'
            f'<div style="position: relative; height: 32px; border-radius: 6px; border: 1px solid {D["line_strong"]}; background: {D["surface"]}; padding: 0 10px; display: flex; align-items: center; font-size: 13px; width: {width};">{value}{sfx}</div></div>')

def select(lbl, value):
    chevron = f'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="{D["muted"]}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>'
    return field(lbl, f'<span style="flex: 1;">{value}</span>{chevron}')

def toggle(title, desc, on=True):
    return (f'<div style="display: flex; align-items: center; gap: 14px; padding: 12px 0; border-top: 1px solid {D["line"]};">'
            f'<div style="flex: 1;"><div style="font-weight: 600;">{title}</div><div style="color: {D["muted"]}; font-size: 12.5px; margin-top: 2px;">{desc}</div></div>'
            f'<div style="width: 36px; height: 20px; border-radius: 10px; background: {D["accent"] if on else D["line_strong"]}; position: relative; flex: none;"><i style="position: absolute; top: 3px; left: {19 if on else 3}px; width: 14px; height: 14px; border-radius: 50%; background: #ffffff;"></i></div></div>')

def note(title, text):
    return (f'<div style="display: flex; gap: 14px; border-radius: 8px; padding: 12px 14px; background: {D["surface2"]}; border: 1px solid {D["line"]}; color: {D["muted"]}; margin-top: 14px;">'
            f'<div><div style="color: {D["text"]}; font-weight: 600; font-size: 13px; margin-bottom: 2px;">{title}</div><div style="font-size: 12.5px; line-height: 1.5;">{text}</div></div></div>')

def button(text, primary=False):
    if primary:
        return f'<span style="display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border-radius: 6px; background: {D["accent"]}; color: #ffffff; font-size: 13px; font-weight: 500;">{text}</span>'
    return f'<span style="display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border-radius: 6px; background: {D["surface"]}; border: 1px solid {D["line_strong"]}; font-size: 13px; font-weight: 500;">{text}</span>'

def source_row(mark, key, name, detail, status, ev, scan, action=""):
    act = f'<div>{button(action)}</div>' if action else '<div></div>'
    return f'''<div style="display: grid; grid-template-columns: 43px minmax(260px, 1fr) minmax(150px, 0.4fr) auto; align-items: center; gap: 14px; padding: 13px 0; border-bottom: 1px solid {D['line']};">
  <span style="width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 12px; color: {D[key]}; background: {D['surface2']}; border: 1px solid {D['line']};">{mark}</span>
  <div style="min-width: 0;"><div style="font-weight: 600;">{name}</div><div style="color: {D['muted']}; font-size: 12px; margin-top: 2px;">{detail}</div></div>
  <div style="font-size: 12px; color: {D['muted']};"><div style="display: inline-flex; align-items: center; gap: 6px; color: {D['ok_text']}; font-weight: 500;"><span style="width: 7px; height: 7px; border-radius: 50%; background: currentColor;"></span>{status}</div><div style="margin-top: 2px;">Evidence · {ev}</div><div>Scan · {scan}</div></div>
  {act}
</div>'''

def settings_main():
    nav_items = ["Sources", "Forecast", "Alerts", "Appearance &amp; updates", "API pricing", "Storage &amp; export", "Manual observation", "Diagnostics"]
    nav = "".join(f'<div style="padding: 7px 10px; border-radius: 6px; font-size: 13px; font-weight: 500; color: {D["text"] if i == 0 else D["muted"]}; background: {D["surface2"] if i == 0 else "transparent"};">{n}</div>' for i, n in enumerate(nav_items))
    sidebar = f'''<div style="position: sticky; top: 0;">
  <div style="font-family: {FONT_D}; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; padding: 0 10px; margin-bottom: 4px;">Settings</div>
  <div style="color: {D['muted']}; font-size: 12.5px; padding: 0 10px; margin-bottom: 16px;">Everything stays on this PC. Nothing is uploaded.</div>
  <div style="display: flex; flex-direction: column; gap: 1px;">{nav}</div>
</div>'''
    sources = panel(heading("Sources", "Local files and official usage surfaces already on this PC. Nothing is fetched from the web.") +
                    f'<div style="border-top: 1px solid {D["line"]}; margin-top: 4px;">'
                    + source_row("Cx", "codex", "Codex", "Official local quota and session records found.", "Connected", "3 Sept, 19:59", "3 Sept, 20:01")
                    + source_row("Cl", "claude", "Claude", "Official Claude allowance evidence was refreshed; scanned 96 transcript messages.", "Connected", "3 Sept, 19:52", "3 Sept, 20:01", "Enable fallback helper")
                    + source_row("F5", "fable", "Fable 5", "Official model-scoped Fable allowance and actual local activity.", "Connected", "3 Sept, 19:52", "3 Sept, 20:01")
                    + '</div>'
                    + f'<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 16px;">{select("Collect automatically", "Every 15 minutes")}</div>'
                    + note("Background collection", "Alerts, scheduled backups, and the forecast are only as current as the last collection. While this is on, the app also collects when the window is reopened and when Windows wakes. Collection runs in a separate process, so a slow scan never freezes the dashboard."))
    days = "".join(f'<span style="display: inline-flex; align-items: center; justify-content: center; height: 28px; min-width: 44px; padding: 0 10px; border-radius: 5px; font-size: 12.5px; font-weight: 500; background: {mix(D["surface"], D["accent"], 0.16)}; color: {D["accent_text"]}; border: 1px solid {mix(D["line_strong"], D["accent"], 0.45)};">{d}</span>' for d in ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"))
    forecast = panel(heading("Forecast", "History is weighted by recency, hour, weekday, and current momentum. Active hours define when future use is likely, not a flat burn rate.") +
                     f'<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 16px;">{select("Active day starts", "08:00")}{select("Active day ends", "22:00")}{field("New-source fallback", "0.35", "% / hour")}</div>'
                     f'<div style="display: flex; gap: 6px; margin-top: 14px; flex-wrap: wrap;">{days}</div>'
                     f'<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 14px;">{field("Keep in reserve", "0", "% of allowance")}</div>'
                     + note("Budget mode", "The reserve is the share of each allowance you want untouched at reset, for example to keep the weekend free. The safe pace spends only what is above it, and a projection that would eat into it is shown as a watch state. The forecast itself still reports what will actually happen.")
                     + note("Three independent learners", "Codex, overall Claude, and Fable 5 build their own history. The heavier forecast uses the busy end of each source's real observed pattern."))
    alerts = panel(heading("Alerts", "Desktop notifications from the tray process. They fire after a collection, so they are only as current as the collection interval.") +
                   f'<div style="display: grid; grid-template-columns: repeat(2, minmax(180px, 300px)); gap: 14px; margin-top: 16px;">{field("Risk above safe pace", "1.2", "× safe pace")}{field("Usage watch threshold", "90", "% used")}</div>'
                   f'<div style="margin-top: 8px;">'
                   + toggle("Pace notifications", "When learned use is projected to reach the cap before reset. One notification per episode, with the earliest run-out time.")
                   + toggle("Reset notifications", "When a weekly or five-hour window rolls over and the full allowance is available again.")
                   + toggle("Fallback notifications", "When a collector that was healthy starts serving cached readings, so a stale dashboard is never a surprise.")
                   + toggle("Daily digest", "One summary a day with every allowance and the earliest run-out.", on=False)
                   + '</div>'
                   + f'<div style="display: grid; grid-template-columns: repeat(2, minmax(180px, 300px)); gap: 14px; margin-top: 8px; opacity: 0.55;">{select("Digest time", "09:00")}</div>'
                   + f'<div style="display: flex; gap: 14px; align-items: center; border-radius: 8px; padding: 12px 14px; background: {D["surface2"]}; border: 1px solid {D["line"]}; margin-top: 14px;"><div style="flex: 1;"><div style="font-weight: 600;">Snooze alerts</div><div style="color: {D["muted"]}; font-size: 12.5px;">Pause every notification for a while without changing the settings above.</div></div><div style="display: flex; gap: 8px;">{button("1h")}{button("6h")}{button("24h")}</div></div>'
                   + toggle("Launch with Windows", "Keep the tray indicator ready for quick checks.", on=False))
    appearance = panel(heading("Appearance &amp; updates") +
                       f'<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 16px;">{select("Theme", "Follow Windows")}</div>'
                       f'<div style="margin-top: 8px;">{toggle("Check for updates automatically", "Fetches a version manifest from the release feed shortly after launch and every few hours. No usage data is sent.")}</div>'
                       f'<div style="display: flex; gap: 14px; align-items: center; border-radius: 8px; padding: 12px 14px; background: {D["surface2"]}; border: 1px solid {D["line"]}; margin-top: 14px;"><div style="flex: 1;"><div style="font-weight: 600;">Version 1.0.13 · up to date</div><div style="color: {D["muted"]}; font-size: 12.5px;">Updates install through the standard setup program and keep the local database.</div></div>{button("Check now")}</div>')
    price_input = lambda v: f'<div style="height: 32px; min-width: 92px; border-radius: 6px; border: 1px solid {D["line_strong"]}; background: {D["surface"]}; padding: 0 10px; display: flex; align-items: center; font-size: 13px; font-variant-numeric: tabular-nums;">{v}</div>'
    save_btn = f'<span style="display: inline-flex; width: 32px; height: 32px; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid {D["line_strong"]}; background: {D["surface"]}; color: {D["accent_text"]};"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path></svg></span>'
    price_rows = [
        [strong("gpt-5.6-sol") + small("Row effective 1 Aug 2026 · source reference developers.openai.com"), price_input("4"), price_input("5"), price_input("5"), price_input("0.4"), price_input("20"), save_btn],
        [strong("gpt-5.6-terra") + small("Row effective 1 Aug 2026 · source reference developers.openai.com"), price_input("2"), price_input("2.5"), price_input("2.5"), price_input("0.2"), price_input("12"), save_btn],
        [strong("claude-fable-5") + small("Row effective 1 Aug 2026 · source reference platform.claude.com"), price_input("10"), price_input("12.5"), price_input("20"), price_input("1"), price_input("50"), save_btn],
        [strong("claude-opus-5") + small("Row effective 1 Aug 2026 · source reference platform.claude.com"), price_input("5"), price_input("6.25"), price_input("10"), price_input("0.5"), price_input("25"), save_btn],
    ]
    pricing = panel(heading("API pricing", "USD per million tokens. Five-minute and one-hour cache writes are priced separately. Detected models without a price appear first so the estimate can be completed here.") +
                    f'<div style="display: grid; grid-template-columns: repeat(2, minmax(180px, 300px)); gap: 14px; margin-top: 16px;">{select("Display currency", "GBP · £")}{field("One USD equals (manual display rate)", "0.736")}</div>'
                    f'<div style="display: grid; grid-template-columns: repeat(2, minmax(180px, 300px)); gap: 14px; margin-top: 16px;">{field("Codex subscription (USD per month)", "200")}{field("Claude subscription (USD per month)", "200")}</div>'
                    + note("Subscription value", "With a monthly fee set, the Overview compares the API-equivalent value of the period with the fees for the same number of days. Leave a fee at zero to hide the ratio. Fees are compared, not charged.")
                    + f'<div style="margin-top: 14px;">{table(["Model / provenance", "Input", "Write 5m", "Write 1h", "Cache read", "Output", ""], price_rows, set())}</div>')
    storage = panel(heading("Storage &amp; export", "Scheduled backups write both the database and a readable .aiusage.json export, with automatic retention.") +
                    f'<div style="display: grid; grid-template-columns: repeat(2, minmax(180px, 300px)); gap: 14px; margin-top: 16px;">{select("Backup schedule", "Daily")}{field("Backup sets kept", "30")}</div>'
                    f'<div style="display: grid; grid-template-columns: 80px minmax(0, 1fr) auto; gap: 10px; align-items: center; margin-top: 10px; padding: 9px 12px; border: 1px solid {D["line"]}; border-radius: 6px; background: {D["surface2"]};"><span style="color: {D["muted"]}; font-size: 12px; font-weight: 500;">Database</span><code style="font-family: Cascadia Mono, Consolas, monospace; font-size: 12px; color: {D["text2"]};">C:\\Users\\you\\AppData\\Roaming\\ai-usage\\ai-usage.sqlite</code><span style="color: {D["muted"]}; font-size: 12px;">4.9 MB</span></div>'
                    f'<div style="display: grid; grid-template-columns: 80px minmax(0, 1fr) auto; gap: 10px; align-items: center; margin-top: 10px; padding: 9px 12px; border: 1px solid {D["line"]}; border-radius: 6px; background: {D["surface2"]};"><span style="color: {D["muted"]}; font-size: 12px; font-weight: 500;">Backups</span><code style="font-family: Cascadia Mono, Consolas, monospace; font-size: 12px; color: {D["text2"]};">C:\\Users\\you\\Documents\\AI Usage\\Backups</code><span></span></div>'
                    f'<div style="display: flex; gap: 8px; margin-top: 14px;">{button("Back up now", True)}{button("Restore from backup…")}{button("Open backup folder")}</div>'
                    f'<div style="display: flex; gap: 14px; align-items: center; border-radius: 8px; padding: 12px 14px; background: {D["surface2"]}; border: 1px solid {D["line"]}; margin-top: 14px;"><div style="flex: 1;"><div style="font-weight: 600;">Export</div><div style="color: {D["muted"]}; font-size: 12.5px;">A CSV of the token ledger with the current-catalogue value per record, or a plain-text summary of every allowance for pasting into a message.</div></div><div style="display: flex; gap: 8px; align-items: center;">{select("", "Last 90 days").replace("margin-bottom: 6px;", "display: none;").replace("width: 100%", "width: 150px")}{button("Export CSV…")}{button("Copy summary")}</div></div>')
    body = header("settings") + f'''
<div style="padding: 26px 44px 34px; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start;">
  {sidebar}
  <div style="display: flex; flex-direction: column; gap: 16px; min-width: 0;">{sources}{forecast}{alerts}{appearance}{pricing}{storage}</div>
</div>''' + footer()
    return doc(body)

# ---------------------------------------------------------------- Direction B: dense console
def overview_dense():
    rows = ""
    for p in PROVIDERS:
        fill, txt = STATE_COLOR[p["state"]]
        ratio = p["pace"] / p["safe"]
        tone = D["ok"] if ratio <= 1 else D["warn"] if ratio <= 1.2 else D["bad"]
        run_color = {"": D["text"], "warm": D["warn_text"], "hot": D["bad_text"]}[p["runs_tone"]]
        rows += f'''<div style="display: grid; grid-template-columns: 180px 230px 130px 130px 90px 160px 190px 1fr; align-items: center; gap: 18px; padding: 14px 18px; border-top: 1px solid {D['line']}; font-variant-numeric: tabular-nums;">
  <div style="display: flex; align-items: center; gap: 10px;"><span style="width: 8px; height: 8px; border-radius: 2px; background: {D[p['key']]};"></span><div><div style="font-weight: 600; font-size: 13px;">{p['name']}</div><div style="color: {D['muted']}; font-size: 11.5px;">{p['plan']}</div></div></div>
  <div style="display: flex; align-items: center; gap: 10px;"><div style="flex: 1; height: 8px; border-radius: 4px; background: {D['surface3']}; position: relative;"><div style="position: absolute; left: 0; top: 0; bottom: 0; width: {p['left']}%; border-radius: 4px; background: {fill};"></div><div style="position: absolute; left: {p['expected']}%; top: -3px; bottom: -3px; width: 2px; background: {D['text2']};"></div></div><span style="width: 42px; text-align: right; font-weight: 600; font-size: 15px;">{p['left']}%</span></div>
  <div><div style="font-weight: 600;">{p['resets']}</div><div style="color: {D['muted']}; font-size: 11.5px;">{p['resets_at']}</div></div>
  <div><div style="font-weight: 600;">{p['expected']}%</div><div style="color: {D['muted']}; font-size: 11.5px;">heavier {p['heavy']}%</div></div>
  <div style="display: flex; align-items: center; gap: 6px; font-weight: 500; color: {txt};"><span style="width: 7px; height: 7px; border-radius: 50%; background: {fill};"></span>{STATE_WORD[p['state']]}</div>
  <div><div style="font-weight: 600; color: {run_color};">{p['runs']}</div><div style="color: {D['muted']}; font-size: 11.5px;">{p['runs_note']}</div></div>
  <div><div style="display: flex; justify-content: space-between; font-size: 11.5px; margin-bottom: 4px;"><span style="color: {D['text2']}; font-weight: 500;">{p['pace']:.2f}%/h</span><span style="color: {D['muted']};">safe ≤ {p['safe']:.2f}</span></div><div style="position: relative; height: 5px; border-radius: 3px; background: {D['surface3']};"><div style="position: absolute; left: 0; top: 0; bottom: 0; width: {max(2, min(100, ratio / 1.5 * 100)):.0f}%; border-radius: 3px; background: {tone};"></div><div style="position: absolute; left: 66.7%; top: -3px; bottom: -3px; width: 2px; background: {D['muted']};"></div></div></div>
  <div style="display: flex; justify-content: flex-end;">{sparkline(p, 220, 40)}</div>
</div>'''
    cols = "".join(f'<div style="color: {D["muted"]}; font-size: 11.5px; font-weight: 500;">{c}</div>' for c in ("Allowance", "Remaining · expected at reset", "Resets", "Expected at reset", "State", "Runs out", "Recent pace", "Observed → forecast"))
    table_panel = f'''<div style="background: {D['surface']}; border: 1px solid {D['line']}; border-radius: 10px; overflow: hidden;">
  <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 18px;"><div style="font-family: {FONT_D}; font-size: 15px; font-weight: 600;">Allowances</div><div style="color: {D['muted']}; font-size: 12px;">Weekly windows · 247 samples · 29 learned days · 89% confidence</div></div>
  <div style="display: grid; grid-template-columns: 180px 230px 130px 130px 90px 160px 190px 1fr; gap: 18px; padding: 0 18px 8px;">{cols}</div>
  {rows}
</div>'''
    kv = lambda k, v, c=D["text"]: f'<div style="display: flex; justify-content: space-between; padding: 9px 0; border-top: 1px solid {D["line"]}; font-size: 13px;"><span style="color: {D["muted"]};">{k}</span><span style="font-weight: 600; color: {c}; font-variant-numeric: tabular-nums;">{v}</span></div>'
    cost = panel(heading("Cost, last 30 days", aside="at API prices") + kv("API-equivalent", "≥ £1,755.87") + kv("Without cache", "£11,957.87") + kv("Cache discount", "£10,202 · 85%", D["ok_text"]) + kv("Cache hit rate", "69%") + kv("Subscription value", "6.1× of £290.17 fees") + kv("Price coverage", "96%"), "padding: 18px;")
    recent = panel(heading("Recent") + kv("Today", "£35.58") + kv("Last 7 days", "£305.72 · −1%") + kv("September to date", "£113.44") + kv("Projected September", "£1,134.38") + kv("Busiest slot", "Mon 15:00"), "padding: 18px;")
    daily = panel(heading("Daily cost", aside="Codex · Claude + Fable stacked") + bars_chart(1000, 250), "padding: 18px;")
    body = header("overview") + f'''
<div style="padding: 22px 44px 30px; display: flex; flex-direction: column; gap: 16px; min-height: 872px;">
  {table_panel}
  <div style="display: grid; grid-template-columns: 300px 300px minmax(0, 1fr); gap: 16px; flex: 1 1 auto;">{cost}{recent}{daily}</div>
</div>''' + footer()
    return doc(body)

# ---------------------------------------------------------------- Direction C: editorial light
E = dict(bg="#f7f6f2", surface="#ffffff", line="#e4e1da", line2="#d5d1c8", text="#1c1b18", text2="#3d3b35", muted="#6f6c64", faint="#9a968c",
         ok="#1f6f5a", warn="#b7791f", bad="#c2452d", accent="#1f6f5a", codex="#3b6ccf", claude="#7a55c9", fable="#a35fc9", observed="#8f8b82")

def overview_editorial():
    fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&amp;family=Instrument+Sans:wght@400;500;600&amp;display=swap">'
    serif = "'Instrument Serif', Georgia, 'Times New Roman', serif"
    sans = "'Instrument Sans', 'Segoe UI', system-ui, sans-serif"
    cols = ""
    for i, p in enumerate(PROVIDERS):
        col = {"safe": E["ok"], "watch": E["warn"], "risk": E["bad"]}[p["state"]]
        cols += f'''<div style="padding: 0 36px; border-left: {"0" if i == 0 else f"1px solid {E['line']}"}; display: flex; flex-direction: column; gap: 22px;">
  <div style="display: flex; justify-content: space-between; align-items: baseline;"><div style="font-size: 14px; font-weight: 600;">{p['name']} <span style="color: {E['muted']}; font-weight: 400;">· {p['plan']}</span></div><div style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: {col};"><span style="width: 7px; height: 7px; border-radius: 50%; background: {col};"></span>{STATE_WORD[p['state']]}</div></div>
  <div style="display: flex; align-items: baseline; gap: 12px;"><span style="font-family: {serif}; font-size: 84px; line-height: 0.9; letter-spacing: -0.03em; color: {E['text']};">{p['left']}<span style="font-size: 44px; color: {E['muted']};">%</span></span><span style="font-size: 14px; color: {E['muted']};">left of this week's allowance</span></div>
  <div style="font-family: {serif}; font-size: 24px; line-height: 1.25; color: {E['text']}; text-wrap: pretty;">{p['headline'][0]}<span style="font-style: italic; color: {col};">{p['headline'][1]}</span>{p['headline'][2]}</div>
  <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; padding-top: 18px; border-top: 1px solid {E['line']};">
    <div><div style="font-size: 12px; color: {E['muted']};">Resets</div><div style="font-size: 17px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums;">{p['resets']}</div><div style="font-size: 12px; color: {E['muted']};">{p['resets_at']}</div></div>
    <div><div style="font-size: 12px; color: {E['muted']};">Expected at reset</div><div style="font-size: 17px; font-weight: 600; margin-top: 4px;">{p['expected']}%</div><div style="font-size: 12px; color: {E['muted']};">heavier end {p['heavy']}%</div></div>
    <div><div style="font-size: 12px; color: {E['muted']};">Runs out</div><div style="font-size: 17px; font-weight: 600; margin-top: 4px; color: {E['warn'] if p['runs_tone'] else E['text']};">{p['runs']}</div><div style="font-size: 12px; color: {E['muted']};">{p['runs_note']}</div></div>
  </div>
  <div style="margin-top: auto;">
    <div style="display: flex; justify-content: space-between; font-size: 12px; color: {E['muted']}; margin-bottom: 8px;"><span style="color: {E['text2']};">Pace {p['pace']:.2f}%/h · safe ≤ {p['safe']:.2f}%/h</span><span>{p['hours']} active hours left</span></div>
    {forecast_svg(p, 520, 150, grid=E['line'], axis=E['faint'], obs=E['observed'], exp=E['ok'], heavy=E['warn'], now_c=E['faint'])}
    <div style="font-size: 12px; color: {E['faint']}; margin-top: 10px;">{p['foot'][0]} · {p['foot'][-1]}</div>
  </div>
</div>'''
    tabs = "".join(f'<span style="font-size: 14px; font-weight: {600 if i == 0 else 500}; color: {E["text"] if i == 0 else E["muted"]}; border-bottom: 2px solid {E["text"] if i == 0 else "transparent"}; padding-bottom: 4px;">{t}</span>' for i, t in enumerate(("Overview", "Details", "Data &amp; settings")))
    body = f'''<div style="font-family: {sans}; color: {E['text']};">
<div style="display: flex; align-items: center; gap: 36px; height: 72px; padding: 0 56px; border-bottom: 1px solid {E['line']};">
  <div style="display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 600;"><div style="width: 22px; height: 22px; border-radius: 6px; background: {E['text']}; display: flex; align-items: center; justify-content: center;">{icon_activity(14, E['bg'])}</div>AI Usage</div>
  <div style="display: flex; gap: 24px;">{tabs}</div>
  <div style="margin-left: auto; display: flex; align-items: center; gap: 18px; font-size: 13px; color: {E['muted']};"><span>Updated 20:08</span><span style="display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px; border: 1px solid {E['line2']}; border-radius: 999px; color: {E['text']}; font-weight: 500;">{icon_refresh(14, E['text'])}Refresh</span></div>
</div>
<div style="padding: 28px 56px 0; display: flex; align-items: baseline; gap: 14px;">
  <span style="font-family: {serif}; font-size: 30px; letter-spacing: -0.02em; color: {E['bad']};">Fable 5 may hit its weekly limit.</span>
  <span style="font-size: 14px; color: {E['muted']};">Codex 78% · Claude 95% · Fable 72% remaining · 3 September</span>
</div>
<div style="padding: 32px 20px 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); min-height: 660px;">{cols}</div>
<div style="margin: 36px 56px 0; padding: 22px 0 28px; border-top: 1px solid {E['line']}; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 32px;">
  <div><div style="font-size: 12px; color: {E['muted']};">API-equivalent value, 30 days</div><div style="font-family: {serif}; font-size: 34px; letter-spacing: -0.02em; margin-top: 4px;">≥ £1,755.87</div><div style="font-size: 12px; color: {E['muted']};">lower bound, one model unpriced</div></div>
  <div><div style="font-size: 12px; color: {E['muted']};">Subscription value</div><div style="font-family: {serif}; font-size: 34px; letter-spacing: -0.02em; margin-top: 4px;">6.1×</div><div style="font-size: 12px; color: {E['muted']};">against £290.17 in fees</div></div>
  <div><div style="font-size: 12px; color: {E['muted']};">Cache discount</div><div style="font-family: {serif}; font-size: 34px; letter-spacing: -0.02em; margin-top: 4px;">£10,202</div><div style="font-size: 12px; color: {E['ok']};">85% avoided</div></div>
  <div><div style="font-size: 12px; color: {E['muted']};">Price coverage</div><div style="font-family: {serif}; font-size: 34px; letter-spacing: -0.02em; margin-top: 4px;">96%</div><div style="font-size: 12px; color: {E['muted']};">preview-unpriced-model has no row</div></div>
</div>
</div>'''
    return doc(body, bg=E["bg"], color=E["text"], fonts_link=fonts,
               extra_css=f"a {{ color: {E['ok']}; }} a:hover {{ color: {E['text']}; }}")


# ---------------------------------------------------------------- Direction D: refined A
THEMES = {
    "dark": dict(bg="#0f1113", panel="#16181c", panel2="#1c1f24", hair="rgba(255,255,255,0.08)", hair2="rgba(255,255,255,0.13)",
                 text="#ececee", text2="#c8cbd0", muted="#9a9fa7", faint="#6a6f78", ok="#3fb27f", ok_dim="rgba(63,178,127,0.38)",
                 warn="#d8a04a", bad="#e2634f", bad_dim="rgba(226,99,79,0.38)", observed="#a9adb4", used="#3a3e45", grid="rgba(255,255,255,0.07)",
                 btn="#1f2227", btn_line="rgba(255,255,255,0.14)", mark="#ececee"),
    "light": dict(bg="#f5f5f6", panel="#ffffff", panel2="#f7f7f8", hair="#e6e7ea", hair2="#d9dbdf",
                  text="#1b1d21", text2="#3a3d43", muted="#6b7079", faint="#9a9ea6", ok="#1f8a5b", ok_dim="rgba(31,138,91,0.28)",
                  warn="#b8760f", bad="#cf4a35", bad_dim="rgba(207,74,53,0.28)", observed="#7c818a", used="#d5d7db", grid="#eceef1",
                  btn="#ffffff", btn_line="#d9dbdf", mark="#1b1d21"),
}
LEARN = {"codex": "Learned from 29 days · 89% confidence", "claude": "Learned from 27 days · 84% confidence", "fable": "Learned from 21 days · 71% confidence"}
OBSERVED = {"codex": "Official reading 20:05", "claude": "Official reading 19:52", "fable": "Official reading 19:52"}
FACTS = {
    "codex": [("Resets", "Wed 10 Sept, 03:21", "in 6 d 7 h"), ("Expected at reset", "30% left", "heavier week: 3%"), ("Runs out", "After reset", "on both projections"), ("Pace, last 24 h", "0.78 %/h", "safe up to 0.95 %/h")],
    "claude": [("Resets", "Mon 8 Sept, 08:03", "in 4 d 12 h"), ("Expected at reset", "84% left", "heavier week: 79%"), ("Runs out", "After reset", "on both projections"), ("Pace, last 24 h", "0.13 %/h", "safe up to 1.16 %/h")],
    "fable": [("Resets", "Mon 8 Sept, 08:03", "in 4 d 12 h"), ("Expected at reset", "41% left", "heavier week: 0%"), ("Runs out", "Not expected", "heavier week: Tue 08:03"), ("Pace, last 24 h", "0.49 %/h", "safe up to 0.88 %/h")],
}
DAY_NAMES = ["Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]


def refined_ticks(p):
    """Ticks at local midnights over the real horizon: 2.5 observed days before now (Thu 20:08) plus the days to reset."""
    span = 2.5 + p["reset_days"]
    step = 1 if span <= 5.5 else 2
    items = [(0.36, "Now")]
    n = 0
    while 0.16 + n <= p["reset_days"]:
        f = 0.36 + ((0.16 + n) / span) * 0.64
        if n % step == 0 and abs(f - 0.36) > 0.07:
            items.append((f, DAY_NAMES[n]))
        n += 1
    items.append((max(0.02, 0.36 - (1.84 / span) * 0.36), "Tue"))
    return items


def refined_chart(p, T, width=660, height=380):
    left, right, top, bottom = 34, 8, 14, 24
    pw, ph = width - left - right, height - top - bottom
    y = lambda v: top + (1 - v / 100) * ph
    x_now = left + pw * 0.36
    x_end = left + pw
    obs = [(left, y(min(100, p["left"] + 18))), (left + pw * 0.12, y(min(100, p["left"] + 15))), (left + pw * 0.24, y(min(100, p["left"] + 8))), (x_now, y(p["left"]))]
    exp = [(x_now, y(p["left"])), (x_end, y(p["expected"]))]
    hv = [(x_now, y(p["left"])), (x_end, y(p["heavy"]))]
    path = lambda pts: " ".join(f"{'M' if i == 0 else 'L'}{px:.1f},{py:.1f}" for i, (px, py) in enumerate(pts))
    area = f"{path(exp)} L{x_end:.1f},{y(0):.1f} L{x_now:.1f},{y(0):.1f} Z"
    ticks = "".join(f'<text x="{left + pw * f:.0f}" y="{height - 6}" text-anchor="middle">{lab}</text>' for f, lab in refined_ticks(p))
    parts = [
        f'<svg viewBox="0 0 {width} {height}" width="100%" style="display: block; font: 500 10.5px {FONT}; fill: {T["faint"]};">',
        f'<line x1="{left}" x2="{width - right}" y1="{y(100):.1f}" y2="{y(100):.1f}" stroke="{T["grid"]}"></line>',
        f'<line x1="{left}" x2="{width - right}" y1="{y(50):.1f}" y2="{y(50):.1f}" stroke="{T["grid"]}"></line>',
        f'<line x1="{left}" x2="{width - right}" y1="{y(0):.1f}" y2="{y(0):.1f}" stroke="{T["hair2"]}"></line>',
        f'<text x="0" y="{y(100) + 4:.1f}">100</text><text x="0" y="{y(50) + 4:.1f}">50</text><text x="0" y="{y(0) + 4:.1f}">0</text>',
        ticks,
        f'<line x1="{x_now:.1f}" x2="{x_now:.1f}" y1="{top}" y2="{y(0):.1f}" stroke="{T["faint"]}" stroke-dasharray="2 3"></line>',
        f'<path d="{area}" fill="{T["ok"]}" fill-opacity="0.07"></path>',
        f'<path d="{path(obs)}" fill="none" stroke="{T["observed"]}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></path>',
        f'<path d="{path(exp)}" fill="none" stroke="{T["ok"]}" stroke-width="1.75" stroke-linecap="round"></path>',
        f'<path d="{path(hv)}" fill="none" stroke="{T["warn"]}" stroke-width="1.5" stroke-dasharray="4 4" stroke-linecap="round"></path>',
        f'<circle cx="{x_end:.1f}" cy="{y(p["expected"]):.1f}" r="3" fill="{T["ok"]}"></circle>',
        f'<circle cx="{x_end:.1f}" cy="{y(p["heavy"]):.1f}" r="3" fill="{T["warn"]}"></circle>',
        '</svg>',
    ]
    return "\n".join(parts)


def swatch(color, extra=""):
    return f'<i style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: {color}; margin-right: 6px; vertical-align: -1px; {extra}"></i>'


def refined_column(p, T, first):
    state = {"safe": (T["ok"], T["ok_dim"], "On track"), "watch": (T["warn"], T["warn"], "Watch"), "risk": (T["bad"], T["bad_dim"], "At risk")}[p["state"]]
    color, dim, word = state
    used = 100 - p["left"]
    expected_use = p["left"] - p["expected"]
    spare = p["expected"]
    heavier_x = 100 - p["heavy"]
    rows = ""
    for k, v, sub in FACTS[p["key"]]:
        val_color = T["warn"] if (k == "Runs out" and p["state"] == "risk") else T["text"]
        rows += (f'<div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 9px 0; border-top: 1px solid {T["hair"]};">'
                 f'<span style="color: {T["muted"]}; font-size: 12.5px;">{k}</span>'
                 f'<span style="text-align: right; font-variant-numeric: tabular-nums;"><span style="font-weight: 600; color: {val_color};">{v}</span>'
                 f'<span style="color: {T["faint"]}; font-size: 12px; margin-left: 8px;">{sub}</span></span></div>')
    border = "0" if first else f"1px solid {T['hair']}"
    legend = (f'<span style="display: flex; gap: 12px;">'
              f'<span><i style="display: inline-block; width: 12px; height: 2px; background: {T["observed"]}; margin-right: 5px; vertical-align: 3px;"></i>Observed</span>'
              f'<span><i style="display: inline-block; width: 12px; height: 2px; background: {T["ok"]}; margin-right: 5px; vertical-align: 3px;"></i>Expected</span>'
              f'<span><i style="display: inline-block; width: 12px; height: 0; border-top: 2px dashed {T["warn"]}; margin-right: 5px; vertical-align: 3px;"></i>Heavier</span></span>')
    parts = [
        f'<div style="padding: 20px 24px 18px; border-left: {border}; display: flex; flex-direction: column; gap: 14px; min-width: 0;">',
        '<div style="display: flex; justify-content: space-between; align-items: baseline;">',
        f'<div><span style="font-size: 14px; font-weight: 600;">{p["name"]}</span><span style="color: {T["muted"]}; font-size: 12.5px; margin-left: 8px;">{p["plan"]}</span></div>',
        f'<div style="display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 500; color: {color};"><span style="width: 6px; height: 6px; border-radius: 50%; background: {color};"></span>{word}</div>',
        '</div>',
        '<div style="display: flex; align-items: baseline; gap: 10px;">',
        f'<span style="font-family: {FONT_D}; font-size: 38px; font-weight: 600; letter-spacing: -0.03em; line-height: 1; font-variant-numeric: tabular-nums;">{p["left"]}%</span>',
        f'<span style="color: {T["muted"]}; font-size: 13px;">of this week\'s allowance left</span>',
        '</div>',
        '<div>',
        '<div style="display: flex; height: 10px; border-radius: 2px; overflow: hidden; gap: 2px; position: relative;">',
        f'<div style="width: {used}%; background: {T["used"]};"></div>',
        f'<div style="width: {expected_use}%; background: {dim};"></div>',
        f'<div style="flex: 1; background: {color};"></div>',
        f'<div style="position: absolute; left: {heavier_x}%; top: -2px; bottom: -2px; width: 2px; background: {T["text"]};"></div>',
        '</div>',
        f'<div style="display: flex; gap: 14px; margin-top: 8px; font-size: 11.5px; color: {T["muted"]}; font-variant-numeric: tabular-nums;">',
        f'<span>{swatch(T["used"])}{used}% used</span>',
        f'<span>{swatch(dim)}{expected_use}% expected before reset</span>',
        f'<span>{swatch(color)}{spare}% spare</span>',
        f'<span style="margin-left: auto;"><i style="display: inline-block; width: 2px; height: 10px; background: {T["text"]}; margin-right: 6px; vertical-align: -1px;"></i>heavier week</span>',
        '</div>',
        '</div>',
        f'<div style="border-bottom: 1px solid {T["hair"]};">{rows}</div>',
        '<div style="margin-top: 4px; flex: 1 1 auto; display: flex; flex-direction: column;">',
        f'<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px; color: {T["muted"]};">',
        f'<span style="color: {T["text2"]}; font-weight: 500;">Forecast to reset</span>{legend}',
        '</div>',
        refined_chart(p, T),
        '</div>',
        f'<div style="display: flex; justify-content: space-between; font-size: 11.5px; color: {T["faint"]};"><span>{LEARN[p["key"]]}</span><span>{OBSERVED[p["key"]]}</span></div>',
        '</div>',
    ]
    return "\n".join(parts)


def overview_refined(theme):
    T = THEMES[theme]
    tabs = "".join(f'<span style="display: flex; align-items: center; padding: 0 2px; margin: 0 10px; font-size: 13px; font-weight: 500; color: {T["text"] if i == 0 else T["muted"]}; border-bottom: 2px solid {T["text"] if i == 0 else "transparent"};">{t}</span>' for i, t in enumerate(("Overview", "Details", "Settings")))
    mark = f'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="{T["mark"]}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 9.5h3l2-6 3 9 2-5h3"></path></svg>'
    refresh = (f'<span style="display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 11px; border-radius: 5px; background: {T["btn"]}; border: 1px solid {T["btn_line"]}; font-size: 12.5px; font-weight: 500; color: {T["text"]};">'
               f'{icon_refresh(13, T["text"])}Refresh</span>')
    columns = "".join(refined_column(p, T, i == 0) for i, p in enumerate(PROVIDERS))

    def cell(k, v, sub, first=False):
        border = "0" if first else f"1px solid {T['hair']}"
        return (f'<div style="flex: 1 1 0; padding: 14px 22px; border-left: {border};">'
                f'<div style="font-size: 12px; color: {T["muted"]};">{k}</div>'
                f'<div style="font-family: {FONT_D}; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin-top: 3px; font-variant-numeric: tabular-nums;">{v}</div>'
                f'<div style="font-size: 12px; color: {T["faint"]}; margin-top: 2px;">{sub}</div></div>')

    strip = (f'<div style="display: flex; background: {T["panel"]}; border: 1px solid {T["hair2"]}; border-radius: 6px; margin-top: 16px;">'
             + cell("API-equivalent cost, last 30 days", "≥ £1,755.87", "lower bound: one model unpriced", True)
             + cell("Subscription value", "6.1×", "£1,755.87 of API value for £290.17 in fees")
             + cell("Cache discount", "£10,202", "85% below the uncached value")
             + cell("Price coverage", "96%", "preview-unpriced-model has no price row") + '</div>')
    parts = [
        f'<div style="font-family: {FONT}; color: {T["text"]}; background: {T["bg"]}; width: 1600px; min-height: 1000px; display: flex; flex-direction: column;">',
        f'<div style="display: flex; align-items: stretch; height: 48px; padding: 0 40px; border-bottom: 1px solid {T["hair"]}; gap: 18px;">',
        f'<div style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600;">{mark}AI Usage</div>',
        f'<div style="display: flex; align-items: stretch; margin-left: 10px;">{tabs}</div>',
        f'<div style="margin-left: auto; display: flex; align-items: center; gap: 14px; font-size: 12px; color: {T["muted"]};"><span>Updated 20:08 · refreshes every 15 min</span>{refresh}</div>',
        '</div>',
        '<div style="padding: 26px 40px 24px; display: flex; flex-direction: column; flex: 1 1 auto;">',
        '<div style="display: flex; align-items: baseline; justify-content: space-between; gap: 24px; margin-bottom: 16px;">',
        '<div style="display: flex; align-items: baseline; gap: 10px;">',
        f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {T["bad"]}; position: relative; top: -1px;"></span>',
        f'<span style="font-family: {FONT_D}; font-size: 17px; font-weight: 600; letter-spacing: -0.01em;">Fable 5 is likely to reach its weekly limit before Monday\'s reset</span>',
        f'<span style="font-size: 13px; color: {T["muted"]};">Codex and Claude are on track.</span>',
        '</div>',
        f'<span style="font-size: 12.5px; color: {T["muted"]}; font-variant-numeric: tabular-nums;">Codex 78% · Claude 95% · Fable 5 72% left</span>',
        '</div>',
        f'<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); background: {T["panel"]}; border: 1px solid {T["hair2"]}; border-radius: 6px; flex: 1 1 auto;">{columns}</div>',
        strip,
        '</div>',
        f'<div style="display: flex; justify-content: space-between; padding: 0 40px 20px; font-size: 11.5px; color: {T["faint"]};"><span>Local data only. Forecasts are estimates from your own history, not provider guarantees.</span><span>Europe/London</span></div>',
        '</div>',
    ]
    return doc("\n".join(parts), bg=T["bg"], color=T["text"], extra_css=f"a {{ color: {T['text']}; }} a:hover {{ color: {T['muted']}; }}")

# ---------------------------------------------------------------- write files
files = {
    "Main.dc.html": overview_refined("dark"),
    "MainLight.dc.html": overview_refined("light"),
    "OverviewA.dc.html": overview_main(),
    "Details.dc.html": details_main(),
    "Settings.dc.html": settings_main(),
    "OverviewDense.dc.html": overview_dense(),
    "OverviewEditorial.dc.html": overview_editorial(),
}
for name, html in files.items():
    with open(name, "w", encoding="utf-8") as f:
        f.write(html)

canvas = {
    "pages": [{"id": "page-1", "name": "Direction D"}, {"id": "page-2", "name": "Earlier directions"}],
    "artboards": [
        {"file": "Main.dc.html", "title": "D · Refined, dark", "x": 0, "y": 0, "w": 1600, "h": 1000, "page": "page-1"},
        {"file": "MainLight.dc.html", "title": "D · Refined, light", "x": 1700, "y": 0, "w": 1600, "h": 1000, "page": "page-1"},
        {"file": "OverviewA.dc.html", "title": "A · Quiet product (1.0.13)", "x": 0, "y": 0, "w": 1600, "h": 1000, "page": "page-2"},
        {"file": "OverviewDense.dc.html", "title": "B · Dense console", "x": 1700, "y": 0, "w": 1600, "h": 1000, "page": "page-2"},
        {"file": "OverviewEditorial.dc.html", "title": "C · Editorial", "x": 3400, "y": 0, "w": 1600, "h": 1000, "page": "page-2"},
        {"file": "Details.dc.html", "title": "Details (direction A)", "x": 0, "y": 1180, "w": 1600, "h": 3120, "page": "page-2"},
        {"file": "Settings.dc.html", "title": "Data & settings (direction A)", "x": 1700, "y": 1180, "w": 1600, "h": 3220, "page": "page-2"},
    ],
    "annotations": [
        {"id": "dir-d", "x": 0, "y": -300, "w": 560, "page": "page-1", "text": "D - Refined A\n\nKeeps A's forecast charts. Replaces the rest of the kit:\n- one status line at the top instead of a verdict chip and a sentence per card\n- one panel with three hairline-divided columns instead of three cards\n- a horizontal allowance bar (used / expected before reset / spare, with a heavier-week marker) instead of an arc gauge\n- label-left, value-right rows for resets, expected, run-out and pace\n- neutral near-black or off-white ground, 6px radii, no shadows, no filled blue button, one quiet mark\n- telemetry reduced to one faint line per column"},
        {"id": "brief", "x": 0, "y": -260, "w": 520, "page": "page-2", "text": "Earlier directions, kept for reference. A is what 1.0.13 ships; B and C were the alternatives."},
    ],
    "launch": {"view": "canvas", "page": "page-1"},
}
with open("canvas.json", "w", encoding="utf-8") as f:
    json.dump(canvas, f, indent=2)
print("wrote", ", ".join(files), "canvas.json")
