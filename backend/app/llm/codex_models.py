"""Read the installed CLI's account-specific model catalog without starting a turn."""

import json
import os
import queue
import subprocess
import threading

from ..comfy.supervisor import kill_tree


def available_models(command: list[str]) -> list[dict]:
    proc = subprocess.Popen([*command, "--disable", "code_mode_host", "--disable", "hooks", "app-server"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    replies: queue.Queue = queue.Queue()

    def read() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            try:
                replies.put(json.loads(line))
            except ValueError:
                pass
        replies.put(None)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()

    def send(message: dict) -> None:
        assert proc.stdin is not None
        proc.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
        proc.stdin.flush()

    def result(request_id: int) -> dict:
        while True:
            response = replies.get(timeout=15)
            if response is None:
                raise OSError("Codex model catalog closed")
            if response.get("id") == request_id:
                if "error" in response:
                    raise OSError("Codex model catalog failed")
                return response["result"]

    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "shellmax", "version": "0.1"}}})
        result(1)
        send({"method": "initialized", "params": {}})
        models, cursor, request_id = [], None, 2
        while True:
            send({"id": request_id, "method": "model/list", "params": {"limit": 100, "cursor": cursor}})
            page = result(request_id)
            models.extend(page.get("data", []))
            cursor = page.get("nextCursor")
            if not cursor:
                return models
            request_id += 1
    except queue.Empty as error:
        raise OSError("Codex model catalog timed out") from error
    finally:
        if proc.stdin:
            proc.stdin.close()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            kill_tree(proc.pid)
            proc.wait(timeout=10)
        reader.join(timeout=1)
        if proc.stdout:
            proc.stdout.close()


def select_model(preferences: dict[str, str], models: list[dict]) -> tuple[dict[str, str], str]:
    candidates = [m for m in models if "image" in m.get("inputModalities", ["text", "image"])]
    if not candidates:
        raise OSError("No vision-capable Codex models")
    configured = preferences.get("model", "")
    selected = next((m for m in candidates if m["model"] == configured), None)
    notice = ""
    if selected is None:
        selected = next((m for m in candidates if m.get("isDefault")), candidates[0])
        if configured:
            notice = f"Модель {configured} недоступна в Codex CLI. Используется {selected['displayName']}, доступная через ваш аккаунт."
    effort = preferences.get("model_reasoning_effort", "")
    supported = [m["reasoningEffort"] for m in selected.get("supportedReasoningEfforts", [])]
    if effort not in supported:
        effort = selected.get("defaultReasoningEffort", "medium")
    return {"model": selected["model"], "model_reasoning_effort": effort}, notice
