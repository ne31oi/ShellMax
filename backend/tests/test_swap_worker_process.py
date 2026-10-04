"""Inference failures stay readable, and cancellation terminates the GPU worker."""
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load_worker(monkeypatch, check):
    comfy = ModuleType("comfy")
    comfy.__path__ = []
    mm = ModuleType("comfy.model_management")
    mm.throw_exception_if_processing_interrupted = check
    comfy.model_management = mm
    monkeypatch.setitem(sys.modules, "comfy", comfy)
    monkeypatch.setitem(sys.modules, "comfy.model_management", mm)
    spec = importlib.util.spec_from_file_location("swap_worker_process", ROOT / "comfy_nodes/shellmax_nodes/worker_process.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_worker_failure_keeps_tail_and_human_context(tmp_path, monkeypatch):
    module = load_worker(monkeypatch, lambda: None)
    def launch(command, stdout, **kwargs):
        stdout.write("x" * 3000 + "\nCUDA inference failed\n")
        return SimpleNamespace(poll=lambda: 2, returncode=2)
    monkeypatch.setattr(module.subprocess, "Popen", launch)
    with pytest.raises(RuntimeError) as caught:
        module.run_worker([], tmp_path / "worker.log", "Восстановление фона не завершилось")
    assert str(caught.value).startswith("Восстановление фона не завершилось: ")
    assert str(caught.value).endswith("CUDA inference failed\n")
    assert len(str(caught.value)) < 2300


def test_cancellation_kills_and_reaps_worker(tmp_path, monkeypatch):
    class Cancelled(Exception):
        pass
    def cancel():
        raise Cancelled()
    module = load_worker(monkeypatch, cancel)
    calls = []
    process = SimpleNamespace(poll=lambda: None, kill=lambda: calls.append("kill"),
                              wait=lambda: calls.append("wait"), returncode=None)
    monkeypatch.setattr(module.subprocess, "Popen", lambda *args, **kwargs: process)
    with pytest.raises(Cancelled):
        module.run_worker([], tmp_path / "worker.log", "Background failed")
    assert calls == ["kill", "wait"]
