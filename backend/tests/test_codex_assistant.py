"""Codex transport, context isolation and compatibility with the local assistant."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from app.llm import codex, config, prompt
from app.llm.service import AssistantService


@pytest.fixture
def cli(tmp_path, monkeypatch):
    script = tmp_path / "fake_cli.py"
    script.write_text('''
import json, sys, time
from pathlib import Path
args = sys.argv[1:]
text = sys.stdin.buffer.read().decode("utf-8")
if "WAIT_FOR_CANCEL" in text:
    time.sleep(30)
if "FAIL_AUTH" in text:
    print(json.dumps({"type": "turn.failed", "error": {"message": "401 unauthorized"}}))
    sys.exit(1)
if "EMPTY_REPLY" not in text:
    Path(args[args.index("--output-last-message") + 1]).write_text(text, encoding="utf-8")
print(json.dumps({"type": "turn.completed"}))
''', encoding="utf-8")
    monkeypatch.setattr(codex, "codex_command", lambda: [sys.executable, str(script)])
    monkeypatch.setattr(codex, "model_defaults", lambda: {})
    monkeypatch.setattr(codex.settings, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(codex.CodexRunner, "status", lambda *args, **kwargs: {"authenticated": True, "model_config": {}})
    return tmp_path


def test_old_settings_keep_local_provider_and_all_existing_values(monkeypatch):
    monkeypatch.setattr(config, "kv_get", lambda *args: {"model": "qwen", "context_size": 32768})
    settings = config.load()
    assert settings.provider == "local"
    assert settings.codex_reasoning_effort == ""
    assert settings.model == "qwen" and settings.context_size == 32768


def test_context_contains_verbatim_spec_refs_selects_direction_and_only_current_history():
    refs = [prompt.RefInfo(kind="image", name="герой.png"), prompt.RefInfo(kind="audio", name="трек.wav")]
    system = prompt.compose_system(refs, 5)
    user = prompt.compose_user_message("Он идёт слева направо", camera="static", light="rembrandt")
    text = codex.request_text(system, [{"role": "user", "content": user}], [Path("герой.png")])
    assert prompt.SPEC in text and prompt.OUTPUT_CONTRACT in text
    assert "<Picture 1> = герой.png" in text and "<Audio 1> = трек.wav" in text
    assert user in json.loads(text.split("=== CONVERSATION (JSON) ===\n")[1])[0]["content"]
    assert "Camera Behavior Card" in text and "«Стерильно»" in text
    assert "do not use tools" in text and "face refinement" in text


def test_native_npm_executable_is_found_without_launching_a_command_shell(tmp_path, monkeypatch):
    shim = tmp_path / "codex.cmd"
    shim.touch()
    native = tmp_path / "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
    native.parent.mkdir(parents=True)
    native.touch()
    monkeypatch.setattr(codex.shutil, "which", lambda name: str(shim) if name == "codex" else None)
    monkeypatch.setattr(codex.platform, "machine", lambda: "AMD64")
    assert codex.codex_command() == [str(native)]


def test_args_disable_unrelated_instructions_tools_and_preserve_model_only(tmp_path, monkeypatch):
    monkeypatch.setattr(codex, "model_defaults", lambda: {"model": "configured-model", "model_reasoning_effort": "medium"})
    image = tmp_path / "референс с пробелами.png"
    args = codex.exec_args(["codex"], tmp_path, [image])
    assert "--ignore-user-config" in args and "--ephemeral" in args
    assert args[args.index("--sandbox") + 1] == "read-only"
    assert "project_doc_max_bytes=0" in args and 'model="configured-model"' in args
    assert args[args.index("--image") + 1] == str(image.resolve())
    assert args[-1] == "-" and "shell_tool" in args and "hooks" in args
    assert "danger-full-access" not in args


def test_probe_reports_login_and_refreshes_cached_status(monkeypatch):
    monkeypatch.setattr(codex, "codex_command", lambda: ["codex"])
    monkeypatch.setattr(codex, "model_defaults", lambda: {})
    monkeypatch.setattr(codex, "available_models", lambda *args: [{"model": "available", "displayName": "Available", "isDefault": True}])
    results = iter([1, 0])
    monkeypatch.setattr(codex.subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], next(results)))
    runner = codex.CodexRunner()
    assert not runner.status()["authenticated"]
    assert "codex login" in runner.status()["error"]
    assert runner.status(refresh=True)["authenticated"]


def test_unavailable_app_model_uses_actual_cli_default_and_valid_effort():
    models = [{"model": "cli-model", "displayName": "CLI model", "isDefault": True,
               "supportedReasoningEfforts": [{"reasoningEffort": "medium"}], "defaultReasoningEffort": "medium"}]
    selected, notice = codex.select_model({"model": "app-only", "model_reasoning_effort": "ultra"}, models)
    assert selected == {"model": "cli-model", "model_reasoning_effort": "medium"}
    assert "app-only" in notice and "CLI model" in notice


async def test_transport_uses_utf8_stdin_and_returns_only_final_message(cli):
    runner = codex.CodexRunner()
    events = [e async for e in runner.stream("Правила", [{"role": "user", "content": "Кадр `x` $(y) — улыбка"}], [], asyncio.Event())]
    done = events[-1]
    assert done["done"] and not done["cancelled"]
    assert "Кадр `x` $(y) — улыбка" in done["text"]
    assert events[-2]["delta"] == done["text"]
    assert runner.proc is None and not list((cli / "data/codex_tmp").iterdir())


@pytest.mark.parametrize("brief, expected", [("FAIL_AUTH", "Вход в Codex"), ("EMPTY_REPLY", "пустой ответ")])
async def test_cli_failure_does_not_return_a_finished_prompt(cli, brief, expected):
    runner = codex.CodexRunner()
    events = [e async for e in runner.stream("Rules", [{"role": "user", "content": brief}], [], asyncio.Event())]
    assert expected in events[-1]["error"]
    assert not any(event.get("done") for event in events)
    assert runner.proc is None


async def test_stop_terminates_process_and_cleans_the_isolated_context(cli):
    runner = codex.CodexRunner()
    cancel = asyncio.Event()
    stream = runner.stream("Rules", [{"role": "user", "content": "WAIT_FOR_CANCEL"}], [], cancel)
    assert await anext(stream) == {"stage": "writing"}
    proc = runner.proc
    assert proc is not None and runner.running()
    cancel.set()
    rest = [event async for event in stream]
    assert rest[-1]["cancelled"] and proc.poll() is not None
    assert runner.proc is None and not list((cli / "data/codex_tmp").iterdir())


async def test_timeout_terminates_process(cli, monkeypatch):
    monkeypatch.setattr(codex, "REQUEST_TIMEOUT", 0.01)
    runner = codex.CodexRunner()
    events = [e async for e in runner.stream("Rules", [{"role": "user", "content": "WAIT_FOR_CANCEL"}], [], asyncio.Event())]
    assert "не ответил" in events[-1]["error"] and runner.proc is None


async def test_codex_uses_the_common_service_without_loading_local_models(monkeypatch):
    monkeypatch.setattr(config, "load", lambda: config.AssistantSettings(provider="codex"))
    svc = AssistantService(object(), lambda: False)
    monkeypatch.setattr(svc.codex, "status", lambda **kwargs: {"authenticated": True})

    async def stream(system, history, images, cancel, *, model="", reasoning_effort=""):
        assert svc.active == 1 and svc._cancel is cancel
        assert system == "Same rules" and history[-1]["content"] == "Same user"
        yield {"delta": "reply"}
        yield {"done": True, "prompt": "reply", "text": "reply", "cancelled": False}

    monkeypatch.setattr(svc.codex, "stream", stream)
    events = [event async for event in svc.stream("Same rules", "Same user", [])]
    assert events[-1]["done"] and svc.active == 0 and svc._cancel is None
    assert not svc.runner.running()


def test_explicit_selection_and_catalog_are_cached_separately(monkeypatch):
    monkeypatch.setattr(codex, "codex_command", lambda: ["codex"])
    monkeypatch.setattr(codex, "model_defaults", lambda: {"model": "first"})
    monkeypatch.setattr(codex.subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 0))
    monkeypatch.setattr(codex, "available_models", lambda *args: [
        {"model": "first", "displayName": "First", "isDefault": True},
        {"model": "second", "displayName": "Second"},
    ])
    runner = codex.CodexRunner()
    assert runner.status()["model"] == "first"
    chosen = runner.status(model="second")
    assert chosen["model"] == "second" and chosen["authenticated"]
    assert chosen["models"] == [{"id": "first", "label": "First", "reasoning_efforts": []},
                                {"id": "second", "label": "Second", "reasoning_efforts": []}]
    unavailable = runner.status(model="removed")
    assert not unavailable["authenticated"] and "Выберите другую" in unavailable["error"]


async def test_service_passes_explicit_model_to_the_cli(monkeypatch):
    monkeypatch.setattr(config, "load", lambda: config.AssistantSettings(
        provider="codex", codex_model="chosen", codex_reasoning_effort="low"))
    svc = AssistantService(object(), lambda: False)
    monkeypatch.setattr(svc.codex, "status", lambda **kwargs: {"authenticated": kwargs["model"] == "chosen"})

    async def stream(system, history, images, cancel, *, model, reasoning_effort):
        assert model == "chosen" and reasoning_effort == "low"
        yield {"done": True, "prompt": "ok", "cancelled": False}

    monkeypatch.setattr(svc.codex, "stream", stream)
    events = [event async for event in svc.stream("Rules", "User", [])]
    assert events[-1]["prompt"] == "ok"


def test_reasoning_selection_overrides_defaults_updates_cache_and_reports_unsupported(monkeypatch):
    monkeypatch.setattr(codex, "codex_command", lambda: ["codex"])
    monkeypatch.setattr(codex, "model_defaults", lambda: {"model": "chosen", "model_reasoning_effort": "high"})
    monkeypatch.setattr(codex.subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 0))
    monkeypatch.setattr(codex, "available_models", lambda *args: [{
        "model": "chosen", "displayName": "Chosen", "isDefault": True, "defaultReasoningEffort": "low",
        "supportedReasoningEfforts": [{"reasoningEffort": effort} for effort in ("none", "low", "high")],
    }])
    runner = codex.CodexRunner()
    assert runner.status()["reasoning_effort"] == "high"
    for effort in ("none", "low", "high"):
        chosen = runner.status(model="chosen", reasoning_effort=effort)
        assert chosen["model_config"]["model_reasoning_effort"] == effort
        assert chosen["models"][0]["reasoning_efforts"] == ["none", "low", "high"]
        args = codex.exec_args(["codex"], Path("tmp"), [], chosen["model_config"])
        assert f'model_reasoning_effort="{effort}"' in args
    fallback = runner.status(model="chosen", reasoning_effort="ultra")
    assert fallback["reasoning_effort"] == "low" and "ultra" in fallback["notice"]
    assert runner.status(model="chosen")["reasoning_effort"] == "high"


def test_reasoning_preference_is_persisted_independently_of_local_settings(monkeypatch):
    values = {}
    monkeypatch.setattr(config, "kv_set", lambda key, value: values.update({key: value}))
    monkeypatch.setattr(config, "kv_get", lambda key, default: values.get(key, default))
    config.save(config.AssistantSettings(provider="codex", codex_reasoning_effort="xhigh", temperature=0.3))
    saved = config.load()
    assert saved.codex_reasoning_effort == "xhigh" and saved.temperature == 0.3


async def test_busy_generation_blocks_codex_before_any_request(monkeypatch):
    monkeypatch.setattr(config, "load", lambda: config.AssistantSettings(provider="codex"))
    svc = AssistantService(object(), lambda: True)
    events = [event async for event in svc.stream("Rules", "User", [])]
    assert "недоступен" in events[0]["error"] and svc.active == 0
