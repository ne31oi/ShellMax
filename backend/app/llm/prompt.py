"""System prompts for the assistant's two jobs:

1. compose - turn the user's plain-words description (with reference tags) into a prompt;
2. face    - write the close-up prompt for MiniMax_H3_FaceRefine_Best.

Prompt-writing rules: the user's specification (prompt_spec.md, verbatim copy of
MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md).
Reference honesty rules and the fenced output contract: Minimax Studio V6
(src/lib/h3-prompt-spec.ts, assistant-stream.ts). Face refine rules: the notes of
workflows/MiniMax_H3_FaceRefine_Best.json.
"""

import re
from pathlib import Path

from pydantic import BaseModel, Field

SPEC = Path(__file__).with_name("prompt_spec.md").read_text(encoding="utf-8").strip()
F = "```"


class RefInfo(BaseModel):
    kind: str  # image | video | audio
    name: str
    with_audio: bool = False
    refmod: bool = False
    image_available: bool = True
    source_kind: str = ""
    description: str = ""
    appearance: str = ""
    voice_description: str = ""
    retained_attributes: str = ""
    attached_images: list[str] = Field(default_factory=list)


def _audio_refs(refs: list[RefInfo]) -> list[RefInfo]:
    """H3 numbers paired video soundtracks before standalone audio files."""
    paired = [RefInfo(kind="audio", name=f"Звуковая дорожка видео {r.name}")
              for r in refs if r.kind == "video" and r.with_audio]
    return paired + sorted([r for r in refs if r.kind == "audio"], key=lambda r: r.refmod)


def _reference_counts(refs: list[RefInfo]) -> dict[str, int]:
    return {"image": sum(r.kind == "image" for r in refs),
            "video": sum(r.kind == "video" for r in refs),
            "audio": len(_audio_refs(refs))}


OUTPUT_CONTRACT = f"""=== ФОРМАТ ОТВЕТА (БЕЗ ИСКЛЮЧЕНИЙ) ===
Ответ — ТОЛЬКО готовый промпт в markdown code fence, без пояснений до или после:
{F}text
subject_definitions:
...
non_diegetic_music:
...
{F}
- первая строка внутри fence — subject_definitions:
- поля по порядку: subject_definitions, summary, retention_analysis, detailed_description, visual_style (если добавлен), overall_soundscape, non_diegetic_music;
- строку id="x..." из шаблонов спецификации НЕ выводи — это служебная метка корпуса;
- промпт на английском (кроме реплик персонажей и видимого в кадре текста)."""

SPEC_BLOCK = f"""=== ПРАВИЛА НАПИСАНИЯ ПРОМПТА (ОБЯЗАТЕЛЬНО) ===
Пиши промпт СТРОГО по спецификации ниже и перед выдачей пройди её «Final Quality Checklist».

=== СПЕЦИФИКАЦИЯ ===
{SPEC}
=== КОНЕЦ СПЕЦИФИКАЦИИ ==="""

HONESTY = """=== ЧЕСТНОСТЬ И ТОЧНОСТЬ РЕФЕРЕНСОВ ===
1) Набор референсов — ТОЧНО тот, что перечислен выше. Используй ТОЛЬКО эти метки.
2) НИКОГДА не выдумывай деталь референса, которую не видишь на изображении.
3) АУДИО ты НЕ слышишь: ссылайся только меткой <Audio N>; реплики и текст песни бери ТОЛЬКО из текста
   пользователя, не придумывай слова. Не подменяй аудио-реф словесным описанием «стиля музыки»."""


def _refs_block(refs: list[RefInfo]) -> str:
    images = sorted([r for r in refs if r.kind == "image"], key=lambda r: r.refmod)
    videos = sorted([r for r in refs if r.kind == "video"], key=lambda r: r.refmod)
    audios = _audio_refs(refs)
    if not refs:
        return ("Референсов НЕТ. Метки <Picture N>, <Video N>, <Audio N> ЗАПРЕЩЕНЫ. Субъекты и окружение описывай "
                "словами и помечай в retention_analysis как newly_generated.")
    lines = ["Промпт без меток при прикреплённых референсах = ОШИБКА."]
    if images:
        lines.append("Каждое изображение обязано попасть в промпт своей меткой <Picture N>: создай <Subject N> в "
                     "subject_definitions и привяжи его к <Picture N> (раздел 4 спецификации), дальше используй <Subject N>.")
    if images:
        lines.append("ИЗОБРАЖЕНИЯ — приложены только доступные картинки/превью; отсутствующие не выдумывай:")
        lines += [f"  <Picture {i}> = {r.name}" + (" (картинка приложена)" if r.image_available else " (превью отсутствует, содержимое НЕ видно)") for i, r in enumerate(images, 1)]
    if videos:
        lines.append("РЕФЕРЕНСЫ С МЕТКОЙ VIDEO — тип содержимого указан отдельно:")
        for i, r in enumerate(videos, 1):
            if r.source_kind == "photo_set":
                detail = ("набор статичных фото в одном RefMod, НЕ видеоклип и НЕ последовательность действий. "
                          "Все фото относятся к одной метке; не создавай для них дополнительные <Picture N>. "
                          "Используй этот набор для внешности, одежды и аксессуаров по запросу пользователя. "
                          "Движение, камеру и монтаж задаёт запрос, их нельзя выводить из порядка фото. "
                          "Обязательно свяжи <Video " + str(i) + "> с соответствующим субъектом/предметом "
                          "в subject_definitions и retention_analysis")
            else:
                detail = ("видеореференс; движение и последовательность кадров НЕ видны ассистенту. "
                          "Превью, если приложено, показывает только внешность; не угадывай движение")
            lines.append(f"  <Video {i}> = {r.name} ({detail})" +
                         (" (со звуковой дорожкой для MiniMax)" if r.with_audio else ""))
            if r.source_kind == "photo_set" and not r.image_available:
                lines.append("  Фото/превью этого набора НЕ приложены в этом запросе; не выдумывай внешность.")
    if audios:
        lines.append(
            "АУДИО — прикреплённые звуковые референсы для MiniMax. Ты их НЕ слышишь; модель получит файл по метке "
            "<Audio N>. Каждое аудио ОБЯЗАНО появиться в промпте своей меткой:"
        )
        lines += [f"  <Audio {i}> = {r.name}" for i, r in enumerate(audios, 1)]
        lines.append(
            "РОЛЬ АУДИО (выбери по запросу пользователя):\n"
            "  • липсинг / подпевание / речь или вокал «по аудио» / lipsync / «к референсу» / «под трек» → "
            "<Audio N>: fully_copy в retention_analysis; звук референса = полная звуковая дорожка клипа; "
            "губы, челюсть и мимика в detailed_description СЛЕДУЮТ за <Audio N> (точный тайминг). "
            "Слова песни/реплик НЕ выдумывай — пиши синхронизацию с <Audio N>; <d>...</d> только если "
            "пользователь дал текст.\n"
            "  • только тембр голоса / «говорит этим голосом» без копирования трека → <Audio N>: reference; "
            "тембр из рефа, текст реплик — из слов пользователя.\n"
            "  • фон/SFX из рефа → partially_copy или reference, с ясным слоем в overall_soundscape.\n"
            "ЗАПРЕЩЕНО при наличии аудио-рефа на липсинг/трек: описывать жанр, BPM, инструменты или «trap beat / "
            "cinematic score» ВМЕСТО метки <Audio N>; писать такой стиль в non_diegetic_music; игнорировать "
            "<Audio N>. Если весь саундтрек из <Audio N> — overall_soundscape явно ссылается на него "
            "(например: «The exact supplied sound from <Audio 1> is the complete soundtrack; mouth movement "
            "follows it.»), а non_diegetic_music = N/A."
        )
    if not videos:
        lines.append("<Video N> ЗАПРЕЩЕНЫ — видео-референсов нет.")
    if not audios:
        lines.append("<Audio N> ЗАПРЕЩЕНЫ — аудио-референсов нет; голоса и реплики описывай словами.")
    if images or any(r.source_kind == "photo_set" for r in videos):
        # a reference photo of someone biting a donut must not turn "she dances" into a donut video
        lines.append("КАРТИНКА ЗАДАЁТ ТОЛЬКО ВНЕШНОСТЬ (лицо, волосы, телосложение, одежда, украшения). Поза, жесты, выражение, "
                     "предметы в руках, еда, фон, КРОП/КРУПНОСТЬ/ДИСТАНЦИЯ КАМЕРЫ на фото и то, что человек делает на "
                     "картинке, — НЕ действие и НЕ кадрирование видео. Действие, место и камеру бери ТОЛЬКО из описания "
                     "пользователя и выбранных кинотехник. Если на картинке портрет или макро глаза, а выбрана "
                     "дальняя крупность — в кадре крошечная фигура в пространстве; НЕ копируй близкий кроп фото. "
                     "Если на картинке есть предметы или поза, которых нет в описании, в subject_definitions прямо "
                     "напиши, что они НЕ часть кадра (например: \"the donut she holds in <Picture 1> is not part of "
                     "this shot\"), и не сохраняй их в retention_analysis. Фон картинки — место действия, только если "
                     "пользователь не назвал другое.")
        lines.append("ВИЗУАЛЬНЫЙ ЯКОРЬ: начни определение персонажа прямой связью с фото: "
                     "'<Subject N> is the same person shown in <Picture K>'. Номера бери из текущих референсов. "
                     "Фото задаёт конкретного человека; слова 'young woman', 'natural skin' или 'pretty face' не заменяют "
                     "эту связь. Кратко опиши только различимые признаки: контур лица, форму глаз и бровей, носа и губ, "
                     "волосы, макияж и видимую одежду. Не угадывай цвет глаз, возраст, телосложение, скрытую одежду или "
                     "сторону украшения; если деталь неразличима, опусти её. Для стороны различай сторону человека и "
                     "сторону изображения. Не добавляй коже румянец, лицу новую асимметрию или идеальные пропорции "
                     "ради реализма — сохраняй наблюдаемые черты. В retention_analysis явно сохраняй личность и "
                     "геометрию лица; движение, эмоция и свет могут меняться без замены человека.")
        lines.append("СОГЛАСОВАННОСТЬ ВНЕШНОСТИ: текущие фото важнее описаний внешности из прежних ответов ассистента "
                     "и старого черновика. Исключение — явные изменения, запрошенные пользователем. При составлении "
                     "промпта или замене персонажа проверь ВСЕ секции, включая detailed_description: цвет глаз, "
                     "волосы, одежда, украшения и местоимения не должны возвращаться к прежнему герою. Не переписывай "
                     "лицо общими словами заново в каждом действии; используй тот же <Subject N>. Если пользователь "
                     "просит изменение только отражения или двойника, явно отдели его от основного героя: изменение "
                     "внешности относится только к отражению/двойнику.")
        lines.append(
            "ЖИВОЕ ЛИЦО (анти–зловещая долина): лицо — живой человек, не манекен и не CGI. В detailed_description "
            "обязательно опиши наблюдаемую микро-мимику (§13 спецификации): направление взгляда и на что смотрит, "
            "моргание, сохранение видимой на фото естественной асимметрии, микро-сдвиги бровей и губ "
            "под эмоцию и речь, влажный блик в глазах, живую кожу с тоном и текстурой референса. "
            "Запрещены формулировки вроде perfect symmetric face, flawless skin, doll-like, mannequin, wax figure, "
            "frozen expression. Не оставляй лицо в «neutral expression» на весь клип, если есть речь, музыка или действие — "
            "выражение должно меняться по ходу."
        )
    if not images:
        # Photo stacks retain their Video label; examples must not invent Picture labels.
        lines = [line.replace("<Picture K>", "<Video K>").replace("<Picture 1>", "<Video 1>") for line in lines]
    attachment_index = 0
    for ref in refs:
        group = images if ref.kind == "image" else videos if ref.kind == "video" else audios
        label = {"image": "Picture", "video": "Video", "audio": "Audio"}[ref.kind]
        index = next(index for index, item in enumerate(group, 1) if item is ref)
        tag = f"<{label} {index}>"
        if ref.refmod:
            for title, value in (("Описание", ref.description), ("Внешность", ref.appearance),
                                 ("Описание голоса", ref.voice_description), ("Сохраняемые признаки", ref.retained_attributes)):
                if value:
                    lines.append(f"Метаданные {tag}, {title} (текст автора, не наблюдение ассистента): {value}")
        for name in ref.attached_images:
            attachment_index += 1
            lines.append(f"Вложенная картинка {attachment_index}: {tag} — {name}. "
                         "Это фото/превью этого референса, а не отдельная метка генерации.")
    return "\n".join(lines)


