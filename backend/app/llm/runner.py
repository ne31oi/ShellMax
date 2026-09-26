"""llama-server process for the assistant (studio llm-runner.ts, Bonsai backend flags)."""

import asyncio
import logging
import os
import subprocess
import time

import httpx

from .. import settings
from ..comfy.supervisor import kill_tree, pid_alive
from .config import AssistantSettings
from .registry import BONSAI_DIR, CHOICES, FILES

log = logging.getLogger("shellmax.llm")

LLM_PORT = 8090  # studio LLM_PORT
LLM_URL = f"http://127.0.0.1:{LLM_PORT}"
LOG_FILE = settings.DATA_DIR / "llm.log"
IDLE_STOP_S = 600  # studio: 10 min without requests -> unload (frees VRAM for MiniMax)


class LlmRunner:
    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.model: str | None = None
        self.ctx: int | None = None
        self.starting = False
        self.last_activity = 0.0
        self._lock = asyncio.Lock()

    @property
    def exe(self):
        return BONSAI_DIR / "llama.cpp" / "llama-server.exe"

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def touch(self) -> None:
        self.last_activity = time.time()

    async def ensure(self, s: AssistantSettings) -> None:
        """Start (or restart for another model) and wait for /health. Raises RuntimeError."""
        async with self._lock:
            if self.running() and self.model == s.model and self.ctx == s.context_size:
                await self._wait_health(90)
                return
            await self._stop_locked()
            choice = CHOICES[s.model]
            model = FILES[choice.model].dest
            mmproj = FILES[choice.mmproj].dest if choice.mmproj and FILES[choice.mmproj].ready() else None
            args = [
                str(self.exe), "-m", str(model),
                "-c", str(s.context_size),
                "-ngl", "99" if s.device == "gpu" else "0",
                "-fa", "on",
                # one slot: with the fork's unified KV, parallel slots leaked each other's context
                "-np", "1",
                # no fuzzy cross-task KV reuse: it restored a "similar" foreign prefix and answers drifted
                "-ctxcp", "0", "--no-cache-idle-slots",
                "--jinja",
                "--temp", "0.7", "--top-p", "0.8", "--top-k", "20", "--presence-penalty", "1.5",
                "--host", "127.0.0.1", "--port", str(LLM_PORT),
            ]
            if s.kv_cache != "off":
                args += ["-ctk", s.kv_cache, "-ctv", s.kv_cache]
            if mmproj:
                args += ["--mmproj", str(mmproj)]
            log.info("starting llama-server: %s", " ".join(args))
            self.starting = True
            try:
                with LOG_FILE.open("wb") as lf:
                    self.proc = subprocess.Popen(
                        args, cwd=self.exe.parent, stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                self.model, self.ctx = s.model, s.context_size
                self.touch()
                await self._wait_health(300)
            finally:
                self.starting = False

    async def _wait_health(self, timeout: float) -> None:
        deadline = time.time() + timeout
        async with httpx.AsyncClient() as client:
            while time.time() < deadline:
                if not self.running():
                    tail = _log_tail(12)
                    raise RuntimeError(f"Ассистент не запустился.\n{tail}")
                try:
                    r = await client.get(f"{LLM_URL}/health", timeout=2)
                    if r.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass  # model still loading
                await asyncio.sleep(1)
        raise RuntimeError("Ассистент не ответил вовремя")

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        proc, self.proc = self.proc, None
        self.model = None
        if proc and proc.poll() is None:
            await asyncio.to_thread(kill_tree, proc.pid)
            for _ in range(60):  # studio waits until the process has left the GPU
                if not pid_alive(proc.pid):
                    break
                await asyncio.sleep(0.25)

    async def idle_watchdog(self, busy) -> None:
        while True:
            await asyncio.sleep(60)
            if self.running() and not busy() and time.time() - self.last_activity > IDLE_STOP_S:
                log.info("assistant idle for 10 min - unloading")
                await self.stop()


def _log_tail(n: int) -> str:
    try:
        lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[-n:])
    except OSError:
        return ""
