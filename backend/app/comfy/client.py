"""Thin async client for the ComfyUI HTTP + WebSocket API."""

import asyncio
import json
import logging
import struct
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
import websockets

from .. import settings

log = logging.getLogger("shellmax.comfy")

# binary websocket frame types (server.py BinaryEventTypes)
PREVIEW_IMAGE = 1
PREVIEW_IMAGE_WITH_METADATA = 4


class ComfyError(Exception):
    pass


class PromptRejected(ComfyError):
    """ComfyUI refused the prompt (validation). `details` carries node_errors."""

    def __init__(self, message: str, details: dict):
        super().__init__(message)
        self.details = details


class ComfyClient:
    def __init__(self, base_url: str | None = None):
        self.base_url = base_url or settings.comfy_url()
        self.client_id = uuid.uuid4().hex
        self._http = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(60, connect=5))

    async def close(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------------ REST
    async def alive(self) -> bool:
        try:
            r = await self._http.get("/system_stats", timeout=3)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    async def system_stats(self) -> dict:
        r = await self._http.get("/system_stats")
        r.raise_for_status()
        return r.json()

    async def object_info(self, node_class: str | None = None) -> dict:
        r = await self._http.get(f"/object_info/{node_class}" if node_class else "/object_info", timeout=120)
        r.raise_for_status()
        return r.json()

    async def queue_prompt(self, prompt: dict) -> str:
        r = await self._http.post("/prompt", json={"prompt": prompt, "client_id": self.client_id})
        if r.status_code != 200:
            try:
                body = r.json()
            except ValueError:
                body = {"error": {"message": r.text}}
            err = body.get("error", {})
            msg = err.get("message", "prompt rejected") if isinstance(err, dict) else str(err)
            raise PromptRejected(msg, body)
        return r.json()["prompt_id"]

    async def interrupt(self, prompt_id: str | None = None) -> None:
        payload = {"prompt_id": prompt_id} if prompt_id else {}
        await self._http.post("/interrupt", json=payload)

    async def delete_from_queue(self, prompt_id: str) -> None:
        await self._http.post("/queue", json={"delete": [prompt_id]})

    async def free_models(self) -> None:
        """Unload models and free cached memory (ComfyUI /free)."""
        r = await self._http.post("/free", json={"unload_models": True, "free_memory": True}, timeout=10)
        r.raise_for_status()

    async def history(self, prompt_id: str) -> dict:
        r = await self._http.get(f"/history/{prompt_id}")
        r.raise_for_status()
        return r.json().get(prompt_id, {})

    async def queue_state(self) -> dict:
        """Raw /queue: {queue_running: [[num, prompt_id, ...], ...], queue_pending: [...]}."""
        r = await self._http.get("/queue", timeout=10)
        r.raise_for_status()
        return r.json()

    def prompt_in_queue(self, queue: dict, prompt_id: str) -> bool:
        for bucket in (queue.get("queue_running") or [], queue.get("queue_pending") or []):
            for item in bucket:
                if isinstance(item, (list, tuple)) and len(item) > 1 and item[1] == prompt_id:
                    return True
        return False

    async def upload_input(self, path: Path, name: str, subfolder: str = "shellmax") -> str:
        """Upload a file into ComfyUI's input dir; returns the value LoadImage/LoadAudio expect."""
        with path.open("rb") as f:
            r = await self._http.post(
                "/upload/image",
                files={"image": (name, f, "application/octet-stream")},
                data={"subfolder": subfolder, "type": "input", "overwrite": "true"},
                timeout=300,
            )
        r.raise_for_status()
        info = r.json()
        return f"{info['subfolder']}/{info['name']}" if info.get("subfolder") else info["name"]

    async def download_output(self, file_info: dict, dest: Path) -> Path:
        params = {"filename": file_info["filename"], "subfolder": file_info.get("subfolder", ""),
                  "type": file_info.get("type", "output")}
        dest.parent.mkdir(parents=True, exist_ok=True)
        async with self._http.stream("GET", "/view", params=params, timeout=600) as r:
            r.raise_for_status()
            with dest.open("wb") as f:
                async for chunk in r.aiter_bytes(1 << 20):
                    f.write(chunk)
        return dest

    # ------------------------------------------------------------------ websocket
    async def listen(
        self,
        on_message: Callable[[dict], Awaitable[None]],
        on_preview: Callable[[bytes, str], Awaitable[None]],
        stop: asyncio.Event,
    ) -> None:
        """Consume the ComfyUI websocket until `stop` is set, reconnecting as needed."""
        ws_url = self.base_url.replace("http", "ws", 1) + f"/ws?clientId={self.client_id}"
        while not stop.is_set():
            try:
                async with websockets.connect(ws_url, max_size=64 * 1024 * 1024, ping_interval=20) as ws:
                    log.info("connected to ComfyUI websocket")
                    while not stop.is_set():
                        raw = await ws.recv()
                        if isinstance(raw, bytes):
                            parsed = parse_binary(raw)
                            if parsed:
                                await on_preview(*parsed)
                        else:
                            await on_message(json.loads(raw))
            except (OSError, websockets.WebSocketException) as e:
                if not stop.is_set():
                    log.debug("websocket disconnected: %s", e)
                    await asyncio.sleep(1.5)


def parse_binary(raw: bytes) -> tuple[bytes, str] | None:
    """Returns (image bytes, mime) for preview frames."""
    if len(raw) < 8:
        return None
    event = struct.unpack(">I", raw[:4])[0]
    if event == PREVIEW_IMAGE:
        image_type = struct.unpack(">I", raw[4:8])[0]
        return raw[8:], "image/png" if image_type == 2 else "image/jpeg"
    if event == PREVIEW_IMAGE_WITH_METADATA:
        meta_len = struct.unpack(">I", raw[4:8])[0]
        meta = json.loads(raw[8:8 + meta_len] or b"{}")
        return raw[8 + meta_len:], meta.get("image_type", "image/jpeg")
    return None
