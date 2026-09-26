"""Assistant jobs (compose / face prompt) with VRAM arbitration against video generation.

Arbitration (studio vram-arbiter.ts): the assistant and MiniMax never share the GPU -
  * a video job running or queued -> assistant refuses (409);
  * before loading the LLM, ComfyUI unloads its models (POST /free) and we wait for VRAM;
  * before a video job is submitted, a running answer finishes and the LLM is stopped.
"""

import asyncio
import base64
import json
import logging
from collections.abc import AsyncIterator
from pathlib import Path

import httpx

from ..comfy.client import ComfyClient
from . import config
from .downloader import downloads
from .prompt import extract_prompt
from .registry import CHOICES, FILES
from .runner import LLM_URL, LlmRunner

log = logging.getLogger("shellmax.llm")


class AssistantBusy(Exception):
    pass


class AssistantService:
    def __init__(self, comfy: ComfyClient, jobs_busy, on_models_freed=None):
        self.runner = LlmRunner()
        self.comfy = comfy
        self._jobs_busy = jobs_busy  # () -> bool: a video job is running or queued
        self._on_models_freed = on_models_freed  # the next video job will be a cold start
        self.active = 0  # answers in flight
        self._cancel: asyncio.Event | None = None

    # ------------------------------------------------------------------ status
    def status(self) -> dict:
        s = config.load()
        choice = CHOICES[s.model]
        files = [downloads.status(fid) for fid in choice.all_files()]
        return {
            "model": s.model, "label": choice.label,
            "ready": all(f["status"] == "ready" for f in files),
            "files": files,
            "total_bytes": sum(f["total"] or 0 for f in files),
            "received_bytes": sum(f["received"] or 0 for f in files),
            "downloading": any(f["status"] == "downloading" for f in files),
            "running": self.runner.running(), "starting": self.runner.starting, "busy": self.active > 0,
        }

    def busy(self) -> bool:
        return self.active > 0 or self.runner.starting

    # ------------------------------------------------------------------ generation side of the arbiter
    async def release_for_generation(self) -> None:
        """Called by the job queue right before a video job goes to ComfyUI."""
        while self.busy():
            await asyncio.sleep(0.5)
        if self.runner.running():
            log.info("unloading the assistant before video generation")
            await self.runner.stop()

    def precheck(self) -> None:
        """Raise AssistantBusy (-> HTTP 409) before a stream is opened."""
        if self._jobs_busy():
            raise AssistantBusy("Идёт генерация видео — ассистент будет доступен, когда она закончится")
        if self.active:
            raise AssistantBusy("Ассистент уже пишет — дождитесь окончания")

    def cancel(self) -> None:
        if self._cancel:
            self._cancel.set()

    # ------------------------------------------------------------------ one answer
    async def stream(self, system: str, user_text: str, images: list[Path]) -> AsyncIterator[dict]:
        """Yields {"stage"}, {"delta"}, then {"done", "prompt"} or {"error"}."""
        s = config.load()
        choice = CHOICES[s.model]
        if not all(FILES[f].ready() for f in choice.all_files()):
            yield {"error": "model_missing"}
            return
        if self._jobs_busy() or self.active:
            yield {"error": "Ассистент сейчас недоступен — идёт генерация видео или другой ответ"}
            return

        self.active += 1
        self._cancel = cancel = asyncio.Event()
        text = ""
        try:
            if not self.runner.running() or self.runner.model != s.model:
                yield {"stage": "loading"}
                await self._free_comfy(choice)
            await self.runner.ensure(s)
            self.runner.touch()
            yield {"stage": "writing"}

            content: list[dict] = [{"type": "text", "text": user_text}]
            for img in images:
                uri = await asyncio.to_thread(_image_data_uri, img)
                if uri:
                    content.append({"type": "image_url", "image_url": {"url": uri}})
            messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
            smp = choice.sampling
            if s.sampling_override:
                smp = type(smp)(s.temperature, s.top_p, s.top_k, s.min_p, s.presence_penalty,
                                s.frequency_penalty, s.repeat_penalty)
            input_tokens = int(len(system + user_text) * 0.4) + 384 * len(images)  # studio estimate
            body = {
                "messages": messages, "stream": True,
                "max_tokens": max(256, min(s.max_output_tokens, s.context_size - input_tokens - 128)),
                # studio: thinking off at template level (the fork ignores --reasoning-budget 0)
                "chat_template_kwargs": {"enable_thinking": False},
                "temperature": smp.temperature, "top_p": smp.top_p, "top_k": smp.top_k, "min_p": smp.min_p,
                "presence_penalty": smp.presence_penalty, "frequency_penalty": smp.frequency_penalty,
                "repeat_penalty": smp.repeat_penalty,
            }
            async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10)) as client:
                async with client.stream("POST", f"{LLM_URL}/v1/chat/completions", json=body) as r:
                    if r.status_code != 200:
                        raise RuntimeError(f"Ассистент ответил ошибкой {r.status_code}: {(await r.aread())[:300]!r}")
                    async for line in r.aiter_lines():
                        if cancel.is_set():
                            break
                        if not line.startswith("data: "):
                            continue
                        payload = line[6:]
                        if payload == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                        except ValueError:
                            continue
                        delta = (chunk.get("choices") or [{}])[0].get("delta", {}).get("content")
                        if delta:  # reasoning_content (if any) is dropped, as in the studio
                            text += delta
                            self.runner.touch()
                            yield {"delta": delta}
            yield {"done": True, "prompt": extract_prompt(text), "cancelled": cancel.is_set()}
        except Exception as e:  # noqa: BLE001 - shown to the user
            log.exception("assistant failed")
            yield {"error": str(e)}
        finally:
            self.active -= 1
            self._cancel = None
            self.runner.touch()

    async def _free_comfy(self, choice) -> None:
        """Ask ComfyUI to drop its models and wait until the GPU has room for the LLM."""
        need_mb = (FILES[choice.model].size + (FILES[choice.mmproj].size if choice.mmproj else 0)) / 2**20 + 1500
        try:
            await self.comfy.free_models()
        except Exception:  # noqa: BLE001 - engine not running: nothing to free
            return
        if self._on_models_freed:
            self._on_models_freed()
        last = None
        for _ in range(30):
            try:
                dev = (await self.comfy.system_stats())["devices"][0]
                free_mb = dev["vram_free"] / 2**20
            except Exception:  # noqa: BLE001
                return
            if free_mb >= need_mb or (last is not None and abs(free_mb - last) < 64):
                return
            last = free_mb
            await asyncio.sleep(1)


def _image_data_uri(path: Path) -> str | None:
    """512px JPEG q80, as the studio sends reference images (keeps vision tokens low)."""
    import cv2
    import numpy as np

    try:
        img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return None
        h, w = img.shape[:2]
        scale = min(1.0, 512 / max(h, w))
        if scale < 1:
            img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode() if ok else None
    except Exception:  # noqa: BLE001
        return None
