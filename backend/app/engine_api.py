"""Engine, meta, profiles, styles, filesystem."""

import logging
import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import services, settings
from .api_common import not_found, state
from .db.models import EngineProfileRow, Generation, StyleLora, kv_get, kv_set, select, session
from .fs import browse
from .jobs.estimator import estimate as estimate_time
from .workflow import enhance, face, interpolate, presets, quality as quality_cfg
from .workflow.camera import camera_presets
from .workflow.cinematography import cinematic_technique_presets
from .workflow.light import light_presets
from .workflow.look import look_presets
from .workflow.params import ASPECT_RATIOS, FPS, MAX_REFS, EngineProfile, frame_count

log = logging.getLogger("shellmax.engine_api")
router = APIRouter()

# ---------------------------------------------------------------- meta
@router.get("/meta")
def meta():
    d = settings.defaults()
    qp = quality_cfg.quality_presets()
    return {
        "fps": FPS,
        "aspects": [{"id": a, "ratio": list(r), "short": a.split(" ")[0]} for a, r in ASPECT_RATIOS.items()],
        "quality": [
            {
                "id": k,
                "label": v["label"],
                "megapixels": v["megapixels"],
                "scale": v["scale"],
                "workflow": quality_cfg.is_workflow_value(k, v),
                "resolutions": {a: presets.resolution_for(a, k) for a in ASPECT_RATIOS},
            }
            for k, v in qp.items()
        ],
        "duration": {"min": 1.0, "max": 20.0, "optimal": [5.0, 15.0]},
        "look": look_presets(),
        "camera": camera_presets(),
        "cinematic_technique": cinematic_technique_presets(),
        "light": light_presets(),
        "max_refs": MAX_REFS,
        "defaults": {**d["ui"], "look": "cinema", "camera": "auto", "light": "auto"},
        "face_strength": face.strength_presets(),
        "enhance_scale": enhance.scale_presets(),
        "enhance_strength": enhance.strength_presets(),
        "enhance_color": enhance.color_presets(),
        "interpolate_model": interpolate.model_presets(),
        "interpolate_multiplier": interpolate.multiplier_presets(),
        # Lets the UI wait for a real process swap on «Перезапустить всё»
        "pid": os.getpid(),
    }


# ---------------------------------------------------------------- quality presets (editable)
@router.get("/quality")
def get_quality():
    return {
        "presets": quality_cfg.quality_presets(),
        "workflow": quality_cfg.workflow_quality_presets(),
        "resolutions": {
            k: {a: presets.resolution_for(a, k) for a in ASPECT_RATIOS}
            for k in quality_cfg.PRESET_IDS
        },
    }


@router.put("/quality")
def put_quality(body: dict):
    try:
        presets_in = body.get("presets", body)
        saved = quality_cfg.save_quality_presets(presets_in)
    except (ValueError, TypeError, KeyError) as e:
        raise HTTPException(400, str(e)) from e
    return {
        "presets": saved,
        "workflow": quality_cfg.workflow_quality_presets(),
        "resolutions": {
            k: {a: presets.resolution_for(a, k) for a in ASPECT_RATIOS}
            for k in quality_cfg.PRESET_IDS
        },
    }


@router.post("/quality/reset")
def reset_quality():
    saved = quality_cfg.reset_quality_presets()
    return {
        "presets": saved,
        "workflow": quality_cfg.workflow_quality_presets(),
        "resolutions": {
            k: {a: presets.resolution_for(a, k) for a in ASPECT_RATIOS}
            for k in quality_cfg.PRESET_IDS
        },
    }


@router.get("/frames")
def frames(duration: float):
    n = frame_count(duration)
    return {"frames": n, "seconds": n / FPS}


@router.get("/estimate")
def estimate(aspect: str, quality: str, duration: float, profile_id: int | None = None):
    """{seconds, basis: exact|scaled|prior, samples} from this machine's finished jobs."""
    _, profile = services.get_profile(profile_id)
    res = presets.resolution_for(aspect, quality)["final"]
    return estimate_time(res[0] * res[1] * frame_count(duration), profile.pipeline)