# Operational emphasis distilled from the H3 Singularity skill (SKILL.md): reinforces
# high-value writing habits without replacing prompt_spec.md. Interactive skill bits
# (ask clarifying questions; post-prompt assumptions) stay out — UI supplies duration/refs
# and OUTPUT_CONTRACT forbids text outside the fence.
CINEMA_CRAFT = """=== РЕАЛИЗМ И КИНОШНОСТЬ ===
1) Обязателен блок visual_style (отдельной секцией после detailed_description и перед overall_soundscape, если его ещё нет): источник и направление
   света, контраст/атмосфера (haze, пыль — по месту), глубина резкости / фокус, отклик материалов (кожа, ткань, металл,
   стекло). Конкретно (§11), не словами cinematic / epic / high quality в одиночку. Motion blur — только если скорость оправдывает.
2) Камера — пять элементов из спеки: shot size / позиция → тип движения → направление → скорость/амплитуда → кого
   ведёт + DoF. Именованные движения (track, push-in, pull-back, pan, tilt, orbit/arc, swoop, whip-pan, dive,
   barrel roll, handheld, locked-off). Привяжи камеру к действию. Запрещён голый «dynamic camera».
3) Действие — цепочка, не ярлык (§8): preparation → trigger → acceleration → primary action → contact → reaction →
   recovery → final state. Не пиши голое «attacks» / «explodes» / «walks». Далёкие фигуры, которые должны идти, —
   явно «continue walking throughout the shot».
4) VFX = trigger + form + motion + environmental consequence (§10). Физический отклик: ткань/волосы, пыль от шагов,
   отдача, свет взрыва на соседних поверхностях.
5) Лица — живые (§13): взгляд (на что смотрит), брови, губы, дыхание, осанка, руки; запрет doll / mannequin / frozen /
   perfect symmetric.
6) Continuity (§12): screen direction, оружие/проп, урон/грязь, одежда и identity стабильны между шотами; стойкие
   состояния переноси вперёд. Один и тот же <Subject N> не переопределяй по-разному в разных шотах.
7) Anti-drift: если constraint должен держаться (масштаб фигуры, фон, композиция, PREVIS LOCK) — повтори его
   вариативно в КАЖДОМ шоте, а не один раз вверху.
8) summary — прогрессия действия и конечное состояние, не только premise. Не упаковывай слишком много одновременных
   действий в один шот. Звук синхронен видимым событиям; (S1)/(S2) стабильны; диалог — в языке оригинала.
9) Звук: тихий ambient + 1–2 синхронных diegetic эффекта к видимым событиям; non_diegetic_music не забивает речь.
   Если есть аудио-референс и запрос на липсинг/трек — приоритет у правил АУДИО выше (метка <Audio N>, не выдуманный score).
10) Короткие клипы (≲ 4 с): обычно ОДИН [Shot 1], одна камера, один эмоциональный бит — не трейлер из трёх склеек.
11) Style-LoRA / чип «Стиль»: НЕ вписывай в текст слоганы-триггеры вроде «80s Fantasy Movie Still», «ArsMovieStill»,
   «Cel Shading Style», «r34l1sm» и похожие brand-фразы. Их подставляет приложение в visual_style только если
   пользователь включил соответствующий чип. Если такие фразы уже есть в черновике — удали их из описания."""


def plain_selects_block(look: str | None = None, camera: str | None = "auto",
                        light: str | None = "auto",
                        cinematic_technique: str | None = "auto",
                        cinematic_techniques: list[str] | None = None) -> str:
    """UI selects as hard PREVIS locks (same profiles as the 3D cinema preview)."""
    from ..workflow.camera import camera_presets
    from ..workflow.cinematography import resolve_cinematic_technique_ids, selected_cinematic_techniques
    from ..workflow.light import light_presets
    from ..workflow.look import look_presets
    from ..workflow.preview_directives import h3_directive_for_technique, preview_lock_preamble

    lines: list[str] = []
    look_id = (look or "").strip()
    if look_id and look_id not in ("", "natural"):
        meta = next((p for p in look_presets() if p["id"] == look_id), None)
        if meta:
            lines.append(f"- Look / delivery: {meta['label']} — {meta.get('hint', '')}".rstrip(" —"))

    cam = (camera or "auto").strip() or "auto"
    if cam != "auto":
        meta = next((p for p in camera_presets() if p["id"] == cam), None)
        label = meta["label"] if meta else cam
        hint = meta.get("hint", "") if meta else ""
        lines.append(
            f"- Camera expert override: {label}"
            + (f" — {hint}" if hint else "")
            + ". Lock this motion/angle into every shot."
        )

    lit = (light or "auto").strip() or "auto"
    if lit != "auto":
        meta = next((p for p in light_presets() if p["id"] == lit), None)
        label = meta["label"] if meta else lit
        hint = meta.get("hint", "") if meta else ""
        lines.append(
            f"- Light expert override: {label}"
            + (f" — {hint}" if hint else "")
            + ". Put this geometry into visual_style and every shot."
        )

    ids = resolve_cinematic_technique_ids(cinematic_techniques, cinematic_technique, cam, lit)
    for item in selected_cinematic_techniques(ids):
        sid = item.get("source_id") or item["id"]
        lock = h3_directive_for_technique(item["id"])
        lines.append(f"- {item['category']}: {sid} · {item['label']}\n  {lock}")

    if not lines:
        return ""
    return preview_lock_preamble() + "\n" + "\n".join(lines)


def compose_system(refs: list[RefInfo], duration: float, look: str | None = None,
                   camera: str | None = "auto", light: str | None = "auto",
                   cinematic_technique: str | None = "auto",
                   cinematic_techniques: list[str] | None = None) -> str:
    """System = MD spec + refs + output contract. Selects go in the user message as plain text."""
    del look, camera, light, cinematic_technique, cinematic_techniques  # selects are not system rules
    seconds = max(2.5, round(duration, 1))
    short = seconds <= 4.0
    shots_hint = ("For ~{s}s use one [Shot 1], no extra cuts.".format(s=seconds) if short
                  else "For this length one or two shots is usually enough.")
    return f"""You turn the user's brief into a MiniMax H3 video prompt (video + sync sound).
Keep the user's scene, action, place, and dialogue. Expand only what the specification asks for.
Character dialogue stays verbatim from the user text.

{SPEC_BLOCK}

{CINEMA_CRAFT}

=== CLIP ===
Duration: ~{seconds} s. Shot timestamps must fit; last cut ≤ duration − 2 s.
{shots_hint}

=== REFERENCES ===
{_refs_block(refs)}

{HONESTY}

{OUTPUT_CONTRACT}"""


def compose_user_message(text: str, *, look: str | None = None, camera: str = "auto",
                         light: str = "auto", cinematic_technique: str = "auto",
                         cinematic_techniques: list[str] | None = None) -> str:
    """User brief + hard previs locks — the only place technique choices are stated."""
    selects = plain_selects_block(look, camera, light, cinematic_technique, cinematic_techniques)
    parts = [
        "User description (this is the scene and action — keep it as the story spine):",
        text.strip(),
    ]
    if selects:
        parts += ["", selects]
    parts += [
        "",
        "Write the H3 prompt strictly by the specification in the system message. "
        "If PREVIS LOCK lines are present, use those shot size / angle / motion / light / optics "
        "as the active cinematography; keep the user's scene. "
        "Describe only what the frame shows — positive wording only. "
        "Return only the prompt inside the required ```text fence.",
    ]
    return "\n".join(parts)


def face_system() -> str:
    return f"""Ты пишешь промпт для УЛУЧШЕНИЯ ЛИЦА в готовом клипе MiniMax H3 (воркфлоу FaceRefine).
Как это работает: лицо находят на каждом кадре, вырезают так, чтобы оно заполнило холст 768×768, H3 перерисовывает
этот КРУПНЫЙ ПЛАН на умеренном денойзе, и лицо вклеивается обратно. Поэтому промпт описывает НЕ исходный общий план,
а КРУПНЫЙ ПЛАН лица и плеч: описание «общий план в полный рост» спорит с тем, что на холсте.

Референсы (фиксированы, других меток нет):
  <Picture 1> — фото персонажа: единственный авторитетный источник личности и внешности (прикреплено первым);
  <Picture 2> — крупный план лица, вырезанный из <Picture 1>: точная форма глаз, макияж, кожа, нос, рот (прикреплено вторым);
  <Audio 1> — точный звук этого клипа; ты его НЕ слышишь.
Третьим прикреплён КАДР ИСХОДНОГО КЛИПА — НЕ референс и НЕ метка: смотри на него только чтобы понять свет, фон,
ракурс головы и одежду в кадре.

Обязательные правила:
- subject_definitions: <Subject 1> — точный человек с <Picture 1>; перечисли по факту фото черты лица, глаза, брови,
  нос, губы, кожу, волосы, макияж, украшения. Если на <Picture 1> есть предметы, позы или взгляд, которых нет в клипе, —
  прямо укажи, что они НЕ часть кадра, из фото берутся только личность и внешность. Строка про <Picture 2> — крупный
  план лица для точных деталей. Строка про <Audio 1> — точный звук кадра; рот следует речи в нём с точной синхронизацией.
- retention_analysis: <Subject 1> fully_preserved с перечислением деталей; <Audio 1> — reference (слова и тайминг ведут губы).
- detailed_description: один кадр [Shot 1] — непрерывный ЖИВОЙ фотореалистичный крупный план <Subject 1> (человек, не кукла).
  Кадрирование, положение и размер головы, повороты головы, движения тела и камеры остаются ТОЧНО как в исходном видео —
  меняется только детализация лица. Лицо резкое и в фокусе; два естественных глаза с влажным бликом (лёгкая природная
  асимметрия допустима — НЕ пиши «perfectly symmetric»); естественные веки и ресницы; читаемый рот с естественными зубами.
  Губы, челюсть, щёки, брови и мелкая мимика двигаются с <Audio 1> и эмоцией речи; между фразами — естественное моргание
  и микро-сдвиги выражения, не застывшая маска. Черты и личность стабильны.
  Реплики пиши в <d>...</d> ТОЛЬКО если они есть в исходном промпте клипа — дословно; иначе не придумывай слова.
  Закончи запретами: No facial morphing, no duplicated features, no warping, no face blur, no plastic skin, no doll-like
  or mannequin face, no frozen expression, no CGI wax skin.
- visual_style (можно внутри detailed_description или отдельной строкой в конце описания): реальная фотографическая
  съёмка; живая кожа с порами, микротекстурой и лёгким подкожным тоном (не матовый пластик); пряди волос; свет как в
  окружающем кадре (по прикреплённому кадру клипа).
- overall_soundscape: ровно одна строка «Only the exact supplied sound from <Audio 1>.» — дословно, ничего не добавляй:
  звук берётся из клипа как есть, любое описание звука уводит губы от <Audio 1>.
- non_diegetic_music: ровно «N/A».
- Не описывай общий план, окружение подробно и действия всего тела — только то, что видно в крупном плане.

{SPEC_BLOCK}

{HONESTY}

{OUTPUT_CONTRACT}"""


