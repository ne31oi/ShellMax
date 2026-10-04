"""Check and update only the private ComfyUI installation, with a restorable snapshot."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import time
import uuid
from pathlib import Path

from .. import settings
from . import update_runtime as rt
from .supervisor import pid_alive, read_pid

log = logging.getLogger("shellmax.updates")
ACTIVE_PHASES = {"checking", "preparing", "backup", "installing", "verifying", "restoring"}


class EngineUpdates:
    def __init__(self, engine, busy):
        self.engine, self._busy = engine, busy
        self.home = settings.DATA_DIR / "engine-updates"
        self.home.mkdir(parents=True, exist_ok=True)
        self.status_file = self.home / "status.json"
        self.log_file = self.home / "update.log"
        self.task: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        self.plan: list[dict] = []
        self.contracts: dict = {}
        self.info = {"phase": "idle", "message": "Проверьте обновления движка и пакетов нод",
                     "checked_at": None, "check_id": None, "components": [], "packages": [], "backup": None,
                     "needs_restore": False}
        try:
            previous = json.loads(self.status_file.read_text(encoding="utf-8"))
            self.info["backup"] = previous.get("backup")
            if previous.get("needs_restore"):
                self.info.update(phase="error", needs_restore=True,
                                 message="Обновление прервано. Восстановите резервную копию перед запуском движка.")
            elif previous.get("phase") in {"done", "error"}:
                self.info.update(phase=previous["phase"], message=previous["message"])
        except (OSError, ValueError):
            pass

    @property
    def active(self) -> bool:
        return self.task is not None and not self.task.done()

    @property
    def installing(self) -> bool:
        return self.active and self.info["phase"] != "checking"

    def _set(self, phase: str, message: str, **values) -> None:
        self.info.update(phase=phase, message=message, **values)
        temporary = self.status_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.info, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.status_file)

    def _paths(self, *, require_python: bool = True) -> tuple[Path, Path]:
        portable = settings.portable_dir().resolve()
        own = (settings.ROOT / "comfy").resolve()
        if not portable.is_relative_to(own):
            raise ValueError("Можно обновлять только собственный движок ShellMax в папке comfy")
        if settings.comfy_config()["port"] == 8188:
            raise ValueError("Порт 8188 принадлежит основной установке ComfyUI — её обновлять нельзя")
        python = portable / "python_embeded" / "python.exe"
        core = portable / "ComfyUI"
        if (require_python and not python.is_file()) or not (core / ".git").exists():
            raise ValueError("Движок ещё не установлен. Сначала запустите scripts\\install_comfy.ps1")
        return core, python

    def snapshot(self) -> dict:
        backup = self.info.get("backup")
        restorable = bool(backup and (self.home / backup / "ready").exists())
        return {**self.info, "active": self.active, "installing": self.installing,
                "can_restore": restorable, "log": self.log_tail()}

    def log_tail(self) -> list[str]:
        try:
            with self.log_file.open("rb") as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - 20000))
                return stream.read().decode("utf-8", errors="replace").splitlines()[-60:]
        except OSError:
            return []

    async def check(self) -> dict:
        async with self.lock:
            if self.active:
                raise ValueError("Проверка или установка уже выполняется — дождитесь окончания")
            self._paths()
            self._set("checking", "Проверяю ComfyUI и установленные пакеты…", components=[], packages=[], check_id=None)
            self.log_file.write_text("", encoding="utf-8")
            self.task = asyncio.create_task(self._check())
        return self.snapshot()

    async def _check(self) -> None:
        try:
            self.plan = await asyncio.to_thread(self._discover)
            self._set("checking", "Проверяю Python-зависимости…", components=self.plan)
            packages, package_error = [], None
            try:
                packages = await asyncio.to_thread(self._dependencies, self.plan, self.home / f"check-{uuid.uuid4().hex}")
            except Exception as exc:
                package_error = f"Не удалось проверить зависимости. Проверьте интернет и лог, затем повторите проверку.\n{exc}"
            dependency = {"id": "dependencies", "name": "Python-зависимости", "kind": "dependencies",
                          "current": "Установленные", "latest": f"Обновлений: {len(packages)}",
                          "available": bool(packages), "error": package_error, "blocked": None}
            self._set("ready", "Проверка завершена", components=[*self.plan, dependency], packages=packages,
                      checked_at=time.time(), check_id=uuid.uuid4().hex)
        except Exception as exc:
            log.exception("engine update check failed")
            self._set("error", f"Не удалось проверить обновления. Проверьте интернет и повторите проверку.\n{exc}")

    def _discover(self) -> list[dict]:
        core, _ = self._paths()
        repos = [("core", "ComfyUI", core)]
        nodes = core / "custom_nodes"
        repos += [(p.name, p.name, p) for p in sorted(nodes.iterdir()) if p.is_dir() and (p / ".git").exists()]
        result = []
        for cid, name, path in repos:
            item = {"id": cid, "name": name, "kind": "core" if cid == "core" else "nodes",
                    "current": "?", "latest": "?", "available": False, "blocked": None, "error": None}
            try:
                rt.repo_path(core, item)  # validate before invoking Git
                url = rt.git(path, "remote", "get-url", "origin")
                if not re.fullmatch(r"https://github\.com/[\w.-]+/[\w.-]+(?:\.git)?/?", url):
                    raise ValueError("Автоматическое обновление поддерживает HTTPS-репозитории GitHub")
                item["current"] = rt.git(path, "rev-parse", "HEAD")
                item["blocked"] = rt.dirty_reason(path)
                remote = rt.git(path, "ls-remote", "--symref", "origin", "HEAD")
                match = re.search(r"^([0-9a-f]{40})\s+HEAD$", remote, re.MULTILINE)
                if not match:
                    raise ValueError("Не удалось определить актуальную версию репозитория")
                item["latest"] = match[1]
                item["available"] = item["current"] != item["latest"]
                item["url"] = url
                if item["available"]:
                    rt.git(path, "fetch", "--quiet", "--no-tags", "origin", item["latest"])
                if cid == "core":
                    for field in ("current", "latest"):
                        source = rt.git(path, "show", f"{item[field]}:comfyui_version.py")
                        version = re.search(r'__version__\s*=\s*[\'"]([^\'"]+)', source)
                        if version:
                            item[field + "_label"] = version[1] + " · " + item[field][:8]
            except Exception as exc:
                item["error"] = str(exc)
            result.append(item)
        return result

    def _dependencies(self, components: list[dict], work: Path) -> list[dict]:
        core, python = self._paths()
        work.mkdir()
        try:
            sources = []
            for component in self.plan:
                repo = rt.repo_path(core, component)
                selected = next((c for c in components if c["id"] == component["id"]), None)
                revision = selected["latest"] if selected and not selected.get("error") and not selected.get("blocked") else rt.git(repo, "rev-parse", "HEAD")
                target = work / component["id"]
                rt.stage_repo(repo, revision, target)
                sources.append(target)
            changes, _ = rt.resolve_dependencies(python, sources, work, self.log_file)
            return changes
        finally:
            shutil.rmtree(work)

    def _assert_idle(self) -> None:
        if self._busy():
            raise ValueError("Дождитесь окончания генерации, очереди и работы ассистента, затем повторите установку")
        if self.engine.state in {"starting", "external"}:
            raise ValueError("Дождитесь запуска собственного движка. Внешний процесс обновлять нельзя")

    async def install(self, ids: list[str], check_id: str) -> dict:
        async with self.lock:
            if self.active:
                raise ValueError("Проверка или установка уже выполняется")
            if self.info["phase"] != "ready" or check_id != self.info["check_id"]:
                raise ValueError("Сначала проверьте обновления заново")
            if self.info["needs_restore"]:
                raise ValueError("Сначала восстановите резервную копию прерванного обновления")
            self._assert_idle()
            selected = [c for c in self.info["components"] if c["id"] in ids]
            if not selected or len({c["id"] for c in selected}) != len(set(ids)):
                raise ValueError("Выберите обновления из последней проверки")
            if any(c["blocked"] or c["error"] or not c["available"] for c in selected):
                raise ValueError("Выбранное обновление недоступно. Исправьте указанную причину и проверьте снова")
            self._set("preparing", "Подготавливаю обновление…")
            self.task = asyncio.create_task(self._install([c for c in selected if c["kind"] != "dependencies"]))
        return self.snapshot()

    def _backup(self, selected: list[dict]) -> Path:
        core, python = self._paths()
        backup = self.home / f"backup-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
        backup.mkdir()
        records = []
        for component in selected:
            repo = rt.repo_path(core, component)
            if rt.git(repo, "rev-parse", "HEAD") != component["current"] or rt.dirty_reason(repo):
                raise RuntimeError(f"{component['name']} изменился после проверки. Проверьте обновления заново")
            rt.validate_checkout(repo, component["current"], component["latest"])
            patch = rt.managed_patch(repo)
            record = {"id": component["id"], "head": component["current"], "patch": None}
            if patch:
                record["patch"] = patch.relative_to(repo).as_posix()
                (backup / f"{component['id']}.patch-source").write_bytes(patch.read_bytes())
            records.append(record)
        rt.backup_python(python, backup)
        (backup / "conflicts.json").write_text(json.dumps(sorted(rt.conflicts(python))), encoding="utf-8")
        versions = rt.installed(python, self.log_file)
        (backup / "gpu.json").write_text(json.dumps({k: v for k, v in versions.items() if k in rt.PROTECTED}), encoding="utf-8")
        (backup / "node-contracts.json").write_text(json.dumps(self.contracts), encoding="utf-8")
        (backup / "repos.json").write_text(json.dumps(records), encoding="utf-8")
        (backup / "ready").touch()
        self._set("backup", "Резервная копия сохранена", backup=backup.name)
        return backup

    def _apply(self, selected: list[dict], packages: list[dict], backup: Path) -> None:
        core, python = self._paths()
        records = json.loads((backup / "repos.json").read_text(encoding="utf-8"))
        for component, record in zip(selected, records):
            repo = rt.repo_path(core, component)
            if rt.git(repo, "rev-parse", "HEAD") != record["head"] or rt.dirty_reason(repo):
                raise RuntimeError(f"{component['name']} изменился во время подготовки; обновление отменено")
            rt.validate_checkout(repo, record["head"], component["latest"])
            if record["patch"]:
                rt.git(repo, "restore", "--", record["patch"])
            rt.git(repo, "checkout", "--quiet", "--detach", component["latest"])
        work = backup / "install"
        work.mkdir()
        rt.apply_dependencies(python, packages, work, self.log_file)
        before = set(json.loads((backup / "conflicts.json").read_text(encoding="utf-8")))
        added = rt.conflicts(python) - before
        if added:
            raise RuntimeError("Появились конфликты зависимостей:\n" + "\n".join(sorted(added)))
        protected = json.loads((backup / "gpu.json").read_text(encoding="utf-8"))
        versions = rt.installed(python, self.log_file)
        if any(versions.get(k) != v for k, v in protected.items()):
            raise RuntimeError("Версии CUDA-ускорителей изменились; восстанавливаю прежнюю установку")

    async def _verify(self) -> None:
        await self.engine.start()
        deadline = time.monotonic() + 600
        while self.engine.state == "starting" and time.monotonic() < deadline:
            await asyncio.sleep(1)
        if self.engine.state != "ready":
            raise RuntimeError(f"Движок не запустился после обновления: {self.engine.detail}")
        info = await self.engine.client.object_info()
        required = rt.required_classes(settings.ROOT / "scripts" / "install_comfy.ps1")
        missing = sorted(required - info.keys())
        if missing:
            raise RuntimeError("Не загрузились ноды: " + ", ".join(missing))
        rt.validate_contracts(self.contracts, info, required)
        _, python = self._paths()
        script = "import torch,sageattention,comfy_kitchen as ck; assert torch.cuda.is_available(), 'CUDA unavailable'; assert ck.sol_attn_is_available(torch.device('cuda')), 'sol-attn unavailable'; print('CUDA / SageAttention / sol-attn OK')"
        await asyncio.to_thread(rt.run, [str(python), "-s", "-c", script], python.parent,
                                log=self.log_file, timeout=120)

    async def _install(self, selected: list[dict]) -> None:
        backup = None
        stopped = False
        try:
            packages = await asyncio.to_thread(self._dependencies, selected, self.home / f"install-{uuid.uuid4().hex}")
            self._assert_idle()
            if await self.engine.client.alive():
                queue = await self.engine.client.queue_state()
                if queue.get("queue_running") or queue.get("queue_pending"):
                    raise RuntimeError("В ComfyUI есть задачи. Дождитесь окончания очереди")
                if not pid_alive(self.engine.pid or read_pid()):
                    raise RuntimeError("На порту работает внешний ComfyUI. Его обновлять нельзя")
                self.contracts = await self.engine.client.object_info()
            else:
                self.contracts = {}
            await self.engine.stop()
            stopped = True
            self._set("backup", "Сохраняю резервную копию Python и версий пакетов…")
            backup = await asyncio.to_thread(self._backup, selected)
            self._set("installing", "Устанавливаю обновления ComfyUI, нод и зависимостей…", packages=packages, needs_restore=True)
            await asyncio.to_thread(self._apply, selected, packages, backup)
            self._set("verifying", "Запускаю движок и проверяю необходимые ноды и CUDA…")
            await self._verify()
            self.engine.started_at = time.time()
            updated_ids = {c["id"] for c in selected} | {"dependencies"}
            components = [{**c, "current": c["latest"], "current_label": c.get("latest_label"), "available": False} if c["id"] in updated_ids else c
                          for c in self.info["components"]]
            self._set("done", "Обновления установлены. Движок запущен, необходимые ноды и CUDA проверены.",
                      check_id=None, needs_restore=False, components=components)
        except Exception as exc:
            log.exception("engine update installation failed")
            message = f"Обновление не установлено.\n{exc}"
            if backup:
                self._set("restoring", "Обновление не прошло проверку. Восстанавливаю прежнюю установку…")
                try:
                    await self.engine.stop()
                    await asyncio.to_thread(self._restore_files, backup)
                    await self.engine.start()
                    self.info["needs_restore"] = False
                    message += "\nПредыдущая установка восстановлена."
                except Exception as restore_error:
                    log.exception("engine update rollback failed")
                    message += f"\nОткат не завершён: {restore_error}. Резервная копия: {backup}"
            elif stopped:
                await self.engine.start()
            self._set("error", message, check_id=None)

    def _restore_files(self, backup: Path) -> None:
        core, python = self._paths(require_python=False)
        for record in json.loads((backup / "repos.json").read_text(encoding="utf-8")):
            repo = rt.repo_path(core, record)
            reason = rt.dirty_reason(repo)
            if reason:
                raise RuntimeError(f"{repo.name}: {reason}")
            patch = rt.managed_patch(repo)
            if patch:
                rt.git(repo, "restore", "--", patch.relative_to(repo).as_posix())
            rt.validate_checkout(repo, rt.git(repo, "rev-parse", "HEAD"), record["head"])
            rt.git(repo, "checkout", "--quiet", "--detach", record["head"])
            if record["patch"]:
                (repo / record["patch"]).write_bytes((backup / f"{record['id']}.patch-source").read_bytes())
        rt.restore_python(python, backup)
        (backup / "ready").unlink()

    async def restore(self) -> dict:
        async with self.lock:
            if self.active:
                raise ValueError("Дождитесь текущей проверки или установки")
            self._assert_idle()
            if not self.snapshot()["can_restore"]:
                raise ValueError("Нет завершённой резервной копии для восстановления")
            self._set("restoring", "Восстанавливаю предыдущую установку…")
            self.task = asyncio.create_task(self._restore())
        return self.snapshot()

    async def _restore(self) -> None:
        try:
            if await self.engine.client.alive():
                queue = await self.engine.client.queue_state()
                if queue.get("queue_running") or queue.get("queue_pending"):
                    raise RuntimeError("В ComfyUI есть задачи. Дождитесь окончания очереди")
                if not pid_alive(self.engine.pid or read_pid()):
                    raise RuntimeError("На порту работает внешний ComfyUI. Его восстанавливать нельзя")
            await self.engine.stop()
            self._set("restoring", "Возвращаю прежние файлы движка и Python…", needs_restore=True)
            backup = self.home / self.info["backup"]
            self.contracts = json.loads((backup / "node-contracts.json").read_text(encoding="utf-8"))
            await asyncio.to_thread(self._restore_files, backup)
            self.info["needs_restore"] = False
            await self._verify()
            self._set("done", "Предыдущая установка восстановлена и проверена", check_id=None, needs_restore=False, components=[], packages=[])
        except Exception as exc:
            log.exception("engine restore failed")
            self._set("error", f"Не удалось восстановить установку. Проверьте лог.\n{exc}")