# ---------------------------------------------------------------- sticky ui state
@router.get("/state/ui")
def get_ui_state():
    return kv_get("ui_last", {})


@router.put("/state/ui")
def put_ui_state(value: dict):
    kv_set("ui_last", value)
    return {"ok": True}


# ---------------------------------------------------------------- engine
@router.get("/engine")
def enginestate(request: Request):
    return state(request).engine.snapshot()


@router.post("/engine/{action}")
async def engine_action(action: str, request: Request):
    eng = state(request).engine
    if action == "start":
        await eng.start()
    elif action == "stop":
        await eng.stop()
    elif action == "restart":
        await eng.restart()
    else:
        raise HTTPException(404)
    return eng.snapshot()


async def _stop_all_services(st, *, interrupt_msg: str) -> None:
    """Mark active jobs interrupted and stop clips / assistant / queue / engine."""
    with session() as s:
        for g in s.exec(select(Generation).where(Generation.status.in_(["running", "queued"]))).all():
            g.status, g.error, g.error_kind = "error", interrupt_msg, "generic"
            s.add(g)
        s.commit()
    for stop in (
        getattr(st, "clips", None) and st.clips.stop,
        st.assistant.runner.stop,
        st.jobs.stop,
        st.engine.stop,
    ):
        if not stop:
            continue
        try:
            await stop()
        except Exception:  # noqa: BLE001 - still exit even if one piece fails
            log.exception("stop during system shutdown failed")


@router.post("/system/restart")
async def system_restart(request: Request):
    """Stop assistant + engine, exit the API process, and relaunch it (full ShellMax restart)."""
    import asyncio

    from .relaunch import spawn_relaunch

    st = state(request)

    async def _shutdown_and_relaunch() -> None:
        await asyncio.sleep(0.4)  # let the HTTP response reach the browser
        try:
            await _stop_all_services(st, interrupt_msg="Прервано перезапуском ShellMax")
        except Exception:  # noqa: BLE001
            log.exception("system restart cleanup failed; relaunching anyway")
        spawn_relaunch()
        os._exit(0)

    asyncio.create_task(_shutdown_and_relaunch())
    return {"ok": True}


@router.post("/system/shutdown")
async def system_shutdown(request: Request):
    """Stop assistant + engine and exit the API process without relaunching."""
    import asyncio

    st = state(request)

    async def _shutdown() -> None:
        await asyncio.sleep(0.4)  # let the HTTP response reach the browser
        try:
            await _stop_all_services(st, interrupt_msg="Прервано выключением ShellMax")
        except Exception:  # noqa: BLE001
            log.exception("system shutdown cleanup failed; exiting anyway")
        os._exit(0)

    asyncio.create_task(_shutdown())
    return {"ok": True}


_FALLBACK_OPTIONS = {"sampler": ["seeds_2", "euler", "euler_ancestral", "res_multistep"],
                     "scheduler": ["simple", "sgm_uniform", "karras", "exponential", "beta", "normal"]}
_options_cache: dict = {}


def _combo_options(spec) -> list[str]:
    """object_info combo spec: legacy [[...options]] or new ["COMBO", {"options": [...]}]."""
    first = spec[0] if spec else []
    if isinstance(first, list):
        return first
    if len(spec) > 1 and isinstance(spec[1], dict):
        return spec[1].get("options", [])
    return []


@router.get("/engine/options")
async def engine_options(request: Request):
    """Choices for expert dropdowns, read from the engine itself (falls back while it is down)."""
    if not _options_cache:
        client = state(request).engine.client
        try:
            ks = await client.object_info("KSamplerSelect")
            bs = await client.object_info("BasicScheduler")
            _options_cache["sampler"] = _combo_options(ks["KSamplerSelect"]["input"]["required"]["sampler_name"])
            _options_cache["scheduler"] = _combo_options(bs["BasicScheduler"]["input"]["required"]["scheduler"])
        except Exception:  # noqa: BLE001 - engine not ready yet
            return {**_FALLBACK_OPTIONS, "live": False}
    return {**_options_cache, "live": True}


@router.get("/engine/log")
def engine_log(request: Request, tail: int = 400):
    return {"lines": state(request).engine.log_tail(tail)}


