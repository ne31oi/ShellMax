"""Camera technique presets — HSE semantics + Shot Bible geometry for H3 prompts.

Used by the assistant (compose / edit / chat). Expert override beats user text;
Auto falls back to user text, then inference. One clip = one primary camera motion.
"""

from __future__ import annotations

from typing import Literal

CameraId = Literal[
    "auto",
    "neutral",
    "low_angle",
    "high_angle",
    "dutch_angle",
    "zoom",
    "dolly_zoom",
    "tracking",
    "camera_roll",
    "arc",
    "whip_pan",
    "snorricam",
]

CAMERA_IDS: tuple[CameraId, ...] = (
    "auto",
    "neutral",
    "low_angle",
    "high_angle",
    "dutch_angle",
    "zoom",
    "dolly_zoom",
    "tracking",
    "camera_roll",
    "arc",
    "whip_pan",
    "snorricam",
)

# geometry / negatives from Camera & Shot Bible; h3_line compiles into detailed_description
_CAMERA: dict[str, dict[str, str]] = {
    "auto": {
        "label": "Авто",
        "emotion": "",
        "hint": "Эксперт не фиксирует камеру",
        "geometry": "",
        "negatives": "",
        "h3_line": "",
        "assistant_hint": "",
    },
    "neutral": {
        "label": "Eye level",
        "emotion": "нейтральное наблюдение",
        "hint": "Точка отсчёта — ровный горизонт",
        "geometry": "height≈1.55–1.70m eye-level; pitch 0°; 35–50mm FF-eq; distance MCU/MS; static",
        "negatives": "no dutch roll, no orbit, no focal-length change, no height change",
        "h3_line": (
            "SHOT: medium close-up / medium shot; camera at eye level (~1.6 m), pitch 0°, "
            "35–50mm equivalent, locked tripod. COMPOSITION: horizon level; subject centered or on a third. "
            "CAMERA MOTION: static. FOCUS: near eye. "
            "NEGATIVE: no Dutch roll, no orbit, no zoom, no height change."
        ),
        "assistant_hint": (
            "Нейтральный eye-level: статичная камера, горизонт 0°, MCU/MS. Контрольная точка для сравнения."
        ),
    },
    "low_angle": {
        "label": "Низкий ракурс",
        "emotion": "власть / давление",
        "hint": "Камера снизу — сила и доминирование",
        "geometry": "height≈0.35–0.55m; pitch +10–20°; 28–35mm; subject 1.5–2.5m; static (optional micro push)",
        "negatives": "no ultra-wide fish-eye for effect only, no orbit, no zoom, preserve verticals",
        "h3_line": (
            "SHOT: medium low-angle; camera height ~0.4 m, pitch +12°, 28–35mm equivalent, "
            "subject ~2 m away. COMPOSITION: subject dominates the upper frame; verticals preserved. "
            "CAMERA MOTION: locked (optional slow 20–30 cm push-in). FOCUS: eyes. "
            "EMOTION: dominance / pressure. "
            "NEGATIVE: no fish-eye distortion for effect, no orbit, no focal-length change."
        ),
        "assistant_hint": (
            "Низкий ракурс = геометрия (высота/pitch), не «красиво снизу». Эмоция — сила, угроза."
        ),
    },
    "high_angle": {
        "label": "Высокий ракурс",
        "emotion": "уязвимость",
        "hint": "Камера сверху — слабость и опасность",
        "geometry": "height≈1.9–2.4m; pitch −30–45°; 35–50mm; more negative space; static",
        "negatives": "no crane flourish, no orbit, no zoom; keep subject smaller in frame",
        "h3_line": (
            "SHOT: medium high-angle; camera ~2.1 m high, pitch −35°, 35–50mm equivalent. "
            "COMPOSITION: subject lower in frame with clear negative space; environment share high. "
            "CAMERA MOTION: locked. FOCUS: eyes / upper face. "
            "EMOTION: vulnerability / looming danger. "
            "NEGATIVE: no decorative crane move, no orbit, no zoom."
        ),
        "assistant_hint": (
            "Высокий ракурс: уязвимость через геометрию и negative space, не через «игру страха»."
        ),
    },
    "dutch_angle": {
        "label": "Голландский угол",
        "emotion": "нарушение равновесия",
        "hint": "Наклон горизонта 12–20°",
        "geometry": "height≈1.3–1.6m; roll 12–20°; 35–50mm; static against clear verticals",
        "negatives": "do not level horizon in post; no subject lean as fake dutch; no multi-axis motion",
        "h3_line": (
            "SHOT: Dutch-angle MCU/MS; camera ~1.4 m, deliberate roll 12–20°, 35–50mm equivalent. "
            "COMPOSITION: clear verticals in background so the frame axes feel broken; horizon stays tilted. "
            "CAMERA MOTION: locked (optional micro push). FOCUS: eyes. "
            "EMOTION: imbalance / unease. "
            "NEGATIVE: do not straighten the horizon; do not tilt the actor separately; no pan+tilt combo."
        ),
        "assistant_hint": "Dutch = сломанная координатная система кадра, не наклон актёра.",
    },
    "zoom": {
        "label": "Zoom",
        "emotion": "акцент",
        "hint": "Только оптический zoom, корпус неподвижен",
        "geometry": "tripod locked; optical zoom only (e.g. 50→85mm); hold–zoom–hold",
        "negatives": "no camera translation, no dolly, no orbit, no simultaneous pan",
        "h3_line": (
            "SHOT: locked tripod; start hold, optical zoom-in with medium amplitude at moderate speed "
            "(camera body does not translate), end hold — e.g. ~50→85mm equivalent. "
            "CAMERA MOTION: zoom only. FOCUS: pretest both ends. "
            "EMOTION: psychological accent. "
            "NEGATIVE: no dolly, no truck, no orbit, no pan during the zoom."
        ),
        "assistant_hint": "Zoom ≠ push: корпус неподвижен, меняется только фокусное.",
    },
    "dolly_zoom": {
        "label": "Dolly zoom",
        "emotion": "психологический сдвиг",
        "hint": "Размер героя постоянен, фон меняет перспективу",
        "geometry": "dolly-in + zoom-out opposite; subject size constant; ~6s active",
        "negatives": "no subject size drift, no lateral path, no height change, no roll",
        "h3_line": (
            "SHOT: dolly zoom — camera dollies toward the subject while zooming out at matching speed "
            "so head/torso size stays approximately constant while background perspective stretches "
            "(example start ~70mm at ~3 m → ~35–40mm at ~1.6 m). "
            "CAMERA MOTION: single axis along the lens; zoom opposed to dolly. "
            "EMOTION: perceptual shock. "
            "NEGATIVE: no subject-size drift, no lateral drift, no roll, no second motion axis."
        ),
        "assistant_hint": "Критерий успеха dolly zoom — размер лица почти не меняется.",
    },
    "tracking": {
        "label": "Tracking",
        "emotion": "вовлечение",
        "hint": "Камера идёт рядом с героем",
        "geometry": "height≈1.2–1.4m; 24–35mm; lateral follow; subject scale constant",
        "negatives": "no vertical gimbal bob, no zoom, no orbit, match subject speed",
        "h3_line": (
            "SHOT: tracking beside the subject at chest height (~1.3 m), 24–35mm equivalent, "
            "distance ~1.5 m, matching walking speed. "
            "CAMERA MOTION: follow / truck with constant subject scale. FOCUS: eye AF or locked on face. "
            "EMOTION: physical involvement. "
            "NEGATIVE: no vertical bob, no zoom, no orbit, no speed mismatch."
        ),
        "assistant_hint": "Tracking: постоянный масштаб и скорость шага.",
    },
    "camera_roll": {
        "label": "Camera roll",
        "emotion": "дезориентация",
        "hint": "Вращение вокруг оси объектива",
        "geometry": "24–35mm; roll 0→±90° over ~5s; distance fixed",
        "negatives": "no simultaneous pan/tilt/push; pure roll only",
        "h3_line": (
            "SHOT: controlled camera roll around the lens axis from level horizon to ~+90° over ~5 s, "
            "24–35mm equivalent; subject distance fixed. "
            "CAMERA MOTION: roll only. "
            "EMOTION: loss of orientation. "
            "NEGATIVE: no pan, no tilt, no push during the roll."
        ),
        "assistant_hint": "Только roll — без pan/tilt/push одновременно.",
    },
    "arc": {
        "label": "Arc",
        "emotion": "пространственное давление",
        "hint": "Дуга вокруг героя, радиус постоянный",
        "geometry": "radius≈1.5–2m; arc ~120°; 28–35mm; subject centered; ~8s",
        "negatives": "no radius drift, no zoom, no replace-with-tripod-pan",
        "h3_line": (
            "SHOT: arc/orbit ~120° around a centered subject at steady ~1.5–2 m radius, "
            "28–35mm equivalent, ~8 s; camera faces inward. "
            "CAMERA MOTION: arc only; subject scale nearly constant. "
            "EMOTION: space pivots around the hero. "
            "NEGATIVE: no radius drift, no zoom, no tripod pan substitute."
        ),
        "assistant_hint": "Нужен параллакс дуги, не pan со штатива.",
    },
    "whip_pan": {
        "label": "Whip pan",
        "emotion": "импульс / шок",
        "hint": "Быстрый pan со смазом как переход",
        "geometry": "35–50mm; pan 70–110° in <1s; cut inside max blur",
        "negatives": "no direction mismatch; match exposure/WB; do not cut on sharp frames",
        "h3_line": (
            "SHOT: whip pan — very fast horizontal pan (~70–110° in under a second) into heavy motion blur, "
            "35–50mm equivalent, landing on a new beat. "
            "CAMERA MOTION: whip pan only. "
            "EMOTION: impulse / shock. "
            "NEGATIVE: no mismatched direction; keep exposure/WB continuous; energy lives in the blur."
        ),
        "assistant_hint": "Энергия в смазе; направление концов согласовано.",
    },
    "snorricam": {
        "label": "Snorricam",
        "emotion": "субъективная тревога",
        "hint": "Лицо зафиксировано, мир двигается",
        "geometry": "18–24mm; lens-to-face ~45–70cm; rig locked to torso; face fixed in frame",
        "negatives": "no independent camera orbit; face must stay nearly locked; world moves instead",
        "h3_line": (
            "SHOT: snorricam MCU; 18–24mm equivalent; lens ~45–70 cm from face; camera rigidly locked to torso "
            "so the face stays nearly fixed while the background slides with each step. "
            "CAMERA MOTION: body-mounted; face is the lock. FOCUS: fixed manual distance. "
            "EMOTION: subjective anxiety. "
            "NEGATIVE: no free camera orbit; do not let the face drift out of lock."
        ),
        "assistant_hint": "Лицо — якорь; мир движется. Пик субъективности.",
    },
}


