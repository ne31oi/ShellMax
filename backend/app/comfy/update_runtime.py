"""Filesystem and subprocess operations confined to ShellMax's portable engine."""

from __future__ import annotations

import ast
import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

from .compat import NEW_FORWARD, OLD_FORWARD

PROTECTED = {"torch", "torchvision", "torchaudio", "triton", "triton-windows",
             "sageattention", "flash-attn", "xformers", "nunchaku"}


def required_classes(installer: Path) -> set[str]:
    source = installer.read_text(encoding="utf-8-sig")
    section = re.search(r"\$RequiredClasses\s*=\s*@\(([\s\S]*?)\n\)", source)
    if not section:
        raise RuntimeError("Не найден список обязательных нод установщика")
    return set(re.findall(r"'([^']+)'", section[1]))


def validate_contracts(before: dict, after: dict, classes: set[str]) -> None:
    """Reject new mandatory sockets or changed positional outputs used by existing graphs."""
    for name in sorted(classes & before.keys() & after.keys()):
        old, new = before[name], after[name]
        old_input, new_input = old.get("input", {}), new.get("input", {})
        old_sockets = {**old_input.get("required", {}), **old_input.get("optional", {})}
        new_sockets = {**new_input.get("required", {}), **new_input.get("optional", {})}
        added = new_input.get("required", {}).keys() - old_input.get("required", {}).keys()
        removed = old_sockets.keys() - new_sockets.keys()
        if added or removed:
            raise RuntimeError(f"Изменился API ноды {name}: новые обязательные входы {sorted(added)}, удалённые входы {sorted(removed)}. Обновление несовместимо с прежними графами.")
        for socket in old_sockets.keys() & new_sockets.keys():
            a, b = old_sockets[socket][0], new_sockets[socket][0]
            if isinstance(a, str) and isinstance(b, str) and a != b:
                raise RuntimeError(f"Изменился тип входа {name}.{socket}: {a} → {b}")
        old_outputs = old.get("output", [])
        if new.get("output", [])[:len(old_outputs)] != old_outputs:
            raise RuntimeError(f"Изменились выходы ноды {name}; существующие связи графа несовместимы")


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def run(args: list[str], cwd: Path, *, log: Path | None = None, timeout: int = 120, allow_failure: bool = False) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "PYTHONIOENCODING": "utf-8"}
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    if log:
        with log.open("ab") as stream:
            result = subprocess.run(args, cwd=cwd, env=env, stdout=stream,
                                    stderr=subprocess.STDOUT, timeout=timeout, creationflags=flags)
        output = log.read_bytes()[-6000:].decode("utf-8", errors="replace")
    else:
        result = subprocess.run(args, cwd=cwd, env=env, capture_output=True,
                                timeout=timeout, creationflags=flags)
        output = result.stdout.decode("utf-8", errors="replace")
    if result.returncode and not allow_failure:
        detail = output if log else result.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"Команда {Path(args[0]).name} завершилась с ошибкой.\n{detail[-3000:]}")
    return output.rstrip("\r\n")


def git(repo: Path, *args: str) -> str:
    repo = repo.resolve()
    return run(["git", "-c", "safe.directory=*", "-C", str(repo), *args], repo)


def repo_path(core: Path, component: dict) -> Path:
    path = core if component["id"] == "core" else core / "custom_nodes" / component["id"]
    if not path.resolve().is_relative_to(core.resolve()):
        raise RuntimeError("Обновление за пределами собственного движка запрещено")
    return path


def managed_patch(repo: Path) -> Path | None:
    """Accept only our exact, reproducible KJ compatibility backport."""
    if repo.name != "ComfyUI-KJNodes":
        return None
    relative = "nodes/minimax_nodes.py"
    path = repo / relative
    if not path.is_file():
        return None
    original = git(repo, "show", f"HEAD:{relative}")
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(original)
    function = next((n for n in tree.body if isinstance(n, ast.FunctionDef)
                     and n.name == "minimax_block_lowmem_forward"), None)
    if function is None:
        return None
    segment = ast.get_source_segment(original, function)
    if ast.dump(ast.parse(segment)) != ast.dump(ast.parse(OLD_FORWARD)):
        return None
    expected = original.replace(segment, NEW_FORWARD, 1)
    return path if source.strip() == expected.strip() else None


def dirty_reason(repo: Path) -> str | None:
    # Keep untracked files visible: checkout must never overwrite local additions.
    changes = git(repo, "status", "--porcelain", "--untracked-files=all").splitlines()
    # Some upstream packs have no .gitignore; importing their nodes creates bytecode caches.
    changes = [line for line in changes if not (line.startswith("?? ") and
               ("__pycache__" in Path(line[3:]).parts or line[3:].endswith((".pyc", ".pyo"))))]
    patch = managed_patch(repo)
    if patch:
        changes = [line for line in changes if line[3:] != "nodes/minimax_nodes.py"]
    return "Есть локальные изменения. Сохраните их вне пакета и проверьте обновления снова." if changes else None


def stage_repo(repo: Path, revision: str, dest: Path) -> None:
    dest.mkdir(parents=True)
    archive = dest.parent / (dest.name + ".zip")
    git(repo, "archive", "--format=zip", f"--output={archive}", revision)
    with zipfile.ZipFile(archive) as zipped:
        for entry in zipped.infolist():
            target = (dest / entry.filename).resolve()
            if not target.is_relative_to(dest.resolve()):
                raise RuntimeError("Некорректный путь в архиве пакета")
        zipped.extractall(dest)


