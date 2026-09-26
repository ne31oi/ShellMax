"""Look / delivery presets: cinematic language injected into visual_style (not megapixels).

natural = no injection. Other ids append concrete lighting/optics cues so H3 does not
fall back to a flat, doll-like default when the user (or assistant) left visual_style thin.
"""

from __future__ import annotations

from typing import Literal

LookId = Literal["natural", "documentary", "cinema", "social"]

LOOK_IDS: tuple[LookId, ...] = ("natural", "documentary", "cinema", "social")

# Concrete lines for visual_style (English — H3 prompt language). Avoid empty "cinematic".
_LOOK_STYLE: dict[str, list[str]] = {
    "documentary": [
        "Documentary observation: available practical light, natural skin response with visible pores, "
        "restrained grading, subtle handheld micro-movement when the camera is not locked — no glossy beauty filter.",
    ],
    "cinema": [
        "Cinematic photographic look: motivated key light with soft falloff and gentle contrast, shallow depth of "
        "field with soft background separation, subtle filmic tonal response on skin and fabrics — living person, "
        "not CGI and not a beauty filter.",
    ],
    "social": [
        "Punchy contemporary look: cleaner contrast, slightly harder key light, crisp subject separation; keep faces "
        "living and natural with micro-expression — not airbrushed, not doll-like.",
    ],
}

_LOOK_META: dict[str, dict[str, str]] = {
    "natural": {"label": "Как есть", "hint": "Без добавок к visual_style"},
    "documentary": {"label": "Документалка", "hint": "Живой свет, сдержанная камера"},
    "cinema": {"label": "Кино", "hint": "Мотивированный свет, лёгкий DoF"},
    "social": {"label": "Клип", "hint": "Жёстче контраст, чёткий объект"},
}

# Extra system-prompt guidance for the assistant (Russian instructions → English prompt body).
_LOOK_ASSISTANT: dict[str, str] = {
    "natural": "",
    "documentary": (
        "Подача «Документалка»: available light / practicals, естественная кожа, сдержанная камера "
        "(static или лёгкий handheld), без beauty-filter и «глянца». В visual_style опиши это конкретно."
    ),
    "cinema": (
        "Подача «Кино»: мотивированный ключ и fill, мягкий falloff, shallow DoF / soft background, "
        "filmic tonal response; камера привязана к действию (5 элементов из спеки). В visual_style — конкретно, "
        "без слова cinematic в одиночку. Лица живые (§13)."
    ),
    "social": (
        "Подача «Клип»: чуть жёстче ключ и контраст, чёткое отделение субъекта, динамичнее ритм описания; "
        "лица без airbrush. В visual_style опиши конкретно."
    ),
}


def look_presets() -> list[dict]:
    return [{"id": k, **_LOOK_META[k]} for k in LOOK_IDS]


def normalize_look(look: str | None) -> LookId:
    if look in _LOOK_STYLE or look == "natural":
        return look  # type: ignore[return-value]
    return "natural"


def assistant_look_hint(look: str | None) -> str:
    return _LOOK_ASSISTANT.get(normalize_look(look), "")


def apply_look(prompt: str, look: str | None) -> str:
    """Append look cues under visual_style (create the section if missing). Idempotent per line."""
    lid = normalize_look(look)
    lines_to_add = _LOOK_STYLE.get(lid)
    if not lines_to_add:
        return prompt
    existing_lower = prompt.lower()
    missing = [ln for ln in lines_to_add if ln[:48].lower() not in existing_lower]
    if not missing:
        return prompt

    text = prompt.replace("\r\n", "\n").rstrip()
    rows = text.splitlines()
    heads = {l.strip().lower(): i for i, l in enumerate(rows)}

    if (i := heads.get("visual_style:")) is not None:
        # after header (+ optional blank), before the next section header
        at = i + 1
        if at < len(rows) and not rows[at].strip():
            at += 1
        end = at
        while end < len(rows) and not (rows[end].strip().endswith(":") and rows[end].strip().lower() in {
            "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:",
        }):
            end += 1
        rows[end:end] = missing + [""]
        return "\n".join(rows).rstrip() + "\n"

    if (i := heads.get("overall_soundscape:")) is not None:
        rows[i:i] = ["visual_style:", "", *missing, ""]
        return "\n".join(rows)
    return text + "\n\nvisual_style:\n\n" + "\n".join(missing) + "\n"