# ---------------------------------------------------------------- profiles
@router.get("/profiles")
def list_profiles():
    with session() as s:
        rows = s.exec(select(EngineProfileRow).order_by(EngineProfileRow.id)).all()
    out = []
    for r in rows:
        prof = face.with_face_defaults(EngineProfile(**r.data))
        out.append({"id": r.id, "name": r.name, "is_default": r.is_default, "data": prof.model_dump(),
                    "problems": services.profile_problems(prof)})
    return out


class ProfileIn(BaseModel):
    data: EngineProfile
    is_default: bool = False


@router.post("/profiles")
def create_profile(body: ProfileIn):
    with session() as s:
        row = EngineProfileRow(name=body.data.name, data=body.data.model_dump(), is_default=body.is_default)
        s.add(row)
        s.commit()
        s.refresh(row)
        if body.is_default:
            _make_default(s, row.id)
    return {"id": row.id}


@router.put("/profiles/{pid}")
def update_profile(pid: int, body: ProfileIn):
    from sqlalchemy.orm.attributes import flag_modified

    with session() as s:
        row = s.get(EngineProfileRow, pid) or not_found()
        row.name = body.data.name
        row.data = body.data.model_dump()
        # JSON columns: reassignment alone is not always detected as dirty (same as kv_set).
        flag_modified(row, "data")
        s.add(row)
        s.commit()
        if body.is_default:
            _make_default(s, pid)
    return {"ok": True, "problems": services.profile_problems(body.data)}


@router.delete("/profiles/{pid}")
def delete_profile(pid: int):
    with session() as s:
        if len(s.exec(select(EngineProfileRow)).all()) <= 1:
            raise HTTPException(400, "Нельзя удалить единственный профиль")
        row = s.get(EngineProfileRow, pid) or not_found()
        s.delete(row)
        s.commit()
        if row.is_default:
            first = s.exec(select(EngineProfileRow)).first()
            _make_default(s, first.id)
    return {"ok": True}


@router.get("/profiles/workflow-defaults")
def workflow_defaults():
    return face.with_face_defaults(presets.default_profile()).model_dump()


def _make_default(s, pid: int) -> None:
    for r in s.exec(select(EngineProfileRow)).all():
        r.is_default = r.id == pid
        s.add(r)
    s.commit()


# ---------------------------------------------------------------- styles (creative LoRA library)
class StyleIn(BaseModel):
    name: str
    path: str
    default_strength: float = 1.0
    triggers: list[str] = []


@router.get("/styles")
def list_styles():
    with session() as s:
        return s.exec(select(StyleLora).order_by(StyleLora.name)).all()


@router.post("/styles")
def create_style(body: StyleIn):
    chk = browse.check(body.path)
    if not chk["exists"]:
        raise HTTPException(422, f"Файл не найден: {chk['path']}")
    with session() as s:
        row = StyleLora(name=body.name or Path(chk["path"]).stem, path=chk["path"],
                        default_strength=body.default_strength, triggers=[t.strip() for t in body.triggers if t.strip()])
        s.add(row)
        s.commit()
        s.refresh(row)
        return row


@router.put("/styles/{sid}")
def update_style(sid: int, body: StyleIn):
    with session() as s:
        row = s.get(StyleLora, sid) or not_found()
        row.name, row.path = body.name, browse.check(body.path)["path"]
        row.default_strength = body.default_strength
        row.triggers = [t.strip() for t in body.triggers if t.strip()]
        s.add(row)
        s.commit()
        return row


@router.delete("/styles/{sid}")
def delete_style(sid: int):
    with session() as s:
        row = s.get(StyleLora, sid) or not_found()
        s.delete(row)
        s.commit()
    return {"ok": True}


# ---------------------------------------------------------------- filesystem
@router.get("/fs/list")
def fs_list(path: str = ""):
    try:
        return browse.list_dir(path)
    except FileNotFoundError:
        raise HTTPException(404, f"Папка не найдена: {path}")


@router.get("/fs/check")
def fs_check(path: str):
    return browse.check(path)


@router.get("/models/scan")
def models_scan():
    return browse.scan_models()


