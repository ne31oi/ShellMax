"""Owns the standalone ComfyUI process: start / stop / restart, log tail, readiness.

The engine outlives backend restarts: its output goes to a log file (a pipe would
break as soon as the backend dies - tqdm then fails with "[Errno 22] Invalid
argument") and its pid is remembered, so a restarted backend re-adopts it.
"""

import asyncio
import ctypes
import logging
import os
import shutil
import subprocess
import time

from .. import settings
from .client import ComfyClient

log = logging.getLogger("shellmax.engine")

LOG_FILE = settings.DATA_DIR / "engine.log"
PID_FILE = settings.DATA_DIR / "engine.pid"


def sync_shellmax_nodes() -> None:
    """Copy every pack in comfy_nodes/ into the engine (exFAT allows no symlinks/junctions)."""
    custom_nodes = settings.portable_dir() / "ComfyUI" / "custom_nodes"
    for src in (settings.ROOT / "comfy_nodes").iterdir():
        if src.is_dir() and not src.name.startswith(("_", ".")):
            shutil.copytree(src, custom_nodes / src.name, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("__pycache__"))


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    # os.kill on Windows would terminate the process; ask the kernel instead
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def kill_tree(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        os.kill(pid, 9)


def read_pid() -> int | None:
    try:
        return int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None


class EngineSupervisor:
    """States: not_installed | stopped | starting | ready | error | external (someone else's process)."""

    def __init__(self, client: ComfyClient, on_state):
        self.client = client
        self._on_state = on_state
        self.state = "stopped"
        self.detail = ""
        self.pid: int | None = None
        self._lock = asyncio.Lock()
        self.started_at: float | None = None

    @property
    def python(self):
        return settings.portable_dir() / "python_embeded" / "python.exe"

    def installed(self) -> bool:
        return self.python.exists()

    def log_tail(self, n: int = 400) -> list[str]:
        try:
            with LOG_FILE.open("rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - 256 * 1024))
                text = f.read().decode("utf-8", errors="replace")
        except OSError:
            return []
        # tqdm redraws with \r - keep only the latest state of each line
        return [line.split("\r")[-1] for line in text.splitlines()][-n:]

    async def _set(self, state: str, detail: str = "") -> None:
        self.state, self.detail = state, detail
        await self._on_state(self.snapshot())

    def snapshot(self) -> dict:
        return {"state": self.state, "detail": self.detail, "url": self.client.base_url,
                "pid": self.pid if pid_alive(self.pid) else None}

    async def start(self) -> None:
        async with self._lock:
            if await self.client.alive():
                pid = read_pid()
                if pid_alive(pid):
                    # our own engine from a previous backend run: take it over again
                    self.pid = pid
                    await self._set("ready", "Подключился к уже работающему движку")
                else:
                    await self._set("external", "На порту работает другой ComfyUI, запущенный не ShellMax")
                return
            if not self.installed():
                await self._set("not_installed", "Движок не установлен: запустите scripts\\install_comfy.ps1")
                return
            sync_shellmax_nodes()
            cfg = settings.comfy_config()
            args = [str(self.python), *cfg["args"], "--port", str(cfg["port"]), "--listen", cfg["host"]]
            extra = settings.portable_dir() / "ComfyUI" / "extra_model_paths.yaml"
            if extra.exists():
                args += ["--extra-model-paths-config", str(extra)]
            env = {**os.environ, **cfg.get("env", {}), "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
            log.info("starting ComfyUI: %s", " ".join(args))
            settings.ensure_dirs()
            with LOG_FILE.open("wb") as log_file:
                proc = subprocess.Popen(
                    args, cwd=settings.portable_dir(), env=env,
                    stdout=log_file, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                    creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
                    if os.name == "nt" else 0,
                )
            self.pid = proc.pid
            PID_FILE.write_text(str(proc.pid))
            self.started_at = time.time()
            await self._set("starting", "Запуск движка…")
        asyncio.create_task(self._wait_ready(proc.pid))

    async def _wait_ready(self, pid: int) -> None:
        deadline = time.time() + 600
        while time.time() < deadline:
            if not pid_alive(pid):
                tail = "\n".join(self.log_tail(15))
                await self._set("error", f"Движок завершился при запуске.\n{tail}")
                return
            if await self.client.alive():
                await self._set("ready", f"Готов за {time.time() - self.started_at:.0f} с")
                return
            await asyncio.sleep(1.5)
        await self._set("error", "Движок не ответил за 10 минут")

    async def stop(self) -> None:
        async with self._lock:
            pid, self.pid = self.pid, None
            if pid_alive(pid):
                await asyncio.to_thread(kill_tree, pid)
            PID_FILE.unlink(missing_ok=True)
            await self._set("stopped" if self.installed() else "not_installed")

    async def restart(self) -> None:
        await self.stop()
        await self.start()

    async def watch(self) -> None:
        """Detect crashes of a running engine."""
        while True:
            await asyncio.sleep(3)
            if self.state == "ready" and not pid_alive(self.pid):
                await self._set("error", "Движок остановился. Подробности — в логе (Настройки → Система)")
            elif self.state == "external" and not await self.client.alive():
                await self._set("stopped")