EDIT_RULES = """Ты ПРАВИШЬ готовый промпт MiniMax H3 по просьбе пользователя (просьба — обычными словами, на любом языке).
- Внеси ТОЛЬКО то, о чём просят. Всё остальное оставь дословно: текст, порядок полей, метки <Picture N>/<Video N>/<Audio N>/<Subject N>.
- Не сокращай действие героя ради технической правки. Сохрани порядок, характер и тайминг его движений и реакций; STATIC / LOCKED-OFF фиксирует только камеру, не персонажа.
- Замена персонажа или просьба исправить сходство по фото относится ко ВСЕМ упоминаниям его внешности во ВСЕХ
  секциях, а не только к subject_definitions. Сначала сверь текущие фото, затем согласуй глаза, лицо, волосы,
  одежду, украшения и местоимения в retention_analysis и detailed_description. Удали оставшиеся признаки прежнего
  героя, кроме явно запрошенных пользователем изменений. Действие и постановку сохраняй. При правке только камеры
  или света не меняй внешность и личность персонажа.
- КРУПНОСТЬ / framing / shot size (крупный план, средний, общий, ECU/CU/MCU/MS/WS, close-up, wide, medium…):
  это запрос на КАДРИРОВАНИЕ всего кадра. В этом формате нет отдельного поля CAMERA / SHOT: не добавляй новые поля.
  Если пользователь не назвал конкретные кадры или не попросил чередование, одна указанная крупность относится
  ко ВСЕМ [Shot N] во всём промпте и остаётся одинаковой от первого кадра до последнего. Не превращай её в
  переход «сначала крупный, потом общий» или наоборот.
  Согласованно перепиши summary и detailed_description: первую фразу каждого [Shot N], дистанцию, оптику,
  положение героя в кадре, глубину резкости, фокусный якорь и траекторию камеры там, где они противоречат
  новой крупности. Например, общий план требует полного тела с запасом по краям и читаемого окружения;
  камера всё время держится на дистанции, позволяющей сохранить этот кадр. Не описывай движение камеры через
  лицо, наезд до глаз/татуировки или финальный крупный план внутри общего плана. Движение и действие героя
  сохраняй, если они совместимы с новым кадрированием; при конфликте адаптируй геометрию движения, а не
  кадрирование.
  Не оставляй несовместимые указания вроде close-up, medium close-up, head-and-shoulders, chest-to-head,
  waist-up или face filling the frame в любом из кадров общего плана. Не пиши противоречивые сочетания
  вроде «wide shot at chest-to-head level». Если пользователь явно задаёт крупности для отдельных кадров,
  примени их к указанным кадрам, не меняя остальные.
- Если правка по смыслу затрагивает другие поля (например, «ночь вместо дня» → свет в detailed_description и звук в
  overall_soundscape), обнови их минимально, чтобы промпт остался согласованным.
- Новые детали пиши так же конкретно, как требует спецификация (действия цепочкой, камера, физика, свет, звук).
- Реплики не придумывай: меняй или добавляй их только если пользователь дал текст.
- Верни ПОЛНЫЙ исправленный промпт, а не только изменённые куски."""


_SHOT_SIZE_HINT = (
    "крупн", "крупны", "крупнее", "мельче", "общий план", "общи", "средн", "дальний", "ближн",
    "сверхдальн", "поближе", "подальше", "приблизь", "отдали", "отдалить", "приблизить",
    "close-up", "close up", "closeup", "ecu", "mcu", "ms", "ws", "medium shot", "wide shot",
    "wide", "framing", "shot size", "waist", "head-and-shoulders", "chest-to-head", "chest to head",
    "full body", "full-body", "cowboy", "establishing", "extreme close", "extreme long", "extreme wide",
    "face fill", "планкадр", "кадрир", "ковбойск", "mid-thigh",
)


def _framing_target(instruction: str) -> str | None:
    low = instruction.casefold().replace("ё", "е")
    if _preserves_framing(low):
        return None
    if (any(k in low for k in ("сверхкрупн", "экстремально крупн", "extreme close-up", "extreme close up"))
            or re.search(r"\becu\b", low)):
        return "extreme_close"
    # Extreme wide/long must beat the generic «общий / wide» branch.
    if any(k in low for k in ("сверхдальн", "extreme long", "extreme wide", "extreme-wide", "extreme-long")):
        return "extreme_wide"
    if (any(k in low for k in ("средне-крупн", "среднекрупн", "по грудь", "medium close-up", "medium close up"))
            or re.search(r"\bmcu\b", low)):
        return "medium_close"
    if any(k in low for k in ("ковбойск", "medium-long", "medium long", "mid-thigh")):
        return "cowboy"
    if (any(k in low for k in ("общи", "дальний план", "wide shot", "long shot", "full body", "full-body", "установочн"))
            or re.search(r"\bws\b", low)):
        return "wide"
    if (any(k in low for k in ("средний план", "план на средний", "по пояс", "medium shot", "medium framing"))
            or re.search(r"\bms\b", low)):
        return "medium"
    if (any(k in low for k in ("крупный план", "план на крупный", "крупным планом", "портретный план", "close-up", "close up", "closeup"))
            or re.search(r"\b(?:cu|mcu|ecu)\b", low)):
        return "close"
    return None


# Catalog shot-size ids → framing target used by validators / enforce.
_SHOT_SIZE_TARGET_BY_SOURCE = {
    "3.1": "extreme_wide",
    "3.2": "wide",
    "3.4": "wide",
    "3.5": "wide",
    "3.6": "cowboy",
    "3.7": "medium",
    "3.8": "medium_close",
    "3.9": "close",
    "3.10": "extreme_close",
}

_SHOT_SIZE_RU = {
    "extreme_wide": "сверхдальний",
    "wide": "общий",
    "cowboy": "ковбойский",
    "medium": "средний",
    "medium_close": "средне-крупный",
    "close": "крупный",
    "extreme_close": "сверхкрупный",
}

def use_reference_images_for_edit(instruction: str, techniques: list[str]) -> bool:
    """Technical edits use source text; images can cause the model to rewrite action."""
    technical = any(item and item != "auto" for item in techniques) or _framing_target(instruction) is not None
    technical = technical or _lighting_change_requested(instruction.casefold())
    if not technical:
        return True
    low = instruction.casefold()
    appearance = re.compile(
        r"(?:лиц|внешност|волос|глаз|одежд|костюм|куртк|футболк|тату|сходств|"
        r"face|appearance|hair|eyes|clothes|outfit|tattoo|identity|reference|референс)"
    )
    change = re.compile(r"(?:измен|поменя|замен|исправ|поправ|сдела|подгон|change|replace|fix|make|match)")
    preserve = re.compile(r"(?:сохрани|не меняй|оставь|preserve|keep)")
    for match in appearance.finditer(low):
        before = low[max(0, match.start() - 30):match.start()]
        if preserve.search(before):
            continue
        if change.search(low[max(0, match.start() - 45):match.end() + 45]):
            return True
    return False


def _preserves_framing(low: str) -> bool:
    preservation_phrases = (
        "сохрани общий план", "общий план не меняй", "общий план не изменяй",
        "сохрани крупность", "оставь крупность", "не меняй крупность", "не изменяй крупность",
        "keep the wide shot", "keep wide", "preserve the framing", "keep the framing",
        "retain the framing", "keep current framing", "same framing",
    )
    change_phrases = (
        "поменяй план", "поменя план", "измени план", "сделай план", "поменяй крупность",
        "измени крупность", "сделай крупнее", "сделай шире", "переведи план", "перекадрируй",
        "change the framing", "change framing", "change shot size", "switch to wide",
        "change to wide", "make it wide", "make it a wide", "reframe", "go wide", "widen the shot",
    )
    return any(phrase in low for phrase in preservation_phrases) and not any(
        phrase in low for phrase in change_phrases
    )


def _shot_scoped_edit(instruction: str) -> bool:
    low = instruction.casefold().replace("ё", "е")
    return bool(re.search(
        r"(?:\bshot\s*\d+\b|\bкадр\s*\d+\b|\b[1-9]-й\s+кадр\b|\bперв(?:ый|ого)\s+кадр\b|\bвтор(?:ой|ого)\s+кадр\b)",
        low,
    ))


def shot_size_edit_directive(instruction: str) -> str:
    """Extra user-message mandate when the edit asks to change framing / крупность."""
    low = instruction.casefold()
    if not any(k in low for k in _SHOT_SIZE_HINT):
        return ""
    target = _framing_target(instruction)
    if target is None and _preserves_framing(low):
        return ""
    scope = ("Примени крупность только к явно названным кадрам; остальные кадры не меняй."
             if _shot_scoped_edit(instruction) else
             "Если пользователь не назвал отдельные кадры, примени эту крупность ко ВСЕМ кадрам: один и тот же план от начала до конца.")
    wide = (
        "Для сверхдальнего плана: субъект — мелкая фигура в огромном читаемом пространстве; "
        "камера далеко, без наезда к лицу/глазам и без финального close-up. "
        "В summary и каждом [Shot N] явно пиши extreme long shot / extreme wide."
        if target == "extreme_wide" else
        "Для общего плана: в каждом [Shot N] покажи героя полностью, с запасом по краям, и оставь окружение читаемым. "
        "Камера всё время остаётся достаточно далеко; она не пересекает лицо, не приближается к глазам/татуировкам "
        "и не заканчивает крупным планом. Перепиши summary и весь detailed_description так, чтобы движение, фокус, "
        "оптика и композиция не тянули кадр обратно в портрет."
        if target == "wide" else ""
    )
    return (
        "\n\nКРУПНОСТЬ — ОБЯЗАТЕЛЬНАЯ ПРАВКА ПО ЗАПРОСУ ПОЛЬЗОВАТЕЛЯ:\n"
        f"{scope}\n"
        "В схеме промпта есть summary и detailed_description, отдельного CAMERA / SHOT поля нет — не выдумывай его. "
        "Перепиши крупность в summary, в первой фразе КАЖДОГО нужного [Shot N] и во всех зависимых от неё "
        "описаниях дистанции, оптики, кадрирования, фокуса и движения камеры. Не оставляй старую крупность "
        "в середине кадра и не создавай переход между крупностями, если пользователь этого не просил. "
        f"{wide}\n"
        "Проверь перед ответом: число кадров сохранено; каждый кадр соответствует запрошенному плану; "
        "ни одно действие камеры или фокусный якорь не противоречит ему. Верни тот же набор полей и полный промпт."
    )


def selected_shot_size_instruction(instruction: str, technique: str | list[str] | None) -> str:
    """Apply the selected shot size to the whole clip unless shots are specified."""
    from ..workflow.cinematography import selected_cinematic_techniques

    if _shot_scoped_edit(instruction):
        return instruction
    for item in selected_cinematic_techniques(technique):
        if target := _SHOT_SIZE_TARGET_BY_SOURCE.get(item["source_id"]):
            return f"поменяй план на {_SHOT_SIZE_RU[target]}"
    return instruction


def selected_shot_size_target(technique: str | list[str] | None) -> str | None:
    """Framing target implied by the selected catalog shot-size technique, if any."""
    from ..workflow.cinematography import selected_cinematic_techniques

    for item in selected_cinematic_techniques(technique):
        if target := _SHOT_SIZE_TARGET_BY_SOURCE.get(item["source_id"]):
            return target
    return None


def _subject_action_passages(source: str) -> str:
    match = re.search(r"(?ims)^\s*detailed_description\s*:\s*(.*?)(?=^\s*overall_soundscape\s*:|\Z)", source)
    if not match:
        return ""
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z<\[])", match.group(1))
    actor = re.compile(r"<Subject\s+\d+>|\b(?:he|she|his|her|they|their)\b", re.I)
    action = re.compile(
        r"\b(?:head|face|eyes?|eyelids?|gaze|lips?|mouth|brows?|weight|body|hands?|arms?|"
        r"turn|jerk|blink|shift|smile|laugh|react|walk|step|move|breath)\w*\b", re.I
    )
    selected = []
    for sentence in sentences:
        clean = re.sub(r"^\s*\[Shot\s+\d+\]\s*", "", sentence).strip()
        if re.match(r"(?:The camera|As the camera|Camera)\b", clean, re.I):
            continue
        if actor.search(clean) and action.search(clean):
            selected.append(clean)
    return "\n".join(selected)[:2600]


