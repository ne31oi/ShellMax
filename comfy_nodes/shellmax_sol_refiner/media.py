"""Retain every source frame and audio; cancellation never leaves a partial result."""
import math
import subprocess
import tempfile
from pathlib import Path


def pad_video(frames):
    if not frames:
        raise ValueError("Клип не содержит кадров")
    count = len(frames)
    frames.extend([frames[-1]] * (1 + math.ceil((count - 1) / 8) * 8 - count))
    return count


def read_video(path):
    import av
    import numpy as np
    import torch
    import comfy.model_management as mm
    with av.open(path) as source:
        fps = source.streams.video[0].average_rate
        if fps is None:
            raise ValueError("Не удалось определить частоту кадров клипа")
        frames = []
        for frame in source.decode(video=0):
            mm.throw_exception_if_processing_interrupted()
            frames.append(frame.to_ndarray(format="rgb24"))
    count = pad_video(frames)
    return torch.from_numpy(np.stack(frames)).float().div_(255), fps, count


def save_video(frames, fps, source_path, output):
    import av
    import imageio_ffmpeg
    import comfy.model_management as mm
    with tempfile.TemporaryDirectory(prefix="sol_", dir=output.parent) as work:
        silent = Path(work) / "silent.mp4"
        with av.open(str(silent), "w") as container:
            stream = container.add_stream("libx264", rate=fps)
            stream.width, stream.height = frames.shape[2], frames.shape[1]
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "17", "preset": "medium"}
            for image in frames:
                mm.throw_exception_if_processing_interrupted()
                frame = av.VideoFrame.from_ndarray((image.clamp(0, 1) * 255).byte().cpu().numpy(), format="rgb24")
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        with (Path(work) / "mux.log").open("w") as log:
            process = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-i", str(silent), "-i", source_path,
                "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-t", str(len(frames) / float(fps)), "-movflags", "+faststart", str(output)], stdout=log, stderr=log,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try:
                while process.poll() is None:
                    mm.throw_exception_if_processing_interrupted()
                    try:
                        process.wait(timeout=0.25)
                    except subprocess.TimeoutExpired:
                        pass
            except BaseException:
                process.kill()
                process.wait()
                raise
        if process.returncode:
            raise RuntimeError("Не удалось сохранить звук SoL-Refiner: " + (Path(work) / "mux.log").read_text(errors="replace")[-2000:])