def validate_checkout(repo: Path, current: str, target: str) -> None:
    # Git protects untracked files, but normally overwrites ignored files on checkout.
    # A newly tracked path must never replace a local model, configuration, or other ignored data.
    additions = git(repo, "diff", "--name-only", "--diff-filter=A", current, target).splitlines()
    for relative in additions:
        path = repo / relative
        if path.exists() and not git(repo, "ls-files", "--", relative):
            raise RuntimeError(f"{repo.name}: обновление заменило бы локальный файл {relative}. Файл сохранён, установка остановлена.")


def installed(python: Path, log: Path) -> dict[str, str]:
    output = log.parent / "pip-installed.json"
    script = "import importlib.metadata as m,json,sys;json.dump({d.metadata['Name']:d.version for d in m.distributions() if d.metadata['Name']},open(sys.argv[1],'w',encoding='utf-8'))"
    run([str(python), "-s", "-c", script, str(output)], python.parent, log=log)
    try:
        return {normalize(k): v for k, v in json.loads(output.read_text(encoding="utf-8")).items()}
    finally:
        output.unlink(missing_ok=True)


def conflicts(python: Path) -> set[str]:
    output = run([str(python), "-s", "-m", "pip", "check"], python.parent, allow_failure=True)
    return {line for line in output.splitlines() if line and line != "No broken requirements found."}


def resolve_dependencies(python: Path, sources: list[Path], work: Path, log: Path) -> tuple[list[dict], Path]:
    versions = installed(python, log)
    constraints = work / "gpu-constraints.txt"
    constraints.write_text("\n".join(f"{name}=={versions[name]}" for name in sorted(PROTECTED & versions.keys())), encoding="utf-8")
    args = [str(python), "-s", "-m", "pip", "install", "--disable-pip-version-check",
            "--upgrade", "--upgrade-strategy", "only-if-needed", "-c", str(constraints)]
    count = 0
    for source in sources:
        requirements = source / "requirements.txt"
        if not requirements.is_file():
            continue
        # GPU packages remain installed; --upgrade must not try fetching their local CUDA builds.
        lines = requirements.read_text(encoding="utf-8").splitlines()
        safe = []
        for line in lines:
            match = re.match(r"\s*([A-Za-z0-9_.-]+)", line)
            if match and normalize(match[1]) in PROTECTED:
                # Preserve upstream GPU minimum versions as constraints too; reject incompatible updates.
                with constraints.open("a", encoding="utf-8") as stream:
                    stream.write("\n" + line)
                continue
            safe.append(line)
        filtered = source / "shellmax-update-requirements.txt"
        filtered.write_text("\n".join(safe), encoding="utf-8")
        args += ["-r", str(filtered)]
        count += 1
    if not count:
        return [], constraints
    report = work / "pip-report.json"
    run([*args, "--dry-run", "--report", str(report)], work, log=log, timeout=1200)
    changes = []
    for item in json.loads(report.read_text(encoding="utf-8"))["install"]:
        metadata = item["metadata"]
        name = normalize(metadata["name"])
        if name in PROTECTED:
            raise RuntimeError(f"Обновление требует замены {name}. Текущая CUDA-сборка сохранена; установка остановлена.")
        changes.append({"name": name, "current": versions.get(name), "latest": metadata["version"],
                        "url": item["download_info"]["url"]})
    return changes, constraints


def backup_python(python: Path, backup: Path) -> None:
    size = sum(p.stat().st_size for p in python.parent.rglob("*") if p.is_file())
    if shutil.disk_usage(backup.parent).free < size + 2 * 1024**3:
        raise RuntimeError(f"Недостаточно места для резервной копии Python. Освободите минимум {size / 1024**3 + 2:.1f} ГБ.")
    shutil.copytree(python.parent, backup / "python_embeded")


def apply_dependencies(python: Path, changes: list[dict], work: Path, log: Path) -> None:
    if not changes:
        return
    # Download all distributions before altering the environment; use the resolved versions.
    wheels = work / "wheels"
    wheels.mkdir()
    run([str(python), "-s", "-m", "pip", "download", "--disable-pip-version-check", "--no-deps",
         "--dest", str(wheels), *[c["url"] for c in changes]], work, log=log, timeout=1800)
    run([str(python), "-s", "-m", "pip", "install", "--disable-pip-version-check", "--no-deps",
         "--no-index", "--find-links", str(wheels), *[f"{c['name']}=={c['latest']}" for c in changes]],
        work, log=log, timeout=1800)


def restore_python(python: Path, backup: Path) -> None:
    source = backup / "python_embeded"
    failed = backup / "replaced-python"
    if not source.exists() and failed.exists() and python.is_file():
        return  # a previous restore completed the rename before the API process exited
    if not (source / "python.exe").is_file():
        raise RuntimeError("Резервная копия Python не завершена — автоматический откат недоступен")
    if not python.parent.exists():
        source.rename(python.parent)
        return
    # Renames on the same volume retain every DLL and remove newly installed packages too.
    if failed.exists():
        raise RuntimeError("Эта резервная копия уже восстановлена")
    python.parent.rename(failed)
    try:
        source.rename(python.parent)
    except Exception:
        failed.rename(python.parent)
        raise