def subject_action_edit_directive(source: str, instruction: str, techniques: list[str]) -> str:
    if use_reference_images_for_edit(instruction, techniques):
        return ""
    actions = _subject_action_passages(source)
    if not actions:
        return ""
    return (
        "\n\nДЕЙСТВИЕ ГЕРОЯ — СОХРАНИТЬ: ниже исходные фрагменты с действиями персонажа. "
        "Сохрани их последовательность, резкость, паузы и реакции. Меняй в них только слова, "
        "которые противоречат выбранным камере, крупности или свету. Статичная камера не делает героя неподвижным.\n"
        f"{actions}"
    )


def subject_action_edit_issues(source: str, instruction: str, techniques: list[str], candidate: str) -> list[str]:
    if use_reference_images_for_edit(instruction, techniques):
        return []
    if re.search(r"(?:убери|удали|замени|не должен|remove|replace|stop)\W{0,25}(?:движение головы|поворот головы|head)",
                 instruction, re.I):
        return []
    actions = _subject_action_passages(source).casefold()
    result = re.sub(r"(?im)\bNEGATIVE\s*:[^\n]*", "", candidate.casefold())
    issues: list[str] = []
    intense = r"(?:staccato|jerks?|snaps?|abrupt|sharp|sudden|two distinct|two beats)"
    head_motion = r"(?:head|turn|movement|face)"
    intense_action = (rf"\b{intense}\b[^.\n]{{0,70}}\b{head_motion}\b|"
                      rf"\b{head_motion}\b[^.\n]{{0,70}}\b{intense}\b")
    if re.search(r"\b(?:staccato|jerks?|snaps?)\b", actions) and not re.search(intense_action, result):
        issues.append("Сохрани резкий, прерывистый характер движения персонажа из исходного промпта.")
    if re.search(r"\b(?:head movement|head turn|turns? (?:his|her|their) (?:head|face))\b", actions) and not re.search(
        r"\b(?:head (?:turn(?:s|ed|ing)?|rotat(?:es|ed|ing)?|jerk(?:s|ed)?|snap(?:s|ped)?)|turn(?:s|ing)? (?:his|her|their) (?:head|face)|turning motion)\b", result
    ):
        issues.append("Сохрани поворот головы персонажа как действие, даже при статичной камере.")
    return issues


def shot_size_edit_issues(source: str, instruction: str, candidate: str) -> list[str]:
    """Reject a framing edit that leaves explicit, contradictory shot sizes in the prompt."""
    target = _framing_target(instruction)
    if target is None or _shot_scoped_edit(instruction):
        return []

    def section(text: str, name: str, next_name: str) -> str:
        match = re.search(rf"(?ims)^\s*{re.escape(name)}\s*:\s*(.*?)(?=^\s*{re.escape(next_name)}\s*:|\Z)", text)
        return match.group(1).strip() if match else ""

    source_detail = section(source, "detailed_description", "overall_soundscape")
    detail = section(candidate, "detailed_description", "overall_soundscape")
    summary = section(candidate, "summary", "retention_analysis").casefold()
    source_shots = re.findall(r"(?m)^\s*\[Shot\s+\d+\]", source_detail)
    shots = re.split(r"(?m)^\s*\[Shot\s+\d+\]\s*", detail)[1:]
    issues: list[str] = []
    # Compose has no source prompt — only require a non-empty shot list; do not compare counts to [].
    if not detail or not shots:
        return ["Сохрани секцию detailed_description с хотя бы одним [Shot N]."]
    if source_shots and len(shots) != len(source_shots):
        return ["Сохрани число кадров и секцию detailed_description."]

    def affirmative_match(pattern: re.Pattern[str], text: str) -> bool:
        for match in pattern.finditer(text):
            prefix = re.split(r"[.;\n]", text[max(0, match.start() - 70):match.start()])[-1]
            if re.search(r"\b(?:no|without|never|avoid|not|rather than|instead of)\b[^.;\n]{0,55}$",
                         prefix, re.I):
                continue
            return True
        return False

    if target in {"wide", "extreme_wide"}:
        if target == "extreme_wide":
            broad = re.compile(
                r"\b(?:extreme\s+long\s+shot|extreme\s+wide(?:\s+shot)?|tiny figure|vast (?:environment|landscape|space)|"
                r"environment[- ]dominant)\b",
                re.I,
            )
            label = "сверхдальнего плана"
        else:
            broad = re.compile(
                r"\b(?:(?<!extreme\s)wide(?:\s*/\s*long)? shot|(?<!extreme\s)long shot|full[- ]body|full[- ]length|"
                r"environment[- ]dominant|full figure|establishing shot)\b",
                re.I,
            )
            label = "общего плана"
        full_figure = re.compile(
            r"\b(?:full[- ]body|full[- ]length|head[- ]to[- ]toe|whole figure|entire figure|full silhouette|"
            r"entire subject|whole subject|tiny figure)\b",
            re.I,
        )
        if target == "extreme_wide":
            incompatible = re.compile(
                r"\b(?:extreme close[- ]up|(?<!extreme\s)(?:wide|long) shot|close[- ]up|medium close[- ]up|medium shot|"
                r"head[- ]and[- ]shoulders|chest[- ]to[- ]head|waist[- ]up|face filling the frame|tight portrait|"
                r"of the eyes|on the eyes|(?<![/\w])eye details?|(?<![/\w])iris|(?<![/\w])pupil)\b",
                re.I,
            )
        else:
            incompatible = re.compile(
                r"\b(?:extreme\s+long\s+shot|extreme\s+wide(?:\s+shot)?|tiny figure|extreme close[- ]up|close[- ]up|"
                r"medium close[- ]up|medium shot|head[- ]and[- ]shoulders|chest[- ]to[- ]head|waist[- ]up|"
                r"face filling the frame|face fills the frame|tight portrait|of the eyes|on the eyes|"
                r"(?<![/\w])eye details?|(?<![/\w])iris|(?<![/\w])pupil)\b",
                re.I,
            )
        camera_detail = re.compile(
            r"\b(?:camera|lens|focus|framing|composition|view|shot)\b[^.\n]{0,120}\b(?:across (?:(?:the )?(?:his|her|subject's) )?face|"
            r"push(?:es|ing)?[- ]in (?:to|toward|towards) (?:the |his |her )?(?:face|eyes|eye|tattoo)|"
            r"zoom(?:s|ing)?[- ]in (?:to|on) (?:the |his |her )?(?:face|eyes|eye|tattoo)|"
            r"focus(?:es|ed|ing)? (?:on|to) (?:the |his |her )?(?:eyes|eye|face|neck tattoo|tattoo)|"
            r"focused on (?:the |his |her )?(?:eyes|eye|face|neck tattoo|tattoo))\b",
            re.I,
        )
        first_summary_sentence = re.split(r"[.!?]", summary, maxsplit=1)[0]
        first_wide = broad.search(first_summary_sentence)
        before_wide = first_summary_sentence[:first_wide.start()] if first_wide else first_summary_sentence
        if not first_wide or affirmative_match(incompatible, before_wide) or affirmative_match(camera_detail, before_wide):
            issues.append(f"Summary не начинает клип с {label}.")
        if affirmative_match(incompatible, summary) or affirmative_match(camera_detail, summary):
            issues.append("В summary остался переход или фокус, который тянет кадр к крупности.")
        for index, shot in enumerate(shots, 1):
            positive_shot = re.split(r"(?i)\bNEGATIVE\s*:", shot)[0]
            lead = positive_shot[:350]
            if not broad.search(lead):
                issues.append(
                    f"Кадр {index} не начинается с явного "
                    f"{'сверхдальнего' if target == 'extreme_wide' else 'общего'} плана."
                )
            if target == "wide" and "<Subject " in source and not full_figure.search(lead):
                issues.append(f"В кадре {index} покажи героя целиком, с запасом по краям.")
            if target == "extreme_wide" and not re.search(r"\b(?:tiny figure|vast|extreme\s+(?:long|wide)|distant)\b", lead, re.I):
                issues.append(f"В кадре {index} оставь героя мелкой фигурой в большом пространстве.")
            if affirmative_match(incompatible, positive_shot):
                issues.append(f"В кадре {index} осталась несовместимая крупность.")
            if affirmative_match(camera_detail, positive_shot):
                issues.append(f"Камера или фокус в кадре {index} снова тянут композицию к лицу/детали.")
    else:
        sizes = {
            "wide": r"\b(?:wide(?:\s*/\s*long)? (?:shot|composition|framing|frame|view)|long shot|full[- ]body|full[- ]length|head[- ]to[- ]toe)\b",
            "extreme_wide": r"\b(?:extreme\s+long\s+shot|extreme\s+wide(?:\s+shot)?|tiny figure)\b",
            "cowboy": r"\b(?:cowboy(?: shot)?|medium[- ]long shot|mid[- ]thigh|above[- ]the[- ]knees)\b",
            "medium": r"\b(?:medium shot|mid[- ]shot|waist[- ]up)\b",
            "medium_close": r"\b(?:medium[- ]close[- ]up|chest[- ]up|head[- ]and[- ]shoulders)\b",
            "close": r"(?<!medium[ -])(?<!extreme[ -])\b(?:close[- ]up|tight portrait|face[- ]filling[- ]the[- ]frame)\b",
            "extreme_close": r"\b(?:extreme[- ]close[- ]up|macro shot|macro detail)\b",
        }
        expected = re.compile(sizes[target], re.I)
        incompatible = re.compile("|".join(pattern for size, pattern in sizes.items() if size != target), re.I)
        first_summary_sentence = re.split(r"[.!?]", summary, maxsplit=1)[0]
        first_size = expected.search(first_summary_sentence)
        before_size = first_summary_sentence[:first_size.start()] if first_size else first_summary_sentence
        if not affirmative_match(expected, first_summary_sentence) or affirmative_match(incompatible, before_size):
            issues.append("Summary не начинает клип с выбранной крупности.")
        if affirmative_match(incompatible, summary):
            issues.append("В summary осталась несовместимая крупность.")
        for index, shot in enumerate(shots, 1):
            positive_shot = re.split(r"(?i)\bNEGATIVE\s*:", shot)[0]
            if not affirmative_match(expected, positive_shot[:350]):
                issues.append(f"Кадр {index} не начинается с выбранной крупности.")
            if affirmative_match(incompatible, positive_shot):
                issues.append(f"В кадре {index} осталась несовместимая крупность.")
    return issues


def lighting_edit_directive(instruction: str) -> str:
    low = instruction.casefold().replace("ё", "е")
    if not _lighting_change_requested(low):
        return ""
    return (
        "\n\nLIGHTING EDIT: Apply the requested lighting change consistently to the summary and every [Shot N] "
        "unless the user names specific shots. Update any dependent lighting descriptions in subject_definitions, "
        "detailed_description, and visual_style; place visual_style after detailed_description and before "
        "overall_soundscape; remove lighting statements that contradict the requested result. "
        "Preserve camera position, movement, framing, subject action, and identity unless the user asks to change them."
    )


def _lighting_change_requested(low: str) -> bool:
    light_terms = ("свет", "освещ", "lighting", "light", "illumination", "shadow")
    change_verbs = (
        "измени", "изменить", "поменя", "сделай", "сделать", "замени", "заменить",
        "поставь", "усиль", "освети", "затемни", "смягчи", "убери", "change", "make",
        "replace", "set", "brighten", "darken", "soften", "harden", "relight",
    )
    if not any(term in low for term in light_terms):
        return False
    if any(phrase in low for phrase in ("сохрани свет", "свет не меняй", "не меняй свет",
                                         "сохрани освещение", "keep the light", "don't change the light",
                                         "preserve the lighting", "keep the lighting")):
        return False
    for term in light_terms:
        start = 0
        while (index := low.find(term, start)) >= 0:
            nearby = low[max(0, index - 45):index + len(term) + 45]
            if any(verb in nearby for verb in change_verbs):
                return True
            start = index + len(term)
    return False


