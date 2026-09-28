"""Frame-accurate video assembly with continuous timeline audio."""

import tempfile
from pathlib import Path

from fastapi import HTTPException

from .. import settings
from ..db.models import MediaAsset
from ..timeline_schema import TimelineDoc, video_clips
from . import library


async def export_timeline(doc: TimelineDoc, assets_by_id: dict[int, MediaAsset], dest: Path,
                          width=1440, height=832, fps=24, check=None, progress=None) -> Path:
    clips = video_clips(doc)
    if not clips:
        raise HTTPException(400, "На таймлайне нет клипов")
    ffmpeg = library.ffmpeg_bin("ffmpeg")
    if not ffmpeg:
        raise HTTPException(500, "ffmpeg не найден в PATH")
    width = doc.output_width or width
    height = doc.output_height or height
    fps = doc.output_fps or fps
    width, height = int(width) // 2 * 2, int(height) // 2 * 2

    async def run(args):
        if check:
            check()
        code, _, err = await library._run(ffmpeg, "-y", "-v", "error", *args)
        if check:
            check()
        if code:
            raise HTTPException(500, "Не удалось собрать видео: " + (err or b"").decode("utf-8", "replace")[-500:])

    def asset_for(aid):
        asset = assets_by_id.get(aid)
        if asset is None or not Path(asset.path).is_file():
            raise HTTPException(400, f"Отсутствует файл #{aid} — восстановите его или замените клип")
        return asset

    with tempfile.TemporaryDirectory(prefix="sm_tl_", dir=settings.DATA_DIR) as tmp:
        root = Path(tmp)
        segments, total_frames = [], 0
        for i, clip in enumerate(clips):
            asset = asset_for(clip.asset_id)
            if asset.kind != "video":
                raise HTTPException(400, f"«{asset.name}» — не видео")
            frames = round((clip.out - clip.in_) * fps)
            if frames < 1 or (asset.duration is not None and clip.out > asset.duration + 1 / fps):
                raise HTTPException(400, f"Неверные границы «{asset.name}» — выберите другой дубль или обрежьте кадр")
            duration = frames / fps
            total_frames += frames
            segment = root / f"seg_{i:04d}.mp4"
            args = ["-ss", str(clip.in_), "-i", asset.path]
            silent = doc.master_mute or clip.muted or not asset.has_audio
            if silent:
                args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
            args += ["-map", "0:v:0", "-map", "1:a:0" if silent else "0:a:0",
                     "-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p",
                     "-af", f"aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration={duration}",
                     "-t", str(duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                     "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(segment)]
            await run(args)
            segments.append(segment)
            if progress:
                await progress((i + 1) / (len(clips) + 3))
        listing = root / "concat.txt"
        listing.write_text("\n".join("file '" + p.as_posix().replace("'", "'\\''") + "'" for p in segments), encoding="utf-8")
        joined = root / "joined.mp4"
        await run(["-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(joined)])
        duration = total_frames / fps
        inputs = ["-i", str(joined)]
        filters, mix = [], ["[0:a]"]
        audio_tracks = [t for t in doc.tracks if t.kind == "audio" and not t.muted]
        solo = [t for t in audio_tracks if t.solo]
        if solo:
            audio_tracks = solo
        if not doc.master_mute:
            for track in audio_tracks:
                for clip in track.clips:
                    if clip.muted or (clip.start or 0) >= duration:
                        continue
                    asset = asset_for(clip.asset_id)
                    if not asset.has_audio and asset.kind != "audio":
                        continue
                    idx = len(mix)
                    inputs += ["-i", asset.path]
                    delay_samples = round((clip.start or 0) * 48000)
                    label = f"music{idx}"
                    filters.append(f"[{idx}:a]atrim=start={clip.in_}:end={clip.out},asetpts=PTS-STARTPTS,"
                                   f"aresample=48000,aformat=channel_layouts=stereo,adelay={delay_samples}S:all=1[{label}]")
                    mix.append(f"[{label}]")
        filters.append("".join(mix) + f"amix=inputs={len(mix)}:duration=longest:normalize=0,volume={doc.master_volume},apad,atrim=duration={duration}[sound]")
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Separate audio evaluation avoids FFmpeg's shared-input filter backpressure on long edits.
        soundtrack = root / "soundtrack.wav"
        await run([*inputs, "-filter_complex", ";".join(filters), "-map", "[sound]", "-vn",
                   "-t", str(duration), "-c:a", "pcm_s16le", str(soundtrack)])
        await run(["-i", str(joined), "-i", str(soundtrack), "-map", "0:v:0", "-map", "1:a:0",
                   "-vf", f"setpts=N/({fps}*TB)",
                   "-t", str(duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                   "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(dest)])
    return dest
