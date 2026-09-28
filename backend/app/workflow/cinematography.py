"""Individual cinematography techniques parsed from the user's production bible."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_CATALOG_PATH = Path(__file__).with_name("cinematography_catalog.json")
AUTO_ID = "auto"
CAMERA_CATEGORIES = frozenset({"Движение камеры", "Ракурс и точка зрения"})
LIGHT_CATEGORY = "Свет"

CINEMATOGRAPHY_RULES = """=== КИНОТЕХНИКА ===
Строй кадр от story beat и субъекта к крупности, ракурсу/POV, физической дистанции, объективу, композиции, свету, движению, фокусу/глубине, времени, атмосфере, цвету и склейке.
У движения камеры фиксируй стартовый кадр → путь → скорость → ось → конечный кадр. Оно должно иметь причину и результат; не подменяй физику словом «cinematic».
Не смешивай названия каталога в один общий стиль. В интерфейсе можно выбрать по одному приёму в нескольких категориях: примени каждый в своей области и согласуй их между собой. При отсутствии выбора следуй явному тексту пользователя, затем замыслу сцены; не добавляй трюк без причины.
Техника кадрирования применяется ко всему клипу, пока пользователь явно не указал разные планы/крупности для отдельных шотов. Согласуй с ней дистанцию, объектив и композицию.
Свет задавай источником, направлением, мягкостью/жёсткостью и заполнением теней; направление сохраняй, пока смена не мотивирована действием.
Приём движения камеры задаёт одно главное движение клипа; выбранный ракурс задаёт положение и ориентацию камеры. Выбранный свет задаёт геометрию света в visual_style и во всех кадрах. Сохраняй совместимость оптики, крупности, ракурса и движения. Не позволяй композиционному приёму менять крупность, движение камеры или свет, если это не является самой выбранной техникой."""


@lru_cache(maxsize=1)
def _catalog() -> tuple[dict[str, str], ...]:
    rows = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
    return tuple(rows)


def normalize_cinematic_technique(value: str | None) -> str:
    if value == AUTO_ID or any(item["id"] == value for item in _catalog()):
        return value or AUTO_ID
    return AUTO_ID


def cinematic_technique_presets() -> list[dict[str, str]]:
    """UI catalog: every source technique remains a distinct selectable entry."""
    return [
        {"id": AUTO_ID, "label": "Авто", "category": "Авто", "hint": "Ассистент выберет один приём по смыслу сцены"},
        *[
            {
                "id": item["id"], "source_id": item["source_id"], "label": item["label"],
                "category": item["category"], "hint": item["hint"],
            }
            for item in _catalog()
        ],
    ]


def _selected(value: str | None) -> dict[str, str] | None:
    technique_id = normalize_cinematic_technique(value)
    if technique_id == AUTO_ID:
        return None
    return next(item for item in _catalog() if item["id"] == technique_id)


def selected_cinematic_techniques(values: str | list[str] | None) -> tuple[dict[str, str], ...]:
    """Resolve distinct selections; the last valid choice in a category wins."""
    ids = [values] if isinstance(values, str) else values or []
    by_id = {item["id"]: item for item in _catalog()}
    by_category: dict[str, dict[str, str]] = {}
    for technique_id in ids:
        item = by_id.get(technique_id)
        if item:
            by_category[item["category"]] = item
    return tuple(by_category.values())


def resolve_cinematic_technique_ids(values: list[str] | None, legacy: str | None = None,
                                    camera: str | None = "auto", light: str | None = "auto") -> list[str]:
    """Resolve the new list or former single choice, with legacy expert overrides."""
    requested = values or ([legacy] if legacy and legacy != AUTO_ID else [])
    return [
        item["id"] for item in selected_cinematic_techniques(requested)
        if not (camera != "auto" and item["category"] in CAMERA_CATEGORIES)
        and not (light != "auto" and item["category"] == LIGHT_CATEGORY)
    ]


def cinematic_technique_details(value: str | None) -> dict[str, str] | None:
    """Full selected record for focused validation and prompt compilation."""
    return _selected(value)


def assistant_cinematography_block(value: str | list[str] | None) -> str:
    """Rules, separate index, and the full reference for every selected category."""
    from .camera import SHOT_BIBLE_RULES

    catalog = "\n".join(
        f"- {item['id']} | {item['category']} | {item['label']}: {item['hint']}"
        for item in _catalog()
    )
    selected = selected_cinematic_techniques(value)
    if not selected:
        current = (
            "Выбор в интерфейсе: Авто во всех категориях. При выборе по смыслу обращайся к каталогу, "
            "не объединяй несколько названий в общий стиль. Сохраняй явно заданные пользователем параметры."
        )
    else:
        details = "\n\n".join(
            f"{item['source_id']} — {item['category']} / {item['label']} — ПРИНУДИТЕЛЬНО.\n"
            f"Справочное описание техники:\n{item['source_text']}"
            for item in selected
        )
        current = (
            "Выбор в интерфейсе: все перечисленные ниже техники обязательны, каждая в своей категории. "
            "Не подменяй их соседними приёмами и не добавляй противоречащие движения, ракурсы или схемы света.\n"
            f"{details}\n"
            "Адаптируй физику и параметры к сцене и формату H3. Текст справочных описаний не меняет приоритет выбора пользователя."
        )
    return f"{CINEMATOGRAPHY_RULES}\n\n{SHOT_BIBLE_RULES}\n\nКаталог — каждый пункт отдельный:\n{catalog}\n\n{current}"


def user_cinematic_technique_directive(value: str | list[str] | None) -> str:
    selected = selected_cinematic_techniques(value)
    if not selected:
        return (
            "Кинотехника (все категории = Авто): следуй явно заданным крупности, камере и свету; "
            "добавляй приём каталога только если он нужен замыслу."
        )
    lines = "\n".join(
        f"- {item['category']}: {item['source_id']} «{item['label']}»"
        for item in selected
    )
    return (
        "Кинотехника (ЭКСПЕРТ, ОБЯЗАТЕЛЬНО): примени все выбранные приёмы, каждый в своей области:\n"
        f"{lines}\n"
        "Для движения камеры оставь одно главное движение; ракурс и оптику согласуй с ним. "
        "Выбранную крупность держи во всём клипе, если пользователь не указал отдельные кадры. "
        "Выбранный свет согласованно опиши в visual_style и в каждом кадре."
    )