def lighting_edit_issues(instruction: str, candidate: str) -> list[str]:
    """Check explicit lighting qualities/directions requested by the user."""
    low = instruction.casefold().replace("ё", "е")
    if not _lighting_change_requested(low):
        return []
    text = candidate.casefold()
    groups = (
        (("жестк", "hard light", "hard key", "harsh light", "harsh key"), ("hard", "harsh")),
        (("мягк", "soft light", "soft lighting", "diffused", "diffuse"), ("soft", "diffuse")),
        (("боков", "side light", "side lighting", "sidelight"), ("side",)),
        (("справа", "right of camera", "camera-right", "from the right"), ("right",)),
        (("слева", "left of camera", "camera-left", "from the left"), ("left",)),
        (("сверху", "верхн", "overhead", "top light", "from above"), ("overhead", "above", "top")),
        (("снизу", "нижн", "underlight", "from below", "below"), ("below", "under")),
        (("глубок", "deep shadow", "strong shadow", "high contrast"), ("shadow", "contrast")),
        (("тепл", "warm light", "warm lighting"), ("warm",)),
        (("холодн", "cool light", "cool lighting"), ("cool",)),
    )
    missing = []
    requested_groups = []
    for requested, alternatives in groups:
        if any(term in low for term in requested):
            requested_groups.append((requested[0], alternatives))
            if not any(term in text for term in alternatives):
                missing.append(requested[0])
    issues = (["В освещении не отражены заданные характеристики: " + ", ".join(missing) + "."]
              if missing else [])
    if not re.search(r"(?im)^\s*detailed_description\s*:", candidate):
        return issues
    visual_match = re.search(r"(?ims)^\s*visual_style\s*:\s*(.*?)(?=^\s*[a-z_]+\s*:|\Z)", candidate)
    visual = visual_match.group(1).casefold() if visual_match else ""
    if not visual:
        issues.append("Добавь visual_style с запрошенной схемой света.")
    else:
        missing_visual = [name for name, alternatives in requested_groups
                          if not any(term in visual for term in alternatives)]
        if missing_visual:
            issues.append("В visual_style не отражены: " + ", ".join(missing_visual) + ".")
    positive = re.sub(r"(?im)^\s*NEGATIVE\s*:[^\n]*", "", candidate)
    if any(term in low for term in ("жестк", "hard light", "hard key", "harsh light", "harsh key")):
        if re.search(r"\b(?:soft|diffus\w*)\b[^.\n]{0,50}\b(?:light|lighting|key|illumination)\b", positive, re.I):
            issues.append("Убери прежний мягкий свет из всех разделов промпта.")
    if any(term in low for term in ("мягк", "soft light", "soft lighting", "diffused", "diffuse")):
        if re.search(r"\b(?:hard|harsh)\b[^.\n]{0,50}\b(?:light|lighting|key|illumination)\b", positive, re.I):
            issues.append("Убери прежний жёсткий свет из всех разделов промпта.")
    detail_match = re.search(r"(?ims)^\s*detailed_description\s*:\s*(.*?)(?=^\s*overall_soundscape\s*:|\Z)", candidate)
    shots = re.split(r"(?m)^\s*\[Shot\s+\d+\]", detail_match.group(1))[1:] if detail_match else []
    for index, shot in enumerate(shots, 1):
        missing_shot = [name for name, alternatives in requested_groups[:3]
                        if not any(term in shot.casefold() for term in alternatives)]
        if missing_shot:
            issues.append(f"В кадре {index} не отражён запрошенный свет: " + ", ".join(missing_shot) + ".")
    return issues


def camera_edit_directive(instruction: str) -> str:
    low = instruction.casefold().replace("ё", "е")
    if not re.search(r"\b(?:камер|ракурс|camera|lens)\w*", low):
        return ""
    if not any(term in low for term in ("постав", "поверн", "измен", "поменя", "перемест", "неподвиж", "статич",
                                       "position", "rotate", "turn", "move", "static", "fixed")):
        return ""
    return (
        "\n\nCAMERA EDIT: Apply the requested camera height, side, angle, orientation, and motion to the opening "
        "and end of every affected shot. Remove old camera paths and camera positions that conflict with the new "
        "request. A static camera never performs a lateral shift, pan, track, orbit, zoom, or other travel; "
        "the subject can still move. Keep the requested shot size and lighting coherent throughout."
    )


def camera_edit_issues(instruction: str, candidate: str) -> list[str]:
    """Check concrete camera position and movement requests against every shot."""
    low = instruction.casefold().replace("ё", "е")
    if not camera_edit_directive(instruction):
        return []
    detail_match = re.search(r"(?ims)^\s*detailed_description\s*:\s*(.*?)(?=^\s*overall_soundscape\s*:|\Z)", candidate)
    shots = re.split(r"(?m)^\s*\[Shot\s+\d+\]", detail_match.group(1))[1:] if detail_match else []
    if not shots:
        return ["Сохрани кадры и укажи новые параметры камеры в detailed_description."]
    issues = []
    static = bool(re.search(r"(?:камер\w*[^.!?]{0,50}(?:неподвиж|статич|зафиксир|без движен)|"
                            r"(?:неподвиж|статич|зафиксир)[^.!?]{0,35}камер\w*|"
                            r"(?:static|fixed|locked-off)[^.!?]{0,35}camera)", low))
    motion = re.compile(
        r"\b(?:camera|lens|rig)\b[^.\n]{0,110}\b(?:moves?|tracks?|travels?|dollies|orbits?|pans?|tilts?|"
        r"zooms?|shifts?|slides?|swings?|rotates?|rolls?|cranes?|trucks?|"
        r"executes?[^.\n]{0,45}(?:shift|movement|track|pan|tilt|zoom)|"
        r"(?:rapid|slow|lateral|horizontal|vertical)[^.\n]{0,30}(?:shift|tracking|movement))\b", re.I,
    )
    angle = re.search(r"\b(\d+(?:[.,]\d+)?)\s*(?:градус\w*|degrees?|°)", low)
    right = bool(re.search(r"справа от геро|справа от персонаж|to the subject.s right|right of the subject", low))
    left = bool(re.search(r"слева от геро|слева от персонаж|to the subject.s left|left of the subject", low))
    aim_at_subject = bool(re.search(r"поверн\w*[^.!?]{0,35}к (?:нему|герою|персонажу)", low))
    heights = (("талии", ("waist height", "waist-level", "waist level")),
               ("глаз", ("eye level", "eye-level")),
               ("плеч", ("shoulder height", "shoulder-level")))
    for index, shot in enumerate(shots, 1):
        positive = re.sub(r"(?im)^\s*NEGATIVE\s*:[^\n]*", "", shot)
        lead = positive[:500].casefold()
        if static and motion.search(positive):
            issues.append(f"В кадре {index} камера должна оставаться неподвижной без прежнего проезда.")
        if static and re.search(r"\b(?:approaching|moving|travelling|tracking|shifting|pushing)\b[^.\n]{0,35}"
                                r"\b(?:camera|lens)\b", positive, re.I):
            issues.append(f"В кадре {index} убери упоминание приближающейся или движущейся камеры.")
        if angle and angle.group(1).replace(",", ".") not in lead:
            issues.append(f"В кадре {index} укажи запрошенный угол камеры {angle.group(1)}°.")
        if right and "right" not in lead:
            issues.append(f"В кадре {index} поставь камеру справа от героя.")
        if left and "left" not in lead:
            issues.append(f"В кадре {index} поставь камеру слева от героя.")
        if aim_at_subject and not re.search(r"\b(?:aimed|oriented|angled|pointed|facing)\b[^.\n]{0,35}"
                                         r"\b(?:toward|towards|at|him|subject)\b", lead):
            issues.append(f"В кадре {index} поверни камеру к герою, как запрошено.")
        for requested, alternatives in heights:
            if requested in low and not any(term in lead for term in alternatives):
                issues.append(f"В кадре {index} укажи запрошенную высоту камеры.")
    return issues


def prompt_completion_issues(candidate: str, finish_reason: str | None = None) -> list[str]:
    """Reject truncated prompts and section order that the H3 prompt contract cannot parse reliably."""
    issues = []
    if finish_reason == "length" or re.search(r"<(?:Audio|Picture|Video|Subject)\b[^>]*$", candidate):
        issues.append("Дополни промпт до конца: последний тег и все разделы должны быть завершены.")
    required = ("subject_definitions", "summary", "retention_analysis", "detailed_description",
                "overall_soundscape", "non_diegetic_music")
    positions = [re.search(rf"(?im)^\s*{name}\s*:", candidate) for name in required]
    if not all(positions) or [match.start() for match in positions if match] != sorted(
            match.start() for match in positions if match):
        issues.append("Сохрани все обязательные разделы промпта в исходном порядке.")
    visual = re.search(r"(?im)^\s*visual_style\s*:", candidate)
    detail = positions[3]
    sound = positions[4]
    if visual and detail and sound and not detail.start() < visual.start() < sound.start():
        issues.append("Размести visual_style после detailed_description и перед overall_soundscape.")
    return issues


def reference_tag_issues(refs: list[RefInfo] | None, candidate: str) -> list[str]:
    """Require every attached image/video/audio to appear as <Picture N> / <Video N> / <Audio N>."""
    if not refs:
        return []
    counts = _reference_counts(refs)
    tag_by_kind = {"image": "Picture", "video": "Video", "audio": "Audio"}
    issues: list[str] = []
    for kind, total in counts.items():
        if total == 0:
            continue
        tag = tag_by_kind[kind]
        found = {int(num) for num in re.findall(rf"<{tag}\s+(\d+)\s*>", candidate)}
        missing = [index for index in range(1, total + 1) if index not in found]
        if missing:
            labels = ", ".join(f"<{tag} {index}>" for index in missing)
            issues.append(f"В промпте обязательны метки референсов: {labels}.")
    return issues


def enforce_reference_tags(refs: list[RefInfo] | None, candidate: str) -> str:
    """Insert missing <Picture N>/<Video N>/<Audio N> labels so a compose/edit can still finish."""
    if not refs or not candidate.strip():
        return candidate
    counts = _reference_counts(refs)
    tag_by_kind = {"image": "Picture", "video": "Video", "audio": "Audio"}
    missing_tags: list[str] = []
    for kind, total in counts.items():
        if total == 0:
            continue
        tag = tag_by_kind[kind]
        found = {int(num) for num in re.findall(rf"<{tag}\s+(\d+)\s*>", candidate)}
        missing_tags.extend(f"<{tag} {index}>" for index in range(1, total + 1) if index not in found)
    if not missing_tags:
        return candidate
    bind = " ".join(missing_tags)
    if re.search(r"(?im)^\s*subject_definitions\s*:", candidate):
        return re.sub(
            r"(?im)(^\s*subject_definitions\s*:\s*)",
            rf"\1References in use: {bind}. ",
            candidate,
            count=1,
        )
    return f"subject_definitions:\nReferences in use: {bind}.\n\n{candidate}"


