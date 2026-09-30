"""Human-readable engine / prompt errors for the UI."""

from ..comfy.client import PromptRejected


def humanize_error(exc_type: str, message: str, node_type: str = "") -> tuple[str, str]:
    low = f"{exc_type} {message}".lower()
    if ("out of memory" in low or "outofmemory" in low or "allocation on device" in low
            or "mha_graph.execute" in low):
        return ("oom",
                "Не хватило видеопамяти. Снизьте качество или длительность, либо включите «Экономию VRAM».")
    if "filenotfound" in low or "файл не найден" in low or "путь к файлу" in low:
        return "missing_file", message.replace("ShellMax: ", "")
    if node_type in ("ShellMaxH3ObjectMask", "MiniMaxH3FantasticObjectMask") and (
            "found nothing" in low or "didn't find" in low or "mask is empty" in low):
        return "generic", "SAM не нашёл объект. Поставьте зелёную точку внутри него на другом кадре, уточните красными точками фон и повторите трекинг."
    where = f" ({node_type})" if node_type else ""
    return "generic", f"Ошибка движка{where}: {message.strip() or exc_type}"


def describe_rejection(e: PromptRejected) -> str:
    parts = [str(e)]
    for node_id, err in (e.details.get("node_errors") or {}).items():
        for item in err.get("errors", []):
            parts.append(f"{err.get('class_type', node_id)}: {item.get('details') or item.get('message')}")
    return "Движок отклонил задачу: " + "; ".join(parts)