SHOT_BIBLE_RULES = (
    "Правила Shot Bible (обязательны):\n"
    "- Один AI-клип = одно главное событие + одно главное движение героя + одно главное движение камеры.\n"
    "- Камера — геометрия (height, pitch/roll, distance, mm-equivalent, path/speed), не слово «cinematic».\n"
    "- Запрещён голый «dynamic camera» / «dramatic angle» без чисел и пути.\n"
    "- В конце shot-описания явно перечисли NEGATIVE: что не меняется (zoom/orbit/light flip/identity…).\n"
    "- Приоритет при конфликте: референсы/субъект > геометрия кадра > blocking > motion > focus > свет > атмосфера.\n"
    "- Короткие клипы (≲ 4 с) — строго один [Shot 1]."
)

PRIORITY_RULES = (
    "Приоритет выбора приёма: (1) экспертный выбор ниже > (2) явный запрос в тексте пользователя > "
    "(3) вывод по смыслу сцены и рефов.\n"
    "Если эксперт ≠ auto — камера в detailed_description ОБЯЗАНА соответствовать выбору; "
    "противоречащие указания о камере в тексте заменить.\n"
    "Если эксперт = auto и пользователь явно назвал приём — следуй тексту.\n"
    "Иначе подбери ОДИН приём из каталога."
)


