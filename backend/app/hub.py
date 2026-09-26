"""Broadcast of live events (generation updates, previews, engine state) to UI websockets."""

import asyncio
import json
import logging

from fastapi import WebSocket

log = logging.getLogger("shellmax.hub")


class Hub:
    def __init__(self):
        self._clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast(self, event: dict) -> None:
        if not self._clients:
            return
        text = json.dumps(event, default=str, ensure_ascii=False)
        dead = []
        for ws in list(self._clients):
            try:
                await asyncio.wait_for(ws.send_text(text), timeout=5)
            except Exception:  # noqa: BLE001 - any send failure means the client is gone
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)


hub = Hub()
