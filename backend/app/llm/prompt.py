"""System prompts for the assistant's two jobs:

1. compose - turn the user's plain-words description (with reference tags) into a prompt;
2. face    - write the close-up prompt for MiniMax_H3_FaceRefine_Best.

Prompt-writing rules: the user's specification (prompt_spec.md, verbatim copy of
MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md).
Reference honesty rules and the fenced output contract: Minimax Studio V6
(src/lib/h3-prompt-spec.ts, assistant-stream.ts). Face refine rules: the notes of
workflows/MiniMax_H3_FaceRefine_Best.json.
"""

from pathlib import Path

from pydantic import BaseModel

SPEC = Path(__file__).with_name("prompt_spec.md").read_text(encoding="utf-8").strip()
F = "```"


class RefInfo(BaseModel):
    kind: str  # image | video | audio
    name: str
    with_audio: bool = False


OUTPUT_CONTRACT = f"""=== ФОРМАТ ОТВЕТА (БЕЗ ИСКЛЮЧЕНИЙ) ===
Ответ — ТОЛЬКО готовый промпт в markdown code fence, без пояснений до или после:
{F}text
subject_definitions:
...
non_diegetic_music:
...
{F}
- первая строка внутри fence — subject_definitions:
- поля по порядку: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music;
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
3) АУДИО ты НЕ слышишь: ссылайся только меткой <Audio N>; реплики бери ТОЛЬКО из текста пользователя, не придумывай слова."""


def _refs_block(refs: list[RefInfo]) -> str:
    images = [r for r in refs if r.kind == "image"]
    videos = [r for r in refs if r.kind == "video"]
    audios = [r for r in refs if r.kind == "audio"]
    if not refs:
        return ("Референсов НЕТ. Метки <Picture N>, <Video N>, <Audio N> ЗАПРЕЩЕНЫ. Субъекты и окружение описывай "
                "словами и помечай в retention_analysis как newly_generated.")
    lines = [
        "Каждое изображение обязано попасть в промпт своей меткой <Picture N>: создай <Subject N> в "
        "subject_definitions и привяжи его к <Picture N> (раздел 4 спецификации), дальше используй <Subject N>.",
        "Промпт без меток при прикреплённых референсах = ОШИБКА.",
    ]
    if images:
        lines.append("ИЗОБРАЖЕНИЯ — ты их ВИДИШЬ (прикреплены к сообщению в этом порядке), описывай по факту:")
        lines += [f"  <Picture {i}> = {r.name}" for i, r in enumerate(images, 1)]
    if videos:
        lines.append("ВИДЕО — только теги, кадры НЕ прикреплены: не описывай и не угадывай их содержимое; используй "
                     "метку, когда пользователь просит движение/сцену из видео:")
        lines += [f"  <Video {i}> = {r.name}" + (" (со звуковой дорожкой для MiniMax)" if r.with_audio else "")
                  for i, r in enumerate(videos, 1)]
    if audios:
        lines.append("АУДИО — референсы голоса/звучания для MiniMax, модель их НЕ слышит:")
        lines += [f"  <Audio {i}> = {r.name}" for i, r in enumerate(audios, 1)]
    if not videos:
        lines.append("<Video N> ЗАПРЕЩЕНЫ — видео-референсов нет.")
    if not audios:
        lines.append("<Audio N> ЗАПРЕЩЕНЫ — аудио-референсов нет; голоса и реплики описывай словами.")
    if images:
        lines.append("ВИЗУАЛЬНЫЙ ЯКОРЬ: для каждого персонажа с картинки опиши по факту черты лица, глаза, волосы, кожу, "
                     "возраст, телосложение, одежду (цвет, фасон, детали), характерные признаки; в retention_analysis "
                     "отметь уровень сохранения с перечислением этих деталей; в detailed_description повторяй ключевые "
                     "детали при упоминании <Subject N>.")
    return "\n".join(lines)


def compose_system(refs: list[RefInfo], duration: float) -> str:
    seconds = max(2.5, round(duration, 1))
    return f"""Ты превращаешь описание пользователя в промпт для видео-модели MiniMax H3 (видео + синхронный звук).
Пользователь пишет обычными словами, на любом языке, и может ставить метки референсов (<Picture N>, <Video N>, <Audio N>).
Сохрани его замысел полностью: кто, что делает, где, какие реплики. То, что он не уточнил (камера, свет, физика,
звук, микро-актёрская игра), добавь сам по спецификации — конкретно и правдоподобно, не противореча замыслу.
Реплики персонажей бери дословно из текста пользователя, не придумывай новые слова.

{SPEC_BLOCK}

=== КЛИП ===
Длительность: ~{seconds} с. Таймкоды кадров ([Shot 2] At 00:03.000) должны укладываться в неё, последняя склейка ≤ длительность − 2 с.
Для такой длины обычно достаточно одного-двух кадров (shots).

=== РЕФЕРЕНСЫ ===
{_refs_block(refs)}

{HONESTY}

{OUTPUT_CONTRACT}"""


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
- detailed_description: один кадр [Shot 1] — непрерывный фотореалистичный крупный план <Subject 1>. Кадрирование,
  положение и размер головы, повороты головы, движения тела и камеры остаются ТОЧНО как в исходном видео — меняется
  только детализация лица. Лицо резкое, два чётких симметричных естественных глаза, естественные веки и ресницы,
  чёткий нос, читаемый рот с естественными зубами. Губы, челюсть и щёки двигаются с <Audio 1>, черты и личность стабильны.
  Реплики пиши в <d>...</d> ТОЛЬКО если они есть в исходном промпте клипа — дословно; иначе не придумывай слова.
  Закончи запретами: No facial morphing, no duplicated features, no warping, no face blur, no plastic skin.
- visual_style (можно внутри detailed_description или отдельной строкой в конце описания): реальная фотографическая
  съёмка, микротекстура кожи, поры, пряди волос, свет как в окружающем кадре (по прикреплённому кадру клипа).
- overall_soundscape: ровно одна строка «Only the exact supplied sound from <Audio 1>.» — дословно, ничего не добавляй:
  звук берётся из клипа как есть, любое описание звука уводит губы от <Audio 1>.
- non_diegetic_music: ровно «N/A».
- Не описывай общий план, окружение подробно и действия всего тела — только то, что видно в крупном плане.

{SPEC_BLOCK}

{HONESTY}

{OUTPUT_CONTRACT}"""


EDIT_RULES = """Ты ПРАВИШЬ готовый промпт MiniMax H3 по просьбе пользователя (просьба — обычными словами, на любом языке).
- Внеси ТОЛЬКО то, о чём просят. Всё остальное оставь дословно: текст, порядок полей, метки <Picture N>/<Video N>/<Audio N>/<Subject N>.
- Если правка по смыслу затрагивает другие поля (например, «ночь вместо дня» → свет в detailed_description и звук в
  overall_soundscape), обнови их минимально, чтобы промпт остался согласованным.
- Новые детали пиши так же конкретно, как требует спецификация (действия цепочкой, камера, физика, свет, звук).
- Реплики не придумывай: меняй или добавляй их только если пользователь дал текст.
- Верни ПОЛНЫЙ исправленный промпт, а не только изменённые куски."""


def edit_system(refs: list[RefInfo], duration: float, face: bool = False) -> str:
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

{HONESTY}

{OUTPUT_CONTRACT}"""


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
