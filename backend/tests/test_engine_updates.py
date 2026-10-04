"""Engine updates preserve user data, GPU builds, and the last working installation."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from app import settings
from app.comfy import update_runtime as rt
from app.comfy.compat import OLD_FORWARD, NEW_FORWARD
from app.comfy.updates import EngineUpdates
from app.updates_api import router


def repository(path: Path, content="old"):
    path.mkdir(parents=True, exist_ok=True)
    rt.git(path, "init", "--quiet")
    rt.git(path, "config", "user.email", "tests@example.invalid")
    rt.git(path, "config", "user.name", "Tests")
    (path / "code.py").write_text(content, encoding="utf-8")
    rt.git(path, "add", ".")
    rt.git(path, "commit", "--quiet", "-m", content)
    return rt.git(path, "rev-parse", "HEAD")


@pytest.fixture
def updater(tmp_path, monkeypatch):
    root = tmp_path / "ShellMax"
    portable = root / "comfy" / "portable"
    core = portable / "ComfyUI"
    old = repository(core)
    (core / ".gitignore").write_text("custom_nodes/\nmodels/\n", encoding="utf-8")
    rt.git(core, "add", ".gitignore")
    rt.git(core, "commit", "--quiet", "-m", "ignore user directories")
    old = rt.git(core, "rev-parse", "HEAD")
    (core / "custom_nodes").mkdir()
    models = core / "models"
    models.mkdir()
    (models / "weights").write_bytes(b"user model")
    python = portable / "python_embeded" / "python.exe"
    python.parent.mkdir()
    python.write_bytes(b"original python")
    (python.parent / "original.dll").write_bytes(b"original dependency")
    monkeypatch.setattr(settings, "ROOT", root)
    monkeypatch.setattr(settings, "DATA_DIR", root / "data")
    monkeypatch.setattr(settings, "portable_dir", lambda: portable)
    monkeypatch.setattr(settings, "comfy_config", lambda: {"port": 8288})
    monkeypatch.setattr(rt, "conflicts", lambda _: set())
    monkeypatch.setattr(rt, "installed", lambda *args: {"torch": "2.13.0+cu130"})
    engine = SimpleNamespace(state="ready", pid=None, detail="", start=AsyncMock(), stop=AsyncMock(),
                             client=SimpleNamespace(alive=AsyncMock(return_value=False)))
    service = EngineUpdates(engine, lambda: False)
    service.old, service.core, service.python = old, core, python
    return service


def new_version(service):
    (service.core / "code.py").write_text("new", encoding="utf-8")
    rt.git(service.core, "add", "code.py")
    rt.git(service.core, "commit", "--quiet", "-m", "new")
    new = rt.git(service.core, "rev-parse", "HEAD")
    rt.git(service.core, "checkout", "--quiet", "--detach", service.old)
    return {"id": "core", "name": "ComfyUI", "kind": "core", "current": service.old,
            "latest": new, "available": True, "error": None, "blocked": None}


def ready(service, component):
    service.plan = [component]
    service.info.update(phase="ready", check_id="check", components=[component])


def test_paths_never_allow_primary_installation(updater, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "portable_dir", lambda: tmp_path / "ComfyUI_LTX")
    with pytest.raises(ValueError, match="собственный"):
        updater._paths()


def test_primary_port_is_protected(updater, monkeypatch):
    monkeypatch.setattr(settings, "comfy_config", lambda: {"port": 8188})
    with pytest.raises(ValueError, match="8188"):
        updater._paths()


def test_dirty_detection_keeps_porcelain_leading_space(updater):
    (updater.core / "code.py").write_text("user edit", encoding="utf-8")
    assert rt.dirty_reason(updater.core)


def test_untracked_bytecode_does_not_block_node_updates(tmp_path):
    repo = tmp_path / "pack"
    repository(repo)
    cache = repo / "nodes" / "__pycache__"
    cache.mkdir(parents=True)
    (cache / "node.cpython-313.pyc").write_bytes(b"cache")
    assert rt.dirty_reason(repo) is None
    (repo / "local.py").write_text("USER = True", encoding="utf-8")
    assert rt.dirty_reason(repo)


def test_only_exact_managed_patch_is_accepted(tmp_path):
    repo = tmp_path / "ComfyUI-KJNodes"
    repository(repo)
    node = repo / "nodes" / "minimax_nodes.py"
    node.parent.mkdir()
    node.write_text(OLD_FORWARD + "\n", encoding="utf-8")
    rt.git(repo, "add", ".")
    rt.git(repo, "commit", "--quiet", "-m", "node")
    node.write_text(NEW_FORWARD + "\n", encoding="utf-8")
    assert rt.managed_patch(repo) == node
    assert rt.dirty_reason(repo) is None
    node.write_text(NEW_FORWARD + "\nLOCAL = 1\n", encoding="utf-8")
    assert rt.dirty_reason(repo)


@pytest.mark.parametrize("bad_ids,bad_check", [(["core"], "stale"), (["../ComfyUI_LTX"], "check"), (["missing"], "check")])
async def test_install_requires_current_plan(updater, bad_ids, bad_check):
    ready(updater, new_version(updater))
    with pytest.raises(ValueError):
        await updater.install(bad_ids, bad_check)
    updater.engine.stop.assert_not_called()


async def test_busy_engine_is_not_stopped(updater):
    ready(updater, new_version(updater))
    updater._busy = lambda: True
    with pytest.raises(ValueError, match="очереди"):
        await updater.install(["core"], "check")
    updater.engine.stop.assert_not_called()


async def test_install_and_restore_use_real_git_and_python_snapshot(updater, monkeypatch):
    component = new_version(updater)
    ready(updater, component)
    monkeypatch.setattr(updater, "_dependencies", lambda *args: [])
    monkeypatch.setattr(updater, "_verify", AsyncMock())
    monkeypatch.setattr(rt, "apply_dependencies", lambda *args: (updater.python.parent / "new.dll").write_bytes(b"new"))
    await updater.install(["core"], "check")
    await updater.task
    assert updater.info["phase"] == "done"
    assert rt.git(updater.core, "rev-parse", "HEAD") == component["latest"]
    assert (updater.python.parent / "new.dll").exists()
    assert updater.snapshot()["can_restore"]
    await updater.restore()
    await updater.task
    assert updater.info["phase"] == "done"
    assert rt.git(updater.core, "rev-parse", "HEAD") == updater.old
    assert updater.python.read_bytes() == b"original python"
    assert (updater.python.parent / "original.dll").read_bytes() == b"original dependency"
    assert not (updater.python.parent / "new.dll").exists()
    assert (updater.core / "models" / "weights").read_bytes() == b"user model"
    assert not updater.snapshot()["can_restore"]


@pytest.mark.parametrize("failure", ["pip", "verification"])
async def test_failed_update_rolls_back_both_code_and_environment(updater, monkeypatch, failure):
    ready(updater, new_version(updater))
    monkeypatch.setattr(updater, "_dependencies", lambda *args: [])

    def install(*args):
        updater.python.write_bytes(b"changed python")
        (updater.python.parent / "new.dll").write_bytes(b"new")
        if failure == "pip":
            raise RuntimeError("pip failed")

    monkeypatch.setattr(rt, "apply_dependencies", install)
    monkeypatch.setattr(updater, "_verify", AsyncMock(side_effect=RuntimeError("missing node")))
    await updater.install(["core"], "check")
    await updater.task
    assert updater.info["phase"] == "error"
    assert "восстановлена" in updater.info["message"]
    assert not updater.info["needs_restore"]
    assert rt.git(updater.core, "rev-parse", "HEAD") == updater.old
    assert updater.python.read_bytes() == b"original python"
    assert not (updater.python.parent / "new.dll").exists()


async def test_download_failure_does_not_stop_engine(updater, monkeypatch):
    ready(updater, new_version(updater))
    monkeypatch.setattr(updater, "_dependencies", lambda *args: (_ for _ in ()).throw(RuntimeError("offline")))
    await updater.install(["core"], "check")
    await updater.task
    updater.engine.stop.assert_not_called()
    assert rt.git(updater.core, "rev-parse", "HEAD") == updater.old


def test_snapshot_recovers_interrupted_update(updater):
    updater._set("installing", "Installing", needs_restore=True)
    recovered = EngineUpdates(updater.engine, lambda: False)
    assert recovered.info["needs_restore"]
    assert recovered.info["phase"] == "error"
    updater._set("error", "Network error", needs_restore=False)
    recovered = EngineUpdates(updater.engine, lambda: False)
    assert not recovered.info["needs_restore"]


def test_gpu_packages_are_constraints_and_never_upgrade_targets(tmp_path, monkeypatch):
    source = tmp_path / "core"
    source.mkdir()
    (source / "requirements.txt").write_text("torch>=2.4\ntriton-windows\nnumpy>=1.25\n", encoding="utf-8")
    monkeypatch.setattr(rt, "installed", lambda *args: {"torch": "2.13.0+cu130", "triton-windows": "3.6.0.post25", "numpy": "2.0"})
    calls = []

    def command(args, *unused, **kw):
        calls.append(args)
        report = Path(args[args.index("--report") + 1])
        report.write_text(json.dumps({"install": [{"metadata": {"name": "numpy", "version": "2.1"},
                                                    "download_info": {"url": "https://example.invalid/numpy.whl"}}]}), encoding="utf-8")

    monkeypatch.setattr(rt, "run", command)
    changes, constraints = rt.resolve_dependencies(tmp_path / "python.exe", [source], tmp_path, tmp_path / "log")
    assert changes[0]["name"] == "numpy"
    assert "torch==2.13.0+cu130" in constraints.read_text()
    assert "torch>=2.4" in constraints.read_text()
    assert "torch" not in (source / "shellmax-update-requirements.txt").read_text()
    assert "--dry-run" in calls[0]


async def test_api_guard_blocks_jobs_and_restarts_during_installation(updater):
    from app.main import guard_engine_updates

    app = FastAPI()
    app.state.updates = updater
    app.state.active_mutations = 0
    app.middleware("http")(guard_engine_updates)
    app.include_router(router, prefix="/api")
    @app.post("/api/engine/restart")
    async def restart():
        return {"ok": True}
    updater.info["phase"] = "installing"
    updater.task = asyncio.create_task(asyncio.sleep(60))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.post("/api/engine/restart")).status_code == 409
            assert (await client.get("/api/engine-updates")).status_code == 200
            assert (await client.post("/api/engine-updates/check")).status_code == 409
    finally:
        updater.task.cancel()
        await asyncio.gather(updater.task, return_exceptions=True)


@pytest.mark.parametrize("change", ["input", "output", "type"])
def test_changed_node_contract_is_rejected(change):
    before = {"Node": {"input": {"required": {"value": ["INT", {}]}}, "output": ["IMAGE"]}}
    after = json.loads(json.dumps(before))
    if change == "input":
        after["Node"]["input"]["required"]["new"] = ["INT", {}]
    elif change == "output":
        after["Node"]["output"] = ["LATENT"]
    else:
        after["Node"]["input"]["required"]["value"] = ["STRING", {}]
    with pytest.raises(RuntimeError):
        rt.validate_contracts(before, after, {"Node"})


def test_compatible_optional_input_and_added_output_are_allowed():
    before = {"Node": {"input": {"required": {"value": ["INT", {}]}}, "output": ["IMAGE"]}}
    after = json.loads(json.dumps(before))
    after["Node"]["input"]["optional"] = {"new": ["INT", {}]}
    after["Node"]["output"].append("MASK")
    rt.validate_contracts(before, after, {"Node"})


def test_checkout_cannot_replace_ignored_local_model(tmp_path):
    repo = tmp_path / "pack"
    repository(repo)
    (repo / ".gitignore").write_text("model.safetensors\n", encoding="utf-8")
    rt.git(repo, "add", ".gitignore")
    rt.git(repo, "commit", "--quiet", "-m", "ignore model")
    old = rt.git(repo, "rev-parse", "HEAD")
    model = repo / "model.safetensors"
    model.write_bytes(b"upstream file")
    rt.git(repo, "add", "--force", "model.safetensors")
    rt.git(repo, "commit", "--quiet", "-m", "new tracked model")
    new = rt.git(repo, "rev-parse", "HEAD")
    rt.git(repo, "checkout", "--quiet", "--detach", old)
    model.write_bytes(b"local weights")
    with pytest.raises(RuntimeError, match="локальный файл"):
        rt.validate_checkout(repo, old, new)
    assert model.read_bytes() == b"local weights"


def test_restore_resumes_after_interrupted_python_rename(updater):
    backup = updater.home / "backup-resume"
    backup.mkdir()
    rt.backup_python(updater.python, backup)
    updater.python.parent.rename(backup / "replaced-python")
    rt.restore_python(updater.python, backup)
    assert updater.python.read_bytes() == b"original python"
    rt.restore_python(updater.python, backup)
    assert updater.python.read_bytes() == b"original python"
