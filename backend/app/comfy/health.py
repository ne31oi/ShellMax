"""Detect a dead ComfyUI job worker even while its HTTP server remains alive."""

import re


WORKER_FAILED = (
    "Движок неисправен: поток обработки задач ComfyUI завершился с ошибкой. "
    "Перезапустите движок в Настройках → Система перед новой генерацией. Черновики сохранены."
)


def worker_failed(lines: list[str]) -> bool:
    return any(re.search(r"Exception in thread .*\(prompt_worker\)", line) for line in lines)
