"""Concatenate trimmed timeline clips into one mp4 via ffmpeg."""

from __future__ import annotations

import logging
import tempfile
import uuid
from pathlib import Path

from fastapi import HTTPException
from sqlmodel import select

from .. import settings
from ..db.models import MediaAsset, session
from ..timeline_schema import TimelineDoc, parse_timeline, video_clips
from . import library

log = logging.getLogger("shellmax.timeline_export")

MIN_CLIP_S = 0.05


async def export_timeline(doc: TimelineDoc, assets_by_id: dict[int, MediaAsset], dest: Path) -> Path:
    clips = video_clips(doc)
    if not clips:
        raise HTTPException(400, "На таймлайне нет клипов")

    ffmpeg = library.ffmpeg_bin("ffmpeg")
    if not ffmpeg:
        raise HTTPException(500, "ffmpeg не найден в PATH")

    with tempfile.TemporaryDirectory(prefix="sm_tl_") as tmp:
        tmp_path = Path(tmp)
        segments: list[Path] = []
        for i, clip in enumerate(clips):
            asset = assets_by_id.get(clip.asset_id)
            if asset is None:
                raise HTTPException(400, f"Клип ссылается на отсутствующий файл #{clip.asset_id}")
            if asset.kind != "video":
                raise HTTPException(400, f"«{asset.name}» — не видео")
            dur = clip.out - clip.in_
            if dur < MIN_CLIP_S:
                raise HTTPException(400, f"Клип «{asset.name}» слишком короткий")
            seg = tmp_path / f"seg_{i:04d}.mp4"
            silent = doc.master_mute or clip.muted
            vol = 0.0 if silent else float(doc.master_volume)
            # Re-encode so concat is reliable across different sources.
            args = [
                ffmpeg, "-y", "-v", "error",
                "-ss", f"{clip.in_:.4f}",
                "-i", asset.path,
                "-t", f"{dur:.4f}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            ]
            if silent or vol <= 0.001:
                args += ["-an"]
            elif abs(vol - 1.0) > 0.01:
                args += ["-af", f"volume={vol:.4f}", "-c:a", "aac", "-b:a", "192k"]
            else:
                args += ["-c:a", "aac", "-b:a", "192k"]
            args += [
                "-movflags", "+faststart",
                "-avoid_negative_ts", "make_zero",
                str(seg),
            ]
            code, _, err = await library._run(*args)
            if code != 0 or not seg.exists():
                msg = (err or b"").decode("utf-8", "replace")[-400:]
                log.error("segment encode failed: %s", msg)
                raise HTTPException(500, f"Не удалось обрезать «{asset.name}»: {msg or 'ошибка ffmpeg'}")
            segments.append(seg)

        if len(segments) == 1:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(segments[0].read_bytes())
            return dest

        list_file = tmp_path / "concat.txt"
        # ffmpeg concat demuxer on Windows: forward slashes, escape single quotes in path
        lines = []
        for p in segments:
            path = p.resolve().as_posix().replace("'", "'\\''")
            lines.append(f"file '{path}'")
        list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
        dest.parent.mkdir(parents=True, exist_ok=True)
        args = [
            ffmpeg, "-y", "-v", "error",
            "-f", "concat", "-safe", "0",
            "-i", str(list_file),
            "-c", "copy",
            "-movflags", "+faststart",
            str(dest),
        ]
        code, _, err = await library._run(*args)
        if code != 0 or not dest.exists():
            msg = (err or b"").decode("utf-8", "replace")[-400:]
            log.error("concat failed: %s", msg)
            raise HTTPException(500, f"Не удалось склеить клипы: {msg or 'ошибка ffmpeg'}")
        return dest


async def export_project_timeline(project_id: int, timeline_raw: dict) -> MediaAsset:
    from ..jobs.queue import register_asset

    doc = parse_timeline(timeline_raw)
    with session() as s:
        rows = s.exec(select(MediaAsset).where(MediaAsset.project_id == project_id)).all()
        assets_by_id = {a.id: a for a in rows}

    dest = settings.MEDIA_DIR / f"montage_{uuid.uuid4().hex[:8]}.mp4"
    await export_timeline(doc, assets_by_id, dest)
    aid = await register_asset(dest, generation_id=None, source="exported", project_id=project_id, name="Монтаж")
    with session() as s:
        asset = s.get(MediaAsset, aid)
        assert asset is not None
        return asset
