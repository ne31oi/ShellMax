"""Relaunch the ShellMax backend process after a clean shutdown (Windows)."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

log = logging.getLogger("shellmax.relaunch")

# Windows process flags: detach so the helper outlives us; no flash console.
_DETACHED = 0x00000008  # DETACHED_PROCESS
_NEW_GROUP = 0x00000200  # CREATE_NEW_PROCESS_GROUP
_NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW
_FLAGS = _DETACHED | _NEW_GROUP | _NO_WINDOW


def spawn_relaunch() -> None:
    """Start a tiny helper that waits for this PID to exit, then runs `python -m app.main` again.

    Must not use os.kill(pid, 0) on Windows — that terminates the process.
    WaitForSingleObject(SYNCHRONIZE) waits until we actually exit.
    """
    backend_dir = str(Path(__file__).resolve().parents[1])  # …/backend
    exe = sys.executable
    pid = os.getpid()
    # Compact -c script: no PowerShell, no temp file, no UTF-8 BOM issues.
    script = (
        "import ctypes,os,subprocess;"
        f"p={pid};"
        "k=ctypes.windll.kernel32;"
        "h=k.OpenProcess(0x100000,False,p);"
        "h and (k.WaitForSingleObject(h,180000),k.CloseHandle(h));"
        "e=dict(os.environ);e.pop('SHELLMAX_OPEN_BROWSER',None);"
        f"subprocess.Popen([{exe!r},'-m','app.main'],cwd={backend_dir!r},env=e,"
        f"creationflags={_FLAGS})"
    )
    log.info("scheduling relaunch of %s -m app.main (cwd=%s)", exe, backend_dir)
    subprocess.Popen([exe, "-c", script], creationflags=_FLAGS, close_fds=True)