def camera_presets() -> list[dict]:
    """UI / meta list: id, label, hint, emotion (empty for auto)."""
    return [
        {
            "id": k,
            "label": v["label"],
            "hint": v["hint"],
            **({"emotion": v["emotion"]} if v["emotion"] else {}),
        }
        for k, v in ((cid, _CAMERA[cid]) for cid in CAMERA_IDS)
    ]


def normalize_camera(camera: str | None) -> CameraId:
    if camera in _CAMERA:
        return camera  # type: ignore[return-value]
    return "auto"


def assistant_camera_block(camera: str | None) -> str:
    """Full === КАМЕРА === block for compose / edit / chat system prompts."""
    cid = normalize_camera(camera)
    catalog_lines = []
    for k in CAMERA_IDS:
        if k == "auto":
            continue
        v = _CAMERA[k]
        catalog_lines.append(
            f"- {k} ({v['label']}): эмоция «{v['emotion']}»; {v['geometry']}. "
            f"NEGATIVE: {v['negatives']}"
        )
    catalog = "\n".join(catalog_lines)

    if cid == "auto":
        current = (
            "Сейчас эксперт: auto — не фиксируй камеру из UI; применяй приоритет (2) текст, иначе (3) вывод. "
            "Скомпилируй выбранный приём в detailed_description блоками SHOT / COMPOSITION / CAMERA MOTION / "
            "FOCUS / EMOTION / NEGATIVE."
        )
    else:
        v = _CAMERA[cid]
        current = (
            f"Сейчас эксперт: {cid} ({v['label']}) — ПРИНУДИТЕЛЬНО.\n"
            f"Эмоция: {v['emotion']}. Геометрия: {v['geometry']}.\n"
            f"{v['assistant_hint']}\n"
            f"Впиши в detailed_description (адаптируй под сцену, сохрани механику):\n{v['h3_line']}"
        )

    return f"""=== КАМЕРА ===
{SHOT_BIBLE_RULES}

{PRIORITY_RULES}

Каталог приёмов:
{catalog}

{current}"""


def user_camera_directive(camera: str | None) -> str:
    """Short mandate appended to the compose/edit USER message so the model cannot miss expert camera."""
    cid = normalize_camera(camera)
    if cid == "auto":
        return (
            "Камера (эксперт = Авто): если в описании явно назван ракурс/движение — следуй ему; "
            "иначе сам выбери ОДИН приём из каталога. В detailed_description опиши геометрию "
            "(height/pitch/distance/mm, path/speed) и NEGATIVE. Один клип — одно camera motion. "
            "Запрещён голый «dynamic camera»."
        )
    v = _CAMERA[cid]
    return (
        f"Камера (ЭКСПЕРТ, ОБЯЗАТЕЛЬНО, сильнее текста): «{v['label']}» ({cid}). "
        f"Эмоция: {v['emotion']}. Геометрия: {v['geometry']}.\n"
        f"В detailed_description — ИМЕННО этот приём; другие указания о камере заменить.\n"
        f"Опора:\n{v['h3_line']}"
    )
