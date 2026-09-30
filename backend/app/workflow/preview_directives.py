"""Hard H3 English directives derived from the same profiles as the 3D cinema preview.

The in-app preview shows concrete geometry (distance, height, FOV, light ratios).
Compose/edit must pass those locks as mandatory shot parameters — soft catalog hints
are not enough for H3 to match the previs.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_PREVIEW_PATH = Path(__file__).with_name("cinematography_preview.json")

FRAMING_H3: dict[str, str] = {
    "extremeWide": (
        "SHOT SIZE LOCK: extreme long shot / extreme wide — subject is a tiny figure "
        "in a vast readable environment; camera far back (~14 m); only silhouette-scale detail."
    ),
    "establishing": (
        "SHOT SIZE LOCK: establishing wide — location dominates; figures small in space (~11 m)."
    ),
    "master": (
        "SHOT SIZE LOCK: master shot — full staging readable with environment (~8 m)."
    ),
    "wide": (
        "SHOT SIZE LOCK: wide / long shot — full body with readable environment (~6.5 m)."
    ),
    "full": (
        "SHOT SIZE LOCK: full shot — head-to-toe body fills the frame (~4.4 m)."
    ),
    "cowboy": (
        "SHOT SIZE LOCK: cowboy / American shot — mid-thighs up (~3.5 m)."
    ),
    "medium": (
        "SHOT SIZE LOCK: medium shot — roughly waist-up (~2.7 m)."
    ),
    "mcu": (
        "SHOT SIZE LOCK: medium close-up — chest/shoulders and head (~1.95 m)."
    ),
    "cu": (
        "SHOT SIZE LOCK: close-up — face and upper shoulders dominate (~1.35 m)."
    ),
    "ecu": (
        "SHOT SIZE LOCK: extreme close-up — single facial feature or tiny detail fills frame (~0.85 m)."
    ),
    "insert": (
        "SHOT SIZE LOCK: insert / detail — a prop or small object fills the frame (~0.55 m)."
    ),
    "cutaway": (
        "SHOT SIZE LOCK: cutaway — secondary related detail or object in its own frame."
    ),
    "reaction": (
        "SHOT SIZE LOCK: reaction — face/upper body reading the reaction (~1.5 m)."
    ),
    "twoShot": (
        "SHOT SIZE LOCK: two-shot — both figures share the frame at readable body scale."
    ),
    "ots": (
        "SHOT SIZE LOCK: over-the-shoulder — near shoulder/head in foreground, far subject framed beyond."
    ),
}

ANGLE_H3: dict[str, str] = {
    "eyeLevel": "ANGLE LOCK: eye-level — camera height matches subject eyes; neutral horizon.",
    "lowAngle": (
        "ANGLE LOCK: low angle — camera below eye height looking up (~0.55 m height); subject looms."
    ),
    "highAngle": (
        "ANGLE LOCK: high angle — camera above looking down (~2.6 m)."
    ),
    "birdsEye": (
        "ANGLE LOCK: bird's-eye / top-down — camera high overhead (~6.5 m) looking nearly straight down."
    ),
    "wormsEye": (
        "ANGLE LOCK: worm's-eye / ground-level — camera ~0.12 m height looking steeply up."
    ),
    "dutch": (
        "ANGLE LOCK: Dutch / canted — horizon rolled ~18°; keep the roll readable."
    ),
    "pov": "ANGLE LOCK: POV — optical vantage of the character; subjective framing.",
    "profile": "ANGLE LOCK: true profile — camera on the side axis (~90°).",
    "threeQuarter": "ANGLE LOCK: three-quarter angle — camera ~45° off axis.",
    "reverse": "ANGLE LOCK: reverse angle — camera on the opposite side of the axis.",
}

MOTION_H3: dict[str, str] = {
    "static": (
        "CAMERA MOTION LOCK: static / locked-off tripod — camera body stays completely still "
        "for the whole clip; only the subject may move inside the frame."
    ),
    "dolly": (
        "CAMERA MOTION LOCK: physical dolly move on a track/support — describe start→path→end "
        "as a body move of the camera."
    ),
    "push": "CAMERA MOTION LOCK: push-in — camera body physically moves closer to the subject.",
    "zoom": "CAMERA MOTION LOCK: optical zoom — focal length changes while camera body stays put.",
    "crash": "CAMERA MOTION LOCK: crash zoom — abrupt snappy zoom hit.",
    "pan": "CAMERA MOTION LOCK: pan — horizontal yaw from a fixed tripod position.",
    "tilt": "CAMERA MOTION LOCK: tilt — vertical pitch from a fixed tripod position.",
    "pedestal": "CAMERA MOTION LOCK: pedestal — vertical camera lift with tilt angle held.",
    "crane": "CAMERA MOTION LOCK: crane/jib — camera rises/falls on an arm with depth change.",
    "track": "CAMERA MOTION LOCK: tracking — lateral move with the subject.",
    "follow": "CAMERA MOTION LOCK: follow / steadicam — camera accompanies the moving subject.",
    "steadicam": "CAMERA MOTION LOCK: steadicam — stabilized floating follow of the subject.",
    "gimbal": "CAMERA MOTION LOCK: gimbal — stabilized directional move with the subject.",
    "handheld": "CAMERA MOTION LOCK: handheld — visible organic micro-shake of a hand-held support.",
    "orbit": "CAMERA MOTION LOCK: orbit / arc — camera circles the subject.",
    "aerial": "CAMERA MOTION LOCK: aerial/drone — high elevated moving vantage.",
    "dollyZoom": (
        "CAMERA MOTION LOCK: dolly zoom / Vertigo — dolly opposite to zoom so subject size stays "
        "roughly constant while perspective warps."
    ),
    "whip": "CAMERA MOTION LOCK: whip pan — ultra-fast horizontal blur pan.",
}

COMPOSITION_H3: dict[str, str] = {
    "thirds": "COMPOSITION LOCK: rule of thirds — subject on a third intersection.",
    "center": "COMPOSITION LOCK: centered subject on the optical axis.",
    "symmetry": "COMPOSITION LOCK: bilateral symmetry — mirrored left/right balance.",
    "asymmetry": "COMPOSITION LOCK: deliberate asymmetry — uneven visual weight.",
    "leading": "COMPOSITION LOCK: leading lines pull the eye to the subject.",
    "vanishing": "COMPOSITION LOCK: vanishing-point / deep perspective lines.",
    "frameInFrame": "COMPOSITION LOCK: frame-within-frame (doorway/window/arch).",
    "negative": "COMPOSITION LOCK: large empty space around the subject.",
    "foreground": "COMPOSITION LOCK: strong foreground element layers depth.",
    "layered": "COMPOSITION LOCK: foreground / midground / background layers.",
    "weight": "COMPOSITION LOCK: weighted balance of masses in the frame.",
    "figureGround": "COMPOSITION LOCK: clear figure–ground separation.",
    "tonal": "COMPOSITION LOCK: tonal contrast separates subject from ground.",
    "leadRoom": "COMPOSITION LOCK: lead room / looking room in gaze/motion direction.",
    "shortSiding": "COMPOSITION LOCK: short-siding — tighter space ahead of the gaze.",
    "dirty": "COMPOSITION LOCK: dirty frame — intrusive foreground obstruction.",
    "clean": "COMPOSITION LOCK: clean frame — unobstructed, tidy edges.",
}

LIGHT_TAG_H3: dict[str, str] = {
    "key": (
        "LIGHT LOCK: strong directional key dominates the frame; subordinate fill; "
        "write this geometry into visual_style and every shot."
    ),
    "fill": (
        "LIGHT LOCK: elevated fill softens shadows while the key direction stays readable — visual_style."
    ),
    "back": "LIGHT LOCK: back light separates subject from background — visual_style.",
    "rim": "LIGHT LOCK: rim light outlines the silhouette — visual_style.",
    "kicker": "LIGHT LOCK: kicker / edge light from rear-side — visual_style.",
    "eye": "LIGHT LOCK: dedicated eye light / catchlight as a motivated accent — visual_style.",
    "highKey": (
        "LIGHT LOCK: high-key — bright overall exposure, low contrast, lifted shadows "
        "(strong key with generous fill). Write into visual_style."
    ),
    "lowKey": (
        "LIGHT LOCK: low-key — deep shadows, sparse fill, high contrast. Write into visual_style."
    ),
    "hard": (
        "LIGHT LOCK: hard light — sharp shadow edges, specular punch, crisp falloff. "
        "Write into visual_style."
    ),
    "soft": (
        "LIGHT LOCK: soft light — broad diffused wrap, gentle shadow edges. Write into visual_style."
    ),
    "side": (
        "LIGHT LOCK: hard-ish side key near 90° azimuth with low fill, split-face contrast. "
        "Write into visual_style."
    ),
    "top": "LIGHT LOCK: top / overhead key (high elevation) — visual_style.",
    "under": "LIGHT LOCK: underlighting from below — visual_style.",
    "rembrandt": "LIGHT LOCK: Rembrandt — ~45° key with triangle cheek patch — visual_style.",
    "split": "LIGHT LOCK: split lighting — half face lit, half in shadow — visual_style.",
    "short": "LIGHT LOCK: short lighting (key on the far side of the face) — visual_style.",
    "broad": "LIGHT LOCK: broad lighting (key on the near side of the face) — visual_style.",
    "motivated": "LIGHT LOCK: motivated practical/window source, direction locked — visual_style.",
    "practical": "LIGHT LOCK: visible practical lamp as key, warm bias — visual_style.",
    "window": "LIGHT LOCK: window-motivated soft key — visual_style.",
    "golden": "LIGHT LOCK: golden-hour warm low sun — visual_style.",
    "blueHour": "LIGHT LOCK: blue-hour cool twilight — visual_style.",
    "volumetric": "LIGHT LOCK: volumetric shafts / god rays in haze — visual_style.",
    "gobo": "LIGHT LOCK: gobo / dappled patterned shadows — visual_style.",
}

GRADE_H3: dict[str, str] = {
    "natural": "COLOR LOCK: natural grade — balanced, unstyled color into visual_style.",
    "warm": "COLOR LOCK: warm grade — amber/orange bias into visual_style.",
    "cool": "COLOR LOCK: cool grade — blue/cyan bias into visual_style.",
    "tealOrange": "COLOR LOCK: teal-and-orange cinematic grade into visual_style.",
    "desat": "COLOR LOCK: desaturated / muted palette into visual_style.",
    "hypersat": "COLOR LOCK: hypersaturated punchy colors into visual_style.",
    "mono": "COLOR LOCK: monochrome / black-and-white into visual_style.",
    "bleach": "COLOR LOCK: bleach-bypass / silver retention look into visual_style.",
    "palette": "COLOR LOCK: curated limited color palette into visual_style.",
}

FOCUS_TAG_H3: dict[str, str] = {
    "shallow": "FOCUS LOCK: shallow DOF — subject sharp, background creamy blur.",
    "deep": "FOCUS LOCK: deep focus — near and far both readable.",
    "rack": "FOCUS LOCK: rack focus — focus plane moves from near to far (or reverse) during the shot.",
}

ATMO_H3: dict[str, str] = {
    "haze": "ATMOSPHERE LOCK: visible atmospheric haze.",
    "fog": "ATMOSPHERE LOCK: dense fog reducing distant detail.",
    "mist": "ATMOSPHERE LOCK: light mist.",
    "smoke": "ATMOSPHERE LOCK: smoke volumes in air.",
    "dust": "ATMOSPHERE LOCK: airborne dust particles.",
    "rain": "ATMOSPHERE LOCK: falling rain.",
    "wet": "ATMOSPHERE LOCK: wet-down surfaces with rain.",
    "snow": "ATMOSPHERE LOCK: falling snow.",
    "embers": "ATMOSPHERE LOCK: floating embers/sparks.",
}

TIME_TAG_H3: dict[str, str] = {
    "slow": "TIME LOCK: slow motion.",
    "fast": "TIME LOCK: fast motion / undercrank feel.",
    "ramp": "TIME LOCK: speed ramp (slow→fast or reverse).",
    "freeze": "TIME LOCK: freeze-frame beat mid-clip.",
    "timelapse": "TIME LOCK: time-lapse compression.",
    "mblur": "TIME LOCK: heavy motion blur.",
    "lowShutter": "TIME LOCK: low-shutter / smeared motion blur.",
    "oner": "TIME LOCK: continuous oner — single unbroken take for the beat.",
}

FX_TAG_H3: dict[str, str] = {
    "flare": "FX LOCK: visible lens flare.",
    "halation": "FX LOCK: halation glow on highlights.",
    "grain": "FX LOCK: visible film grain.",
    "bokeh": "FX LOCK: boosted creamy bokeh.",
    "double": "FX LOCK: double-exposure overlay.",
    "leak": "FX LOCK: light-leak wash.",
    "ca": "FX LOCK: chromatic aberration at edges.",
    "forced": "FX LOCK: forced-perspective scale trick.",
}

EDIT_H3: dict[str, str] = {
    "match": "EDIT LOCK: match cut on action/shape.",
    "graphic": "EDIT LOCK: graphic match cut.",
    "action": "EDIT LOCK: action cut on movement peak.",
    "jump": "EDIT LOCK: jump cut.",
    "smash": "EDIT LOCK: smash cut.",
    "dissolve": "EDIT LOCK: dissolve transition.",
    "fade": "EDIT LOCK: fade transition.",
    "cross": "EDIT LOCK: cross-cut / intercut.",
    "axial": "EDIT LOCK: axial cut along the lens axis.",
    "invisible": "EDIT LOCK: invisible / masked cut.",
    "jl": "EDIT LOCK: J-cut / L-cut audio lead.",
    "quick": "EDIT LOCK: quick-cut montage pace.",
}

GENRE_TAG_H3: dict[str, str] = {
    "noir": "GENRE LOCK: classic film-noir — mono/high-contrast, hard side key, deep shadows into visual_style.",
    "neoNoir": "GENRE LOCK: neo-noir — teal-orange, wet night, rim accents into visual_style.",
    "expressionism": "GENRE LOCK: expressionist — dutch extremes, hard split light, distorted geometry.",
    "giallo": "GENRE LOCK: giallo — hypersat primary colors, stylized key into visual_style.",
    "found": "GENRE LOCK: found-footage — handheld, grain, chromatic edge, desat.",
    "verite": "GENRE LOCK: cinéma vérité — handheld naturalism, soft window light.",
    "blockbuster": "GENRE LOCK: blockbuster — anamorphic flare, teal-orange, strong key/rim into visual_style.",
    "arthouse": "GENRE LOCK: arthouse — desat, open empty space, soft key, shallow DOF.",
    "photo": "GENRE LOCK: photographic stills feel — curated palette, soft key, thirds.",
}


@lru_cache(maxsize=1)
def _profiles() -> dict[str, dict]:
    return json.loads(_PREVIEW_PATH.read_text(encoding="utf-8"))


def _motion_extra(profile: dict) -> str:
    bits: list[str] = []
    support = profile.get("support")
    if support:
        bits.append(f"support={support}")
    path = profile.get("path")
    if path:
        bits.append(f"path={path}")
    for key, label in (
        ("end_z_delta", "depthΔ"),
        ("end_y_delta", "heightΔ"),
        ("end_x_delta", "lateralΔ"),
        ("end_fov_scale", "fovScale→"),
        ("pan_yaw", "yaw°"),
        ("tilt_pitch", "pitch°"),
    ):
        if key in profile:
            bits.append(f"{label}{profile[key]}")
    if profile.get("subjectSizeLock"):
        bits.append("subject-size-locked")
    return (" Geometry cue: " + ", ".join(bits) + ".") if bits else ""


def _optics_line(profile: dict) -> str | None:
    if "focalMm" not in profile and not profile.get("anamorphic") and not profile.get("fisheye"):
        tags = set(profile.get("tags") or [])
        if not (tags & {"wideLens", "tightLens", "tele", "anamorphic", "spherical", "fisheye", "macro", "splitDiopter"}):
            return None
    bits: list[str] = ["OPTICS LOCK:"]
    if "focalMm" in profile:
        bits.append(f"~{profile['focalMm']} mm full-frame equivalent;")
    tags = set(profile.get("tags") or [])
    if "wideLens" in tags:
        bits.append("wide-angle perspective stretch;")
    if tags & {"tele", "tightLens"}:
        bits.append("telephoto compression;")
    if profile.get("anamorphic") or "anamorphic" in tags:
        bits.append("anamorphic oval bokeh / horizontal squeeze feel;")
    if "spherical" in tags:
        bits.append("spherical lens;")
    if profile.get("fisheye") or "fisheye" in tags:
        bits.append("fisheye barrel distortion;")
    if profile.get("macroProp") or "macro" in tags:
        bits.append("macro close focus;")
    if profile.get("splitDiopter") or "splitDiopter" in tags:
        bits.append("split-diopter dual focus planes;")
    bits.append("state focal length / lens character in the shot text.")
    return " ".join(bits)


def _first_tag_line(tags: list[str], table: dict[str, str]) -> str | None:
    for tag in tags:
        if tag in table:
            return table[tag]
    return None


def h3_directive_for_profile(technique_id: str, profile: dict | None = None) -> str:
    """One hard English lock line (or multi-sentence) for a preview profile id."""
    prof = dict(profile or _profiles().get(technique_id) or {})
    tags = list(prof.get("tags") or [])
    parts: list[str] = []

    framing = prof.get("framing")
    if framing and framing in FRAMING_H3:
        parts.append(FRAMING_H3[framing])
    else:
        for tag in tags:
            if tag.startswith("framing:"):
                key = tag.split(":", 1)[1]
                if key in FRAMING_H3:
                    parts.append(FRAMING_H3[key])
                    break

    angle = _first_tag_line(tags, ANGLE_H3)
    if angle:
        extra = ""
        if "cam_y" in prof:
            extra = f" Preview camera height ≈ {prof['cam_y']} m."
        parts.append(angle + extra)

    motion_tag = next((t for t in tags if t in MOTION_H3), None)
    if motion_tag:
        parts.append(MOTION_H3[motion_tag] + _motion_extra(prof))
    elif prof.get("support") or prof.get("path"):
        # genre/time may carry support without a motion tag
        if any(t in ("oner", "found", "verite") for t in tags) or prof.get("path"):
            parts.append(
                "CAMERA MOTION LOCK: execute the preview move"
                + _motion_extra(prof)
            )

    optics = _optics_line(prof)
    if optics:
        parts.append(optics)

    composition = prof.get("composition")
    if composition and composition in COMPOSITION_H3:
        parts.append(COMPOSITION_H3[composition])
    else:
        for tag in tags:
            if tag.startswith("comp:"):
                key = tag.split(":", 1)[1]
                if key in COMPOSITION_H3:
                    parts.append(COMPOSITION_H3[key])
                    break

    light = _first_tag_line(tags, LIGHT_TAG_H3)
    if light:
        parts.append(light)

    grade = prof.get("grade")
    if grade and grade in GRADE_H3:
        parts.append(GRADE_H3[grade])
    else:
        for tag in tags:
            if tag.startswith("grade:"):
                key = tag.split(":", 1)[1]
                if key in GRADE_H3:
                    parts.append(GRADE_H3[key])
                    break

    focus = _first_tag_line(tags, FOCUS_TAG_H3)
    if focus:
        parts.append(focus)

    atmo = _first_tag_line(tags, ATMO_H3)
    if atmo:
        parts.append(atmo)

    time = _first_tag_line(tags, TIME_TAG_H3)
    if time:
        parts.append(time)

    fx = _first_tag_line(tags, FX_TAG_H3)
    if fx:
        parts.append(fx)

    edit = prof.get("edit")
    if edit and edit in EDIT_H3:
        parts.append(EDIT_H3[edit])
    else:
        for tag in tags:
            if tag.startswith("edit:"):
                key = tag.split(":", 1)[1]
                if key in EDIT_H3:
                    parts.append(EDIT_H3[key])
                    break

    genre = _first_tag_line([t for t in tags if t != "genre"], GENRE_TAG_H3)
    if genre:
        parts.append(genre)

    if not parts:
        return (
            "PREVIS LOCK: apply this technique as concrete camera/light/optics parameters "
            "matching the in-app 3D preview."
        )
    return " ".join(parts)


def h3_directive_for_technique(technique_id: str) -> str:
    return h3_directive_for_profile(technique_id)


def preview_lock_preamble() -> str:
    return (
        "PREVIS LOCK (match the in-app 3D cinema preview — mandatory):\n"
        "The lines below are hard shot parameters from the same profiles the preview uses. "
        "Write each into summary AND every [Shot N] (and into visual_style for light/grade/color). "
        "State only the locked size, angle, motion, light, and optics — positive description only. "
        "Keep the user's scene and action; only the cinematography is locked."
    )