def _marker_present(marker: str, text: str) -> bool:
    """True if marker appears as itself — not only as part of a longer opposing phrase."""
    if not marker:
        return False
    m = marker.casefold()
    masked = text
    # Mask longer/conflicting forms so short markers cannot false-pass.
    masks_by_marker = {
        "close-up": (r"extreme\s+close[- ]ups?", r"medium\s+close[- ]ups?"),
        "close up": (r"extreme\s+close[- ]ups?", r"medium\s+close[- ]ups?"),
        "long shot": (r"extreme\s+long\s+shots?",),
        "wide shot": (r"extreme\s+wide(?:\s+shots?)?",),
        "wide": (r"extreme\s+wides?", r"eyes?\s+wide"),
        "pan": (r"whip\s+pans?", r"swish\s+pans?"),
        "panning": (r"whip\s+pans?", r"swish\s+pans?"),
        "tilt": (r"whip\s+tilts?",),
        "tilting": (r"whip\s+tilts?",),
        "35mm": (r"135mm",),
        "symmetry": (r"asymmetry",),
        "anamorphic": (r"non-anamorphic",),
        "match cut": (r"(?:graphic|shape)\s+match\s+cuts?",),
        "noir": (r"neo[- ]?noir",),
        "soft": (r"softbox",),
        "hard": (r"hardship",),
        "static": (r"static (?:expression|pose|ink|tattoo)",),
        "orbit": (r"exorbitant",),
        "arc": (r"architecture|arcade|archive",),
        "dolly": (r"dolly\s+zoom",),
        "zoom": (r"dolly\s+zoom",),
        "iris": (r"iridescent",),
    }
    for pattern in masks_by_marker.get(m, ()):
        masked = re.sub(pattern, lambda mo: " " * len(mo.group(0)), masked, flags=re.I)
    if len(m) <= 4:
        return bool(re.search(rf"(?<![a-z0-9]){re.escape(m)}s?(?![a-z0-9])", masked))
    return m in masked


# When technique A is selected, these phrases must not remain as affirmative description.
_TECHNIQUE_ANTONYM_PHRASES: dict[str, tuple[str, ...]] = {
    "2.2": ("dolly", "tracking", "orbit", "handheld", "gimbal", "crane", "whip pan", "pan", "tilt", "zoom"),
    "2.8": ("whip pan", "whip tilt"),
    "2.9": ("whip tilt", "whip pan"),
    "2.20": ("slow pan", "gentle pan", "locked-off", "static camera"),
    "3.1": ("close-up", "extreme close-up", "medium close-up", "medium shot", "wide shot",
            "on the eyes", "of the eyes", "iris", "pupil"),
    "3.4": ("extreme long shot", "extreme wide", "tiny figure", "extreme close-up",
            "close-up on the eyes", "of the eyes"),
    "3.5": ("extreme long shot", "extreme wide", "tiny figure", "extreme close-up",
            "close-up on the eyes", "of the eyes"),
    "3.6": ("extreme long shot", "extreme wide", "extreme close-up", "close-up on the eyes"),
    "3.7": ("extreme long shot", "extreme wide", "extreme close-up", "close-up on the eyes"),
    "3.8": ("extreme long shot", "extreme wide", "full-body", "extreme close-up", "tiny figure"),
    "3.9": ("extreme close-up", "extreme long shot", "extreme wide", "medium close-up", "tiny figure"),
    "3.10": ("extreme long shot", "wide shot", "full-body", "tiny figure", "medium shot"),
    "4.1": ("worm's-eye", "ground level", "low angle", "high angle", "dutch"),
    "4.2": ("eye level", "eye-level", "high angle", "worm's-eye", "dutch"),
    "4.3": ("eye level", "eye-level", "low angle", "worm's-eye", "dutch"),
    "4.4": ("eye level", "eye-level", "low angle", "high angle", "worm's-eye"),
    "4.5": ("eye level", "eye-level"),
    "7.10": ("soft light", "soft key", "diffused light"),
    "7.11": ("hard light", "hard key", "harsh light"),
    "7.8": ("low-key", "low key", "deep shadow"),
    "7.9": ("high-key", "high key"),
    "8.1": ("deep focus", "deep depth of field"),
    "8.2": ("shallow focus", "shallow depth of field", "shallow dof"),
    "14.1": ("neo-noir", "neo noir"),
    "14.2": ("film noir",),
}


def _affirmative_antonym_hits(source_id: str, candidate: str) -> list[str]:
    """Return antonym phrases that appear as affirmative description (not bans)."""
    positive = re.sub(r"(?ims)\bNEGATIVE\s*:[^\n]*", "", candidate).casefold()
    hits: list[str] = []
    for phrase in _TECHNIQUE_ANTONYM_PHRASES.get(source_id, ()):
        p = phrase.strip().casefold()
        if not p or not _marker_present(p, positive):
            continue
        # Locate an unmasked occurrence and reject local negation ("no/without …").
        for match in re.finditer(re.escape(p), positive):
            span = positive[max(0, match.start() - 12):match.end() + 12]
            if not _marker_present(p, span) and p not in span.replace(" ", ""):
                continue
            prefix = re.split(r"[.;\n]", positive[max(0, match.start() - 70):match.start()])[-1]
            if re.search(
                r"\b(?:no|without|never|avoid|not|rather than|instead of)\b[^.;\n]{0,55}$",
                prefix,
                re.I,
            ):
                continue
            hits.append(p)
            break
    return hits


def enforce_shot_size_framing(technique: str | list[str] | None, candidate: str) -> str:
    """Rewrite summary/shots so a selected shot-size technique actually owns the frame (not a tagline)."""
    target = selected_shot_size_target(technique)
    if not target or not candidate.strip():
        return candidate

    copy = {
        "extreme_wide": {
            "phrase": "extreme long shot / extreme wide",
            "summary": (
                "An extreme long shot / extreme wide holds throughout: the subject stays a tiny figure in a vast "
                "readable environment, with no approach toward the face or eyes."
            ),
            "shot": (
                "An extreme long shot / extreme wide keeps the subject small in a vast environment; the camera stays "
                "far back so the full figure is distant and facial features stay unreadable."
            ),
            "negative": (
                "no close-up, no extreme close-up, no medium shot, no push-in or zoom to the face or eyes, "
                "no isolated eye or iris detail filling the frame"
            ),
            "replacements": (
                (r"\bextreme\s+close[- ]ups?\b", "extreme long shot"),
                (r"\bmedium\s+close[- ]ups?\b", "extreme long shot"),
                (r"(?<!extreme\s)\bclose[- ]ups?\b", "extreme long shot"),
                (r"\bmedium shots?\b", "extreme long shot"),
                (r"\btight (?:shots?|portraits?)\b", "extreme long shot"),
                (r"\bhead[- ]and[- ]shoulders\b", "tiny distant figure"),
                (r"\bchest[- ]ups?\b", "tiny distant figure"),
                (r"\b(?:focus(?:es|ed|ing)?|sharp) on (?:the |his |her )?(?:eyes?|eye|face|iris|pupil)\b",
                 "holds the distant figure in the vast environment"),
                (r"\b(?:push(?:es|ing)?[- ]in|zoom(?:s|ing)?[- ]in) (?:to|toward|towards|on) (?:the |his |her )?"
                 r"(?:face|eyes?|eye|tattoo)\b",
                 "remains far back without approaching the face"),
                (r"\bon the eyes\b", "as a tiny figure in the wide environment"),
                (r"\bof the eyes\b", "of the distant figure in the landscape"),
                (r"\beyes with[^.!\n]*", "distant figure in the vast space"),
            ),
        },
        "wide": {
            "phrase": "wide shot / long shot",
            "summary": (
                "A wide shot / long shot holds throughout: the full body stays readable with environment around it, "
                "never an extreme-long tiny-figure vista and never a facial close-up."
            ),
            "shot": (
                "A wide shot / long shot frames the full body with readable environment and keeps distance from the face."
            ),
            "negative": (
                "no extreme long shot, no extreme wide, no tiny figure, no close-up, no extreme close-up, "
                "no medium close-up, no push-in to the face or eyes"
            ),
            "replacements": (
                (r"\bextreme\s+long\s+shots?\b", "wide shot"),
                (r"\bextreme\s+wides?(?:\s+shots?)?\b", "wide shot"),
                (r"\btiny figures?\b", "full figure"),
                (r"\bextreme\s+close[- ]ups?\b", "wide shot"),
                (r"\bmedium\s+close[- ]ups?\b", "wide shot"),
                (r"(?<!extreme\s)\bclose[- ]ups?\b", "wide shot"),
                (r"\b(?:focus(?:es|ed|ing)?|sharp) on (?:the |his |her )?(?:eyes?|eye|face)\b",
                 "keeps the full figure readable in the environment"),
                (r"\b(?:push(?:es|ing)?[- ]in|zoom(?:s|ing)?[- ]in) (?:to|toward|towards|on) (?:the |his |her )?"
                 r"(?:face|eyes?|eye)\b",
                 "tracks while holding the wide distance"),
                (r"\bon the eyes\b", "in the environment"),
                (r"\bof the eyes\b", "of the full figure"),
            ),
        },
        "medium_close": {
            "phrase": "medium close-up",
            "summary": (
                "A medium close-up holds throughout: chest/shoulders and face, "
                "never a full-body wide and never an extreme close-up."
            ),
            "shot": "A medium close-up chest-up frames the face and shoulders.",
            "negative": "no extreme long shot, no extreme wide, no wide shot, no full-body framing, no extreme close-up",
            "replacements": (
                (r"\bextreme\s+long\s+shots?\b", "medium close-up"),
                (r"\bextreme\s+wides?(?:\s+shots?)?\b", "medium close-up"),
                (r"\bextreme\s+close[- ]ups?\b", "medium close-up"),
                (r"(?<!medium\s)\bclose[- ]ups?\b", "medium close-up"),
                (r"\bwide shots?\b", "medium close-up"),
                (r"\bfull[- ]body\b", "chest-up"),
                (r"\btiny figures?\b", "chest-up figure"),
            ),
        },
        "close": {
            "phrase": "close-up",
            "summary": "A close-up holds throughout on the face — not an extreme iris detail and not a wide environment view.",
            "shot": "A close-up frames the face tightly while keeping natural facial proportions.",
            "negative": "no extreme close-up, no extreme long shot, no extreme wide, no wide shot, no full-body framing",
            "replacements": (
                (r"\bextreme\s+close[- ]ups?\b", "close-up"),
                (r"\bmedium\s+close[- ]ups?\b", "close-up"),
                (r"\bextreme\s+long\s+shots?\b", "close-up"),
                (r"\bextreme\s+wides?(?:\s+shots?)?\b", "close-up"),
                (r"\bwide shots?\b", "close-up"),
                (r"\bfull[- ]body\b", "face"),
                (r"\bof the (?:eyes|iris|pupil)s?\b", "of the face"),
                (r"\bon the eyes\b", "on the face"),
            ),
        },
        "extreme_close": {
            "phrase": "extreme close-up",
            "summary": "An extreme close-up holds throughout on a small facial detail.",
            "shot": "An extreme close-up isolates a small facial detail.",
            "negative": "no extreme long shot, no wide shot, no full-body framing, no medium shot",
            "replacements": (
                (r"\bextreme\s+long\s+shots?\b", "extreme close-up"),
                (r"\bextreme\s+wides?(?:\s+shots?)?\b", "extreme close-up"),
                (r"\bwide shots?\b", "extreme close-up"),
                (r"\bmedium shots?\b", "extreme close-up"),
                (r"(?<!extreme\s)\bclose[- ]ups?\b", "extreme close-up"),
            ),
        },
        "medium": {
            "phrase": "medium shot",
            "summary": "A medium shot holds throughout, usually waist-up.",
            "shot": "A medium shot / waist-up frames the subject.",
            "negative": "no extreme long shot, no extreme close-up, no eye-only framing",
            "replacements": (
                (r"\bextreme\s+long\s+shots?\b", "medium shot"),
                (r"\bextreme\s+wides?(?:\s+shots?)?\b", "medium shot"),
                (r"\bextreme\s+close[- ]ups?\b", "medium shot"),
                (r"\bmedium\s+close[- ]ups?\b", "medium shot"),
                (r"(?<!medium\s)\bclose[- ]ups?\b", "medium shot"),
                (r"\bon the eyes\b", "waist-up"),
                (r"\bof the eyes\b", "of the subject"),
            ),
        },
        "cowboy": {
            "phrase": "cowboy shot",
            "summary": "A cowboy / medium-long shot holds throughout, mid-thigh up.",
            "shot": "A cowboy shot / medium-long frames from mid-thigh up.",
            "negative": "no extreme long shot, no extreme close-up",
            "replacements": (
                (r"\bextreme\s+long\s+shots?\b", "cowboy shot"),
                (r"\bextreme\s+wides?(?:\s+shots?)?\b", "cowboy shot"),
                (r"\bextreme\s+close[- ]ups?\b", "cowboy shot"),
                (r"(?<!extreme\s)\bclose[- ]ups?\b", "cowboy shot"),
            ),
        },
    }
    spec = copy.get(target)
    if not spec:
        return candidate

    text = candidate
    for pattern, repl in spec["replacements"]:
        text = re.sub(pattern, repl, text, flags=re.I)

    # Force summary to lead with the selected size.
    summary_match = re.search(
        r"(?ims)(^\s*summary\s*:\s*)(.*?)(?=^\s*retention_analysis\s*:|\Z)",
        text,
    )
    if summary_match:
        text = (
            text[:summary_match.start()]
            + summary_match.group(1)
            + spec["summary"]
            + "\n\n"
            + text[summary_match.end():]
        )
    else:
        text = f"summary:\n{spec['summary']}\n\n{text}"

    detail_match = re.search(
        r"(?ims)(^\s*detailed_description\s*:\s*)(.*?)(?=^\s*(?:visual_style|overall_soundscape)\s*:|\Z)",
        text,
    )
    if detail_match:
        head, body = detail_match.group(1), detail_match.group(2)
        shots = re.split(r"(?m)(^\s*\[Shot\s+\d+\]\s*)", body)
        rebuilt: list[str] = []
        i = 0
        while i < len(shots):
            part = shots[i]
            if re.match(r"(?m)^\s*\[Shot\s+\d+\]\s*", part) and i + 1 < len(shots):
                rebuilt.append(part + _rebuild_shot_body(shots[i + 1], spec))
                i += 2
            else:
                if part.strip() and not re.match(r"(?m)^\s*\[Shot\s+\d+\]\s*", part):
                    if not rebuilt:
                        rebuilt.append(f"[Shot 1] {_rebuild_shot_body(part, spec)}")
                    else:
                        rebuilt.append(part)
                i += 1
        text = text[:detail_match.start()] + head + "".join(rebuilt) + text[detail_match.end():]

    if target in {"extreme_wide", "wide"}:
        text = _scrub_face_fill_for_distant_shot(text, target)
    return text


