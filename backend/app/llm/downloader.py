"""Downloads the assistant engine and models with resume and progress (studio model-downloader.ts)."""

import asyncio
import logging
import time
import zipfile
from pathlib import Path

import httpx

from ..hub import hub
from .registry import FILES, FileDef

log = logging.getLogger("shellmax.llm.download")


class Downloads:
    def __init__(self):
        self.state: dict[str, dict] = {}  # id -> {status, received, total, error}
        self._tasks: dict[str, asyncio.Task] = {}
        self._last_push = 0.0

    def status(self, file_id: str) -> dict:
        f = FILES[file_id]
        if file_id in self._tasks and not self._tasks[file_id].done():
            return {"id": file_id, "label": f.label, **self.state[file_id]}
        if f.ready():
            return {"id": file_id, "label": f.label, "status": "ready", "received": f.size, "total": f.size}
        prev = self.state.get(file_id, {})
        if prev.get("status") == "error":
            return {"id": file_id, "label": f.label, **prev}
        part = _part_path(f)
        got = part.stat().st_size if part.exists() else 0
        return {"id": file_id, "label": f.label, "status": "missing", "received": got, "total": f.size}

    def start(self, file_ids: list[str]) -> None:
        for fid in file_ids:
            if FILES[fid].ready() or (fid in self._tasks and not self._tasks[fid].done()):
                continue
            self.state[fid] = {"status": "downloading", "received": 0, "total": FILES[fid].size, "error": None}
            self._tasks[fid] = asyncio.create_task(self._download(FILES[fid]))

    async def _push(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_push < 0.5:
            return
        self._last_push = now
        await hub.broadcast({"type": "assistant_download", "files": {fid: self.status(fid) for fid in self.state}})

    async def _download(self, f: FileDef) -> None:
        part = _part_path(f)
        part.parent.mkdir(parents=True, exist_ok=True)
        st = self.state[f.id]
        try:
            for attempt in range(4):
                try:
                    await self._fetch(f, part, st)
                    break
                except (httpx.HTTPError, OSError) as e:
                    if attempt == 3:
                        raise
                    log.warning("%s: %s - retrying", f.id, e)
                    await asyncio.sleep(3 * (attempt + 1))
            if f.is_zip:
                await asyncio.to_thread(_extract, part, f)
                part.unlink(missing_ok=True)
            else:
                part.replace(f.dest)
            if not f.ready():
                raise RuntimeError("файл скачан не полностью")
            st.update(status="ready", received=st["total"])
        except Exception as e:  # noqa: BLE001 - surfaced to the UI
            log.exception("download %s failed", f.id)
            st.update(status="error", error=str(e))
        await self._push(force=True)

    async def _fetch(self, f: FileDef, part: Path, st: dict) -> None:
        have = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(60, connect=20)) as client:
            async with client.stream("GET", f.url, headers=headers) as r:
                if r.status_code == 416:  # already complete
                    return
                r.raise_for_status()
                if have and r.status_code != 206:  # server ignored the range: start over
                    have = 0
                total = int(r.headers.get("content-length", 0)) + have
                st.update(total=total or f.size, received=have)
                with part.open("ab" if have else "wb") as out:
                    async for chunk in r.aiter_bytes(1 << 20):
                        out.write(chunk)
                        st["received"] += len(chunk)
                        await self._push()


def _part_path(f: FileDef) -> Path:
    if f.is_zip:
        return f.dest / f"{f.id}.zip.part"
    return f.dest.with_name(f.dest.name + ".part")


def _extract(archive: Path, f: FileDef) -> None:
    """Only the listed members, flattened into dest (studio extractFiles)."""
    wanted = set(f.extract)
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            name = Path(info.filename).name
            if name in wanted:
                (f.dest / name).write_bytes(z.read(info))
    missing = [n for n in f.extract if not (f.dest / n).exists()]
    if missing:
        raise RuntimeError(f"в архиве нет файлов: {', '.join(missing)}")


downloads = Downloads()
