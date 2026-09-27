"""Expert lighting geometry for assistant compose/edit (+ optional expand into visual_style).

Complements look.py (delivery / cinema language). Light = key direction, quality, fill —
Shot Bible P8, before look/texture (P9).
"""

from __future__ import annotations

from typing import Literal

LightId = Literal["auto", "soft_key_45", "hard_side", "practical_back", "overhead_soft"]

LIGHT_IDS: tuple[LightId, ...] = (
    "auto",
    "soft_key_45",
    "hard_side",
    "practical_back",
    "overhead_soft",
)

_LIGHT: dict[str, dict[str, str]] = {
    "auto": {
        "label": "Авто",
        "hint": "Свет по тексту или по подаче (Кино/Клип)",
        "visual_style": "",
        "assistant_hint": "",
    },
    "soft_key_45": {
        "label": "Мягкий ключ 45°",
        "hint": "Большой soft key сбоку, negative fill, лёгкий edge",
        "visual_style": (
            "Lighting geometry: large soft key from camera-left ~45°, controlled negative fill on the opposite side, "
            "gentle edge/back separation; key direction locked for the whole clip — no light flip."
        ),
        "assistant_hint": (
            "Свет: мягкий ключ ~45° слева от камеры, negative fill справа, лёгкий контровой; "
            "направление ключа стабильно весь клип."
        ),
    },
    "hard_side": {
        "label": "Жёсткий боковой",
        "hint": "Жёсткий ключ сбоку, глубокая тень, контраст",
        "visual_style": (
            "Lighting geometry: hard directional key from camera-left (near 90° side light), deep shadow falloff, "
            "minimal fill; silhouette readable; key direction locked — no ambient wash that flattens contrast."
        ),
        "assistant_hint": (
            "Свет: жёсткий боковой ключ, глубокая тень, почти без fill; контраст держится весь клип."
        ),
    },
    "practical_back": {
        "label": "Практикл сзади",
        "hint": "Тёплый practical в фоне + мягкий fill спереди",
        "visual_style": (
            "Lighting geometry: warm practical lamp in the background as motivated backlight/edge, "
            "soft low frontal fill just enough for the face; practical stays the brightest background cue; "
            "direction locked for the clip."
        ),
        "assistant_hint": (
            "Свет: тёплый practical сзади как edge, мягкий слабый fill спереди; practical не гаснет и не прыгает."
        ),
    },
    "overhead_soft": {
        "label": "Мягкий верх",
        "hint": "Мягкий верхний ключ, глаза в тени осторожно",
        "visual_style": (
            "Lighting geometry: large soft overhead key with slight forward bias so eye sockets stay readable, "
            "gentle bounce from below or floor; no harsh top-only raccoon eyes; direction locked."
        ),
        "assistant_hint": (
            "Свет: мягкий верх с лёгким наклоном вперёд, глазницы читаемы; без жёсткого «енота»."
        ),
    },
}


def light_presets() -> list[dict]:
    return [
        {"id": k, "label": v["label"], "hint": v["hint"]}
        for k, v in ((lid, _LIGHT[lid]) for lid in LIGHT_IDS)
    ]


def normalize_light(light: str | None) -> LightId:
    if light in _LIGHT:
        return light  # type: ignore[return-value]
    return "auto"


def assistant_light_block(light: str | None) -> str:
    cid = normalize_light(light)
    catalog = "\n".join(
        f"- {k} ({_LIGHT[k]['label']}): {_LIGHT[k]['hint']}"
        for k in LIGHT_IDS
        if k != "auto"
    )
    if cid == "auto":
        current = (
            "Сейчас эксперт свет: auto — опиши свет конкретно по сцене или по блоку ПОДАЧА; "
            "направление ключа не должно хаотично меняться внутри клипа."
        )
    else:
        v = _LIGHT[cid]
        current = (
            f"Сейчас эксперт свет: {cid} ({v['label']}) — ПРИНУДИТЕЛЬНО.\n"
            f"{v['assistant_hint']}\n"
            f"Впиши в visual_style (можно рядом с look):\n{v['visual_style']}"
        )
    return f"""=== СВЕТ (эксперт) ===
Свет = геометрия (key direction / quality / fill), не слово «cinematic lighting».
Направление ключа стабильно весь клип, если история явно не требует смены.
Приоритет: экспертный свет > явный свет в тексте пользователя > вывод по смыслу / подача.

Каталог:
{catalog}

{current}"""


def user_light_directive(light: str | None) -> str:
    cid = normalize_light(light)
    if cid == "auto":
        return (
            "Свет (эксперт = Авто): задай конкретную геометрию ключа в visual_style "
            "(направление, мягкость/жёсткость, fill); не переворачивай ключ внутри клипа."
        )
    v = _LIGHT[cid]
    return (
        f"Свет (ЭКСПЕРТ, ОБЯЗАТЕЛЬНО): «{v['label']}» ({cid}). "
        f"В visual_style впиши геометрию:\n{v['visual_style']}"
    )


def apply_light(prompt: str, light: str | None) -> str:
    """Append expert lighting line under visual_style (create section if missing). Idempotent."""
    cid = normalize_light(light)
    line = _LIGHT[cid].get("visual_style") or ""
    if not line:
        return prompt
    if line[:48].lower() in prompt.lower():
        return prompt

    text = prompt.replace("\r\n", "\n").rstrip()
    rows = text.splitlines()
    heads = {l.strip().lower(): i for i, l in enumerate(rows)}
    section_heads = {
        "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:",
    }

    if (i := heads.get("visual_style:")) is not None:
        at = i + 1
        if at < len(rows) and not rows[at].strip():
            at += 1
        end = at
        while end < len(rows) and not (
            rows[end].strip().endswith(":") and rows[end].strip().lower() in section_heads
        ):
            end += 1
        rows[end:end] = [line, ""]
        return "\n".join(rows).rstrip() + "\n"

    if (i := heads.get("overall_soundscape:")) is not None:
        rows[i:i] = ["visual_style:", "", line, ""]
        return "\n".join(rows)
    return text + "\n\nvisual_style:\n\n" + line + "\n"
