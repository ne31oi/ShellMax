"""Interruptible inference in an isolated module namespace."""
from pathlib import Path
import subprocess


def run_worker(command, log_path: Path, error: str):
    import comfy.model_management as mm

    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
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
    output = log_path.read_text(encoding="utf-8")
    if process.returncode:
        raise RuntimeError(error + ": " + output[-2200:])
    print(output)
