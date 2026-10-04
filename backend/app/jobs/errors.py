"""Human-readable engine / prompt errors for the UI."""

from ..comfy.client import PromptRejected


def humanize_error(exc_type: str, message: str, node_type: str = "") -> tuple[str, str]:
    low = f"{exc_type} {message}".lower()
    if "dlss" in node_type.lower() or "dlss 5" in low or "feature-18" in low:
        if "runtime" in low and any(term in low for term in ("not found", "no dlss", "incomplete", "protocol")):
            return "generic", "Runtime DLSS5 отсутствует или несовместим. Повторите scripts/install_dlss5.py через Python движка и перезапустите движок."
        if "feature-18" in low or "feature 18" in low:
            return "generic", "DLSS5 не подтвердил нейронную обработку. Закройте другие приложения, использующие GPU, и повторите; если ошибка остаётся, обновите драйвер NVIDIA."
        if "ffmpeg" in low or "ffprobe" in low:
            return "generic", "Не найдены ffmpeg/ffprobe для DLSS5. Повторите scripts/install_dlss5.py."
    if "aimdo memory compile error" in low or "hostbuf_file_reader_read failed" in low:
        return ("generic", "Ошибка управления памятью ComfyUI (aimdo). Перезапустите движок в Настройках → Система; для повтора включите «Экономию VRAM» или снизьте качество / длительность. Черновик сохранён, если он успел появиться.")
    if "minimax_block_lowmem_forward" in low and "attention" in low:
        return ("generic", "Режим «Экономия VRAM» несовместим с загруженной версией KJNodes. Перезапустите движок в Настройках → Система, чтобы применить исправление ShellMax.")
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