_FACE_FILL_SCRUB = (
    (r"\b(?:wet\s+)?(?:highlights?|catchlights?)\s+(?:in\s+)?(?:the\s+)?(?:eyes?|iris|cornea)\b",
     "no readable facial micro-detail at this distance"),
    (r"\b(?:iris|pupil|cornea|sclera)\b", "silhouette"),
    (r"\b(?:eyelids?|eyelashes?|brows?|eyebrows?)\b", "head shape"),
    (r"\b(?:blink(?:s|ing|ed)?|micro[- ](?:mimicry|expressions?|movements?))\b", "still distant posture"),
    (r"\beyes?\s+open\b", "figure facing outward"),
    (r"\bnatural\s+wet\s+highlights\b", "distant silhouette"),
    (r"\bextreme\s+close[- ]up\s+of\s+(?:the\s+)?(?:eye|eyes|iris)\b", "tiny distant figure"),
    (r"\bclose[- ]up\s+on\s+(?:the\s+)?(?:eye|eyes|face)\b", "tiny distant figure in the environment"),
    (r"\b(?:face|facial\s+features?)\s+remain(?:s|ing)?\s+consistent\b",
     "identity matches the references while facial micro-detail stays unreadable"),
)


def _scrub_face_fill_for_distant_shot(text: str, target: str) -> str:
    """Stop portrait-ref language from surviving into a distant shot prompt."""
    lock = (
        "FRAMING LOCK: reference photos define identity only — do not match their close crop or eye fill; "
        "the subject stays a tiny figure in a vast readable space."
        if target == "extreme_wide" else
        "FRAMING LOCK: reference photos define identity only — hold a full-body wide with environment; "
        "no face-fill or eye close-up from the refs."
    )
    # Soften subject_definitions face-locking that pulls H3 into portraits.
    subj = re.search(
        r"(?ims)(^\s*subject_definitions\s*:\s*)(.*?)(?=^\s*(?:summary|retention_analysis|detailed_description)\s*:|\Z)",
        text,
    )
    if subj:
        body = subj.group(2)
        body = re.sub(
            r"(?i)The face, hair, and outfit remain consistent throughout the shot\.?",
            "Identity matches the references; at this distance only silhouette and clothing read, not facial micro-detail.",
            body,
        )
        body = re.sub(
            r"(?i)(?:distinct )?facial structure[^.!\n]*[.!]?",
            "silhouette and clothing readable from afar. ",
            body,
        )
        if "FRAMING LOCK" not in body:
            body = body.rstrip() + f"\n{lock}\n"
        text = text[:subj.start()] + subj.group(1) + body + text[subj.end():]

    detail = re.search(
        r"(?ims)(^\s*detailed_description\s*:\s*)(.*?)(?=^\s*(?:visual_style|overall_soundscape)\s*:|\Z)",
        text,
    )
    if detail:
        body = detail.group(2)
        # Scrub only outside NEGATIVE clauses so bans like "no ... eyes" stay.
        parts = re.split(r"(?i)(\bNEGATIVE\s*:)", body)
        head = parts[0]
        for pattern, repl in _FACE_FILL_SCRUB:
            head = re.sub(pattern, repl, head, flags=re.I)
        if "FRAMING LOCK" not in head:
            # Keep [Shot N] as the section lead so shot-size validators still pass.
            if re.match(r"(?m)^\s*\[Shot\s+\d+\]", head):
                head = re.sub(
                    r"(?m)(^\s*\[Shot\s+\d+\]\s*)",
                    rf"\1{lock} ",
                    head,
                    count=1,
                )
            else:
                head = f"[Shot 1] {lock} " + head.lstrip()
        body = head + "".join(parts[1:])
        text = text[:detail.start()] + detail.group(1) + body + text[detail.end():]
    return text


def _rebuild_shot_body(shot_body: str, spec: dict[str, str]) -> str:
    """Always lead with the selected size; keep residual action text, force NEGATIVE."""
    body = re.sub(
        r"Apply [A-Z0-9][^.!\n]{0,80} as a mandatory parameter of this shot\.?\s*",
        "",
        shot_body,
        flags=re.I,
    )
    neg_match = re.search(r"(?is)\bNEGATIVE\s*:(.*)$", body)
    rest = body[:neg_match.start()].rstrip() if neg_match else body.rstrip()
    # Drop only a known shot-size lead (keep action / location text that follows).
    rest = re.sub(
        r"^(?:An?\s+)?"
        r"(?:extreme\s+long\s+shot|extreme\s+wide(?:\s+shot)?|wide(?:\s*/\s*long)?\s+shot|long\s+shot|"
        r"cowboy(?:\s+shot)?|medium[- ]long(?:\s+shot)?|medium\s+shot|medium\s+close[- ]up|"
        r"extreme\s+close[- ]up|(?<!extreme\s)(?<!medium\s)close[- ]up)"
        r"(?:\s*/\s*(?:extreme\s+)?(?:long|wide|medium|close)[- ]?(?:shot|up|wide)?)?"
        r"[^.!\n]{0,100}[.!]?\s*",
        "",
        rest,
        count=1,
        flags=re.I,
    )
    rest = rest.strip()
    out = spec["shot"]
    if rest:
        out = f"{out} {rest}"
    return f"{out} NEGATIVE: {spec['negative']}."


def enforce_cinematic_techniques(technique: str | list[str] | None, candidate: str) -> str:
    """Deterministically inject missing technique phrases so validation can pass after LLM repairs."""
    from ..workflow.cinematography import (LIGHT_CATEGORY, LIGHT_VISUAL_QUALITIES,
                                           selected_cinematic_techniques,
                                           technique_validation_markers)

    selected_items = selected_cinematic_techniques(technique)
    if not selected_items or not candidate.strip():
        return candidate

    text = candidate
    lower = text.lower()
    detail_bits: list[str] = []
    visual_bits: list[str] = []
    for selected in selected_items:
        # Shot-size catalog entries are rewritten by enforce_shot_size_framing — don't append a conflicting tagline.
        if selected["source_id"] in _SHOT_SIZE_TARGET_BY_SOURCE:
            continue
        aliases = technique_validation_markers(selected)
        title = selected["label"].casefold()
        aliases = (*aliases, title, *(part.strip().casefold() for part in re.split(r"[/()]", title) if len(part.strip()) > 3))
        primary = next((a for a in aliases if a), selected["label"].casefold())
        if not any(_marker_present(marker, lower) for marker in aliases):
            detail_bits.append(f"Apply {selected['label']} ({primary}) as a mandatory parameter of this shot.")
        source_id = selected["source_id"]
        if source_id == "4.5":
            text = re.sub(r"\beye[- ]level\b", "worm's-eye / ground level", text, flags=re.I)
            lower = text.lower()
        if source_id == "2.2":
            text = re.sub(
                r"\b(?:the )?camera\b[^.\n]{0,110}\b(?:moves|dollies|tracks|travels|orbits|pans|tilts|zooms)\w*",
                "The camera remains locked-off and static",
                text,
                flags=re.I,
            )
            if not any(_marker_present(m, text.lower()) for m in aliases):
                detail_bits.append("The camera remains locked-off and static throughout.")
            lower = text.lower()
        if source_id == "2.8":
            text = re.sub(r"\bwhip\s+pans?\b", "pan", text, flags=re.I)
            text = re.sub(r"\bswish\s+pans?\b", "pan", text, flags=re.I)
            lower = text.lower()
        if source_id == "2.9":
            text = re.sub(r"\bwhip\s+tilts?\b", "tilt", text, flags=re.I)
            lower = text.lower()
        if source_id == "14.1":
            text = re.sub(r"\bneo[- ]?noir\b", "film noir", text, flags=re.I)
            lower = text.lower()
        if source_id == "14.2":
            text = re.sub(r"\b(?<!neo-)(?<!neo )film noir\b", "neo-noir", text, flags=re.I)
            lower = text.lower()
        if selected["category"] == LIGHT_CATEGORY or source_id in LIGHT_VISUAL_QUALITIES:
            visual_match = re.search(r"(?ims)^\s*visual_style\s*:\s*(.*?)(?=^\s*overall_soundscape\s*:|\Z)", text)
            visual = visual_match.group(1).casefold() if visual_match else ""
            need = LIGHT_VISUAL_QUALITIES.get(source_id, (primary,))
            if not visual_match or not any(_marker_present(word, visual) for word in need):
                visual_bits.append(f"{selected['label']} ({primary}): motivated key with clear direction and fill.")

    if detail_bits:
        injection = " ".join(detail_bits)
        if re.search(r"(?im)^\s*detailed_description\s*:", text):
            m = re.search(
                r"(?ims)(^\s*detailed_description\s*:\s*)(.*?)(?=^\s*(?:visual_style|overall_soundscape)\s*:|\Z)",
                text,
            )
            if m:
                head, body = m.group(1), m.group(2)
                if re.search(r"(?i)\bNEGATIVE\s*:", body):
                    body = re.sub(r"(?i)\bNEGATIVE\s*:", f"{injection} NEGATIVE:", body, count=1)
                else:
                    body = body.rstrip() + f"\n{injection}\n"
                text = text[:m.start()] + head + body + text[m.end():]
        else:
            text = text.rstrip() + f"\n\ndetailed_description:\n{injection}\n"

    if visual_bits:
        block = " ".join(visual_bits)
        if re.search(r"(?im)^\s*visual_style\s*:", text):
            text = re.sub(
                r"(?im)(^\s*visual_style\s*:\s*)",
                rf"\1{block} ",
                text,
                count=1,
            )
        elif re.search(r"(?im)^\s*overall_soundscape\s*:", text):
            text = re.sub(
                r"(?im)(^\s*overall_soundscape\s*:)",
                rf"visual_style:\n{block}\n\n\1",
                text,
                count=1,
            )
        else:
            text = text.rstrip() + f"\n\nvisual_style:\n{block}\n"

    return text


