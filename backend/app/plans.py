"""Storyboard plans: wire timeline plans → generate jobs, audio overlap → refs."""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from . import settings
from .db.models import Generation, MediaAsset, Project, Upload, session
from .media import library
from .timeline_schema import (
    PlanBlock,
    TimelineClip,
    TimelineDoc,
    TimelineTrack,
    find_plan,
    normalize_timeline,
    parse_timeline,
)
from .workflow.params import RefSpec, StyleSpec, UIParams

log = logging.getLogger("shellmax.plans")

LIPSYNC_HINT = (
    "\n\nretention_analysis:\n"
    "<Audio 1>: reference — exact spoken words and timing drive lip movement with precise lip synchronization.\n"
)


def _clip_span(c: TimelineClip) -> tuple[float, float]:
    start = float(c.start if c.start is not None else 0.0)
    dur = max(0.0, c.out - c.in_)
    return start, start + dur


def overlapping_audio(
    doc: TimelineDoc, plan: PlanBlock,
) -> list[tuple[TimelineTrack, TimelineClip, float, float]]:
    p0, p1 = plan.start, plan.start + plan.duration
    out: list[tuple[TimelineTrack, TimelineClip, float, float]] = []
    for t in doc.tracks:
        if t.kind != "audio" or t.muted:
            continue
        if not plan.audio.get(t.id, True):
            continue
        for c in t.clips:
            if c.muted:
                continue
            a0, a1 = _clip_span(c)
            lo, hi = max(p0, a0), min(p1, a1)
            if hi - lo < 0.2:
                continue
            src_in = c.in_ + (lo - a0)
            src_out = c.in_ + (hi - a0)
            out.append((t, c, src_in, src_out))
    out.sort(key=lambda x: (x[0].id, x[1].start or 0))
    return out[:3]


async def _ensure_trimmed_upload(asset: MediaAsset, src_in: float, src_out: float) -> Upload:
    path = Path(asset.path)
    if not path.is_file():
        raise FileNotFoundError(f"Нет файла аудио: {asset.path}")
    key = f"plan-audio-{asset.id}-{src_in:.3f}-{src_out:.3f}"
    uid = str(uuid.uuid5(uuid.NAMESPACE_URL, key))
    with session() as s:
        existing = s.get(Upload, uid)
        if existing and Path(existing.path).is_file():
            return existing
    dest = settings.UPLOADS_DIR / f"{uid}.wav"
    settings.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    await library.edit_media(path, dest, "audio", crop=None, start=src_in, end=src_out)
    meta = await library.probe(dest)
    up = Upload(
        id=uid,
        kind="audio",
        orig_name=f"{asset.name} [{src_in:.2f}-{src_out:.2f}]",
        path=str(dest),
        duration=getattr(meta, "duration", None) or (src_out - src_in),
        width=None,
        height=None,
        has_audio=True,
        source_id=None,
        edit={"start": src_in, "end": src_out},
    )
    with session() as s:
        s.merge(up)
        s.commit()
        s.refresh(up)
        return up


async def build_ui_params(doc: TimelineDoc, plan: PlanBlock) -> UIParams:
    refs: list[RefSpec] = [
        RefSpec(kind=r.kind, upload_id=r.upload_id, with_audio=r.with_audio) for r in plan.refs
    ]
    audio_hits = overlapping_audio(doc, plan)
    with session() as s:
        for _track, clip, src_in, src_out in audio_hits:
            asset = s.get(MediaAsset, clip.asset_id)
            if not asset:
                continue
            up = await _ensure_trimmed_upload(asset, src_in, src_out)
            refs.append(RefSpec(kind="audio", upload_id=up.id, with_audio=False))

    prompt = plan.prompt.strip()
    if plan.lipsync and audio_hits and "<Audio" not in prompt:
        prompt = (prompt or "A short cinematic shot of the subject.") + LIPSYNC_HINT

    styles = [StyleSpec(style_id=st.style_id, strength=st.strength) for st in plan.styles]
    return UIParams(
        prompt=prompt or "A short cinematic shot.",
        refs=refs,
        aspect=plan.aspect,
        duration=plan.duration,
        quality=plan.quality,
        look=plan.look,
        light=plan.light,
        styles=styles,
        seed=None,
        variants=1,
        profile_id=None,
    )


_CAMEL = {
    "generation_id": "generationId",
    "draft_asset_id": "draftAssetId",
    "output_asset_id": "outputAssetId",
}


def patch_plan(project_id: int, plan_id: str, **fields) -> dict:
    """Mutate one plan inside Project.timeline (camelCase JSON)."""
    with session() as s:
        p = s.get(Project, project_id)
        if not p:
            raise ValueError("Проект не найден")
        tl = normalize_timeline(p.timeline)
        found = False
        for tr in tl["tracks"]:
            if tr.get("kind") != "plan":
                continue
            for pl in tr.get("plans") or []:
                if pl.get("id") != plan_id:
                    continue
                found = True
                for k, v in fields.items():
                    pl[_CAMEL.get(k, k)] = v
        if not found:
            raise ValueError(f"План {plan_id} не найден")
        p.timeline = tl
        s.add(p)
        s.commit()
        return tl


def sync_plan_from_generation(g: Generation) -> None:
    info = g.info or {}
    plan_id = info.get("plan_id")
    if not plan_id:
        return
    status_map = {
        "queued": "queued",
        "running": "running",
        "done": "done",
        "draft_only": "draft",
        "error": "error",
        "cancelled": "empty",
    }
    try:
        patch_plan(
            g.project_id,
            plan_id,
            status=status_map.get(g.status, "empty"),
            generation_id=g.id,
            draft_asset_id=g.draft_asset_id,
            output_asset_id=g.output_asset_id,
            error=g.error if g.status == "error" else None,
        )
    except Exception:  # noqa: BLE001
        log.exception("failed to sync plan %s from gen %s", plan_id, g.id)


async def create_plan_generations(project_id: int, plan_ids: list[str], mode: str) -> list[Generation]:
    from . import services

    with session() as s:
        proj = s.get(Project, project_id)
        if not proj:
            raise ValueError("Проект не найден")
        doc = parse_timeline(proj.timeline)

    draft_only = mode == "draft"
    created: list[Generation] = []
    for plan_id in plan_ids:
        hit = find_plan(doc, plan_id)
        if not hit:
            raise ValueError(f"План {plan_id} не найден")
        _track, plan = hit
        ui = await build_ui_params(doc, plan)
        gens = services.create_generations(ui, project_id)
        for g in gens:
            with session() as s:
                row = s.get(Generation, g.id)
                info = dict(row.info or {})
                info["plan_id"] = plan_id
                info["draft_only"] = draft_only
                row.info = info
                s.add(row)
                s.commit()
                s.refresh(row)
                created.append(row)
            patch_plan(
                project_id,
                plan_id,
                status="queued",
                mode=mode,
                generation_id=g.id,
                error=None,
            )
    return created