def enforce_prompt_requirements(candidate: str, technique: str | list[str] | None,
                                refs: list[RefInfo] | None = None) -> str:
    """Last-resort patch so compose/edit always returns a usable prompt with selected techniques."""
    text = enforce_reference_tags(refs, candidate)
    text = enforce_shot_size_framing(technique, text)
    text = enforce_cinematic_techniques(technique, text)
    return text


def technique_repair_checklist(technique: str | list[str] | None) -> str:
    """Explicit marker phrases the repair pass must write into the prompt."""
    from ..workflow.cinematography import selected_cinematic_techniques, technique_validation_markers

    lines = []
    for item in selected_cinematic_techniques(technique):
        markers = technique_validation_markers(item)[:5]
        if not markers:
            continue
        lines.append(f"- {item['category']} / {item['label']}: впиши одно из [{', '.join(markers)}]")
    if not lines:
        return ""
    return "Обязательные маркеры выбранных кинотехник (дословно или близко):\n" + "\n".join(lines)


def cinematic_technique_edit_issues(technique: str | list[str] | None, candidate: str) -> list[str]:
    """Check that every selected category survived an assistant prompt edit."""
    from ..workflow.cinematography import (LIGHT_CATEGORY, LIGHT_VISUAL_QUALITIES,
                                           selected_cinematic_techniques,
                                           technique_validation_markers)

    selected_items = selected_cinematic_techniques(technique)
    if not selected_items:
        return []

    lower = candidate.lower()
    issues = []
    for selected in selected_items:
        aliases = technique_validation_markers(selected)
        title = selected["label"].casefold()
        aliases = (*aliases, title, *(part.strip().casefold() for part in re.split(r"[/()]", title) if len(part.strip()) > 3))
        if not any(_marker_present(marker, lower) for marker in aliases):
            issues.append(
                f"В промпте не отражена выбранная кинотехника «{selected['label']}» "
                f"из категории «{selected['category']}»."
            )
        source_id = selected["source_id"]
        if source_id in LIGHT_VISUAL_QUALITIES or selected["category"] == LIGHT_CATEGORY:
            visual_match = re.search(r"(?ims)^\s*visual_style\s*:\s*(.*?)(?=^\s*overall_soundscape\s*:|\Z)", candidate)
            visual = visual_match.group(1).casefold() if visual_match else ""
            if not visual_match:
                issues.append(
                    f"Добавь visual_style с описанием света для техники «{selected['label']}»."
                )
            elif source_id in LIGHT_VISUAL_QUALITIES:
                quality = LIGHT_VISUAL_QUALITIES[source_id]
                if not any(_marker_present(word, visual) for word in quality):
                    issues.append(
                        f"Укажи {selected['label']} в visual_style с источником, направлением и мягкостью света."
                    )
        if source_id == "2.2":
            positive = re.sub(r"(?ims)\bNEGATIVE\s*:[^\n]*", "", candidate)
            motion = re.compile(
                r"\bcamera\b[^.\n]{0,110}\b(?:moves|dollies|tracks|travels|orbits|pans|tilts|zooms|shifts|rotates|rolls|"
                r"executes?[^.\n]{0,45}(?:shift|movement|track|pan|tilt|zoom))\b", re.I,
            )
            if motion.search(positive):
                issues.append("Статичная камера противоречит описанному движению камеры.")
        if source_id == "4.5":
            positive = re.sub(r"(?ims)\bNEGATIVE\s*:[^\n]*", "", candidate)
            if re.search(r"\beye[- ]level\b", positive, re.I) and not re.search(
                r"\b(?:worm'?s[- ]eye|ground[- ]level|camera at ground)\b", positive, re.I,
            ):
                issues.append("Worm's-eye / ground level противоречит eye-level камере.")
        antonyms = _affirmative_antonym_hits(source_id, candidate)
        if antonyms:
            issues.append(
                f"Техника «{selected['label']}» конфликтует с формулировками: {', '.join(antonyms[:4])}."
            )
    return issues



def edit_system(refs: list[RefInfo], duration: float, face: bool = False, look: str | None = None,
                camera: str | None = "auto", light: str | None = "auto",
                cinematic_technique: str | None = "auto",
                cinematic_techniques: list[str] | None = None) -> str:
    del look, camera, light, cinematic_technique, cinematic_techniques
    if face:
        context = ("Это промпт для УЛУЧШЕНИЯ ЛИЦА (крупный план, воркфлоу FaceRefine). Метки фиксированы: <Picture 1> — фото "
                   "персонажа (прикреплено первым), <Picture 2> — крупный план лица из него (прикреплено вторым), "
                   "<Audio 1> — звук клипа (ты его не слышишь). Промпт должен остаться про крупный план лица, "
                   "кадрирование и движения — как в исходном видео.")
    else:
        seconds = max(2.5, round(duration, 1))
        context = (f"Длительность клипа ~{seconds} с (таймкоды кадров должны укладываться в неё).\n\n"
                   f"=== РЕФЕРЕНСЫ ===\n{_refs_block(refs)}")
    return f"""{EDIT_RULES}

{context}

{SPEC_BLOCK}

{CINEMA_CRAFT}

{HONESTY}

{OUTPUT_CONTRACT}"""


def edit_user_message(source_prompt: str, instruction: str, *, look: str | None = None,
                      camera: str = "auto", light: str = "auto",
                      cinematic_technique: str = "auto",
                      cinematic_techniques: list[str] | None = None) -> str:
    selects = plain_selects_block(look, camera, light, cinematic_technique, cinematic_techniques)
    parts = [
        "Current prompt:",
        "```text",
        source_prompt.strip(),
        "```",
    ]
    if instruction.strip():
        parts += ["", f"User edit request:\n{instruction.strip()}"]
    if selects:
        parts += ["", selects]
    parts += [
        "",
        "Apply the edit request and selected options, following the specification. "
        "Keep the user's scene/action unless they asked to change it. "
        "If PREVIS LOCK lines are present, keep those shot size / angle / motion / light / optics "
        "locked unless the edit request explicitly changes that axis. "
        "Return only the full prompt inside the required ```text fence.",
    ]
    return "\n".join(parts)


def chat_system(refs: list[RefInfo], duration: float, draft: str, fresh: bool, look: str | None = None,
                camera: str | None = "auto", light: str | None = "auto",
                cinematic_technique: str | None = "auto",
                cinematic_techniques: list[str] | None = None) -> str:
    """Ideas chat (studio assistant-stream.ts buildSystemMessage, adapted to this spec and output contract).

    fresh: a new chat (studio правка 166) - the generation panel's refs and draft are NOT shown, so a new
    conversation does not pick up another session's topic.
    """
    from ..workflow.camera import assistant_camera_block
    from ..workflow.cinematography import (CAMERA_CATEGORIES, LIGHT_CATEGORY,
                                           assistant_cinematography_block,
                                           resolve_cinematic_technique_ids,
                                           selected_cinematic_techniques)
    from ..workflow.light import assistant_light_block
    from ..workflow.look import assistant_look_hint

    seconds = max(2.5, round(duration, 1))
    refs_part = ("Референсы панели генерации в НОВОМ чате не показываются. Если пользователь не описал их словами — "
                 "метки <Picture N>, <Video N>, <Audio N> ЗАПРЕЩЕНЫ.") if fresh else _refs_block(refs)
    draft_line = ("Черновик промпта панели генерации: (скрыт — новый чат, не подтягивай тему из прошлых сессий)" if fresh
                  else "Черновик промпта панели генерации (состояние вкладки «Генерация», НЕ часть этого чата — используй "
                       f"ТОЛЬКО если пользователь прямо на него ссылается):\n{draft.strip() or '(пусто)'}")
    look_line = assistant_look_hint(look)
    look_block = f"\nПодача панели генерации: {look_line}\n" if look_line and not fresh else ""
    selected_ids = resolve_cinematic_technique_ids(cinematic_techniques, cinematic_technique, camera, light)
    categories = {item["category"] for item in selected_cinematic_techniques(selected_ids)}
    camera_block = f"\n{assistant_camera_block(camera)}\n" if not fresh and (camera != "auto" or not categories & CAMERA_CATEGORIES) else ""
    light_block = f"\n{assistant_light_block(light)}\n" if not fresh and (light != "auto" or LIGHT_CATEGORY not in categories) else ""
    # Craft knowledge is global; only the generation panel's selected override is hidden in a fresh chat.
    cinematography_block = f"\n{assistant_cinematography_block([] if fresh else selected_ids)}\n"
    return f"""Ты — ассистент видео-студии на модели MiniMax H3 (видео + синхронный звук). Помогаешь придумывать идеи
сцен и превращать их в промпты. Общайся по-русски.

{SPEC_BLOCK}

{CINEMA_CRAFT}
{look_block}
{camera_block}
{light_block}
{cinematography_block}
=== КОНТЕКСТ СЕССИИ ===
Длительность клипа: ~{seconds} с (таймкоды кадров должны укладываться в неё, последняя склейка ≤ длительность − 2 с).
{"На короткой длительности предлагай один shot." if seconds <= 4 else ""}

=== РЕФЕРЕНСЫ ПАНЕЛИ ГЕНЕРАЦИИ ===
{refs_part}

{HONESTY}
4) Если в прошлых репликах ЭТОГО чата упоминались референсы, которых нет в текущем списке, — их больше не существует,
   не переноси их описания.

{draft_line}

=== ВЛОЖЕНИЯ ЧАТА ===
Картинки, прикреплённые к сообщениям чата, существуют ТОЛЬКО в чате и нужны ТОЛЬКО для описания и анализа. Это НЕ
референсы генерации: НИКОГДА не ссылайся на них как <Picture N>. Если такая картинка должна попасть в видео — скажи
пользователю добавить её в референсы на вкладке «Генерация». Описывай её содержимое словами.

=== НЕЗАВИСИМОСТЬ ЧАТОВ ===
Этот чат — независимый диалог; другие чаты тебе недоступны. Отвечай только по теме этого чата.

=== ПОВЕДЕНИЕ В ЧАТЕ ===
- Болтовня, вопросы, советы → короткий ответ по-русски, БЕЗ структурированного промпта.
- Просят идеи → 3–5 пронумерованных вариантов по-русски, каждый в 2–3 предложениях: кто, что делает, где, камера,
  свет, звук/реплика. Разные по настроению и подаче. В конце предложи выбрать номер или доработать. Промпт не пиши.
- Просят промпт (или «сделай из идеи N») → промпт строго по спецификации выше. Короткая заметка по-русски ДО fence
  допустима. Промпт — ТОЛЬКО в ```text fence: первая строка — subject_definitions:, поля по порядку subject_definitions,
  summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music; строку id="x..." не выводи;
  сам промпт на английском (кроме реплик и видимого текста). Никогда не выдавай промпт простым текстом.
- Перед КАЖДЫМ промптом перепроверь текущие референсы выше; про длительность не спрашивай."""


def dialogue_lines(source_prompt: str) -> list[str]:
    """Spoken lines of a clip's prompt, exactly as written (<d>...</d>)."""
    import re

    return re.findall(r"<d>[\s\S]*?</d>", source_prompt or "")


def extract_prompt(text: str) -> str:
    """Fenced prompt from the reply (studio assistant-fence.ts extractInsertablePrompt)."""
    import re

    m = re.search(r"```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```", text)
    if m and m.group(1).strip():
        return m.group(1).strip().strip('"«»').strip()
    marker = re.search(r"subject_definitions\s*:", text, re.I)
    if marker:
        body = text[marker.start():]
        close = re.search(r"\n\s*```", body)
        return (body[:close.start()] if close else body).strip()
    return text.strip()
