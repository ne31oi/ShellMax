"""Storyboard plans: wire timeline plans → generate jobs, audio overlap → refs."""

from __future__ import annotations

import logging
import re
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

# Without <Audio N> in the prompt H3 ignores LoadAudio refs even if they are wired in the graph.
_SECTION_RE = re.compile(
    r"(?im)^([a-z_][a-z0-9_]*)\s*:\s*\n(.*?)(?=^[a-z_][a-z0-9_]*\s*:|\Z)",
    re.S,
)


def _split_prompt_sections(prompt: str) -> tuple[str, list[tuple[str, str]]]:
    """Preamble + ordered (name, body) sections (first occurrence of each name wins)."""
    matches = list(_SECTION_RE.finditer(prompt))
    if not matches:
        return prompt, []
    preamble = prompt[: matches[0].start()]
    seen: set[str] = set()
    sections: list[tuple[str, str]] = []
    for m in matches:
        name = m.group(1).lower()
        if name in seen:
            continue
        seen.add(name)
        sections.append((name, m.group(2).rstrip() + "\n"))
    return preamble, sections


def _join_prompt_sections(preamble: str, sections: list[tuple[str, str]]) -> str:
    parts = [preamble.rstrip()]
    for name, body in sections:
        parts.append(f"{name}:\n{body.rstrip()}\n")
    return "\n".join(p for p in parts if p).rstrip() + "\n"


def _upsert_retention_audio(body: str, n_audio: int, *, lipsync: bool) -> str:
    lines = [ln for ln in body.splitlines() if not re.match(r"^\s*<Audio\s+\d+>", ln)]
    extras: list[str] = []
    for i in range(1, n_audio + 1):
        if lipsync and i == 1:
            extras.append(
                f"<Audio {i}>: reference — exact spoken words and timing drive lip movement "
                "with precise lip synchronization."
            )
        else:
            extras.append(
                f"<Audio {i}>: fully_copy — exact soundtrack from the timeline audio track for this plan."
            )
    out = "\n".join([*lines, *extras]).rstrip() + "\n"
    return out


def apply_timeline_audio_to_prompt(prompt: str, n_audio: int, *, lipsync: bool) -> str:
    """Rewrite (not append) soundscape / retention so H3 actually follows A-track audio."""
    if n_audio <= 0:
        return prompt
    text = (prompt or "").strip() or "A short cinematic shot of the subject."
    preamble, sections = _split_prompt_sections(text)
    by_name = {n: i for i, (n, _) in enumerate(sections)}

    def set_section(name: str, body: str) -> None:
        if name in by_name:
            sections[by_name[name]] = (name, body if body.endswith("\n") else body + "\n")
        else:
            by_name[name] = len(sections)
            sections.append((name, body if body.endswith("\n") else body + "\n"))

    if "retention_analysis" in by_name:
        set_section(
            "retention_analysis",
            _upsert_retention_audio(sections[by_name["retention_analysis"]][1], n_audio, lipsync=lipsync),
        )
    else:
        set_section(
            "retention_analysis",
            _upsert_retention_audio("", n_audio, lipsync=lipsync),
        )

    set_section("overall_soundscape", "Only the exact supplied sound from <Audio 1>.\n")
    set_section("non_diegetic_music", "N/A — soundtrack is fully provided by <Audio 1>.\n")
    return _join_prompt_sections(preamble, sections)


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
            s.expunge(existing)
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
        # merge() returns the persistent instance; the original `up` stays detached
        row = s.merge(up)
        s.commit()
        s.refresh(row)
        return row


async def build_ui_params(doc: TimelineDoc, plan: PlanBlock) -> UIParams:
    # Image/video refs come from the plan; audio always from overlapping A-tracks
    # (re-enqueue must not stack duplicate LoadAudio refs from a previous patch).
    refs: list[RefSpec] = [
        RefSpec(kind=r.kind, upload_id=r.upload_id, with_audio=r.with_audio)
        for r in plan.refs
        if r.kind != "audio"
    ]
    audio_hits = overlapping_audio(doc, plan)
    # Resolve assets first, then trim outside the session — nested sessions + await
    # must not touch ORM instances still bound to an open Session.
    pending: list[tuple[MediaAsset, float, float]] = []
    with session() as s:
        for _track, clip, src_in, src_out in audio_hits:
            asset = s.get(MediaAsset, clip.asset_id)
            if not asset:
                continue
            s.expunge(asset)
            pending.append((asset, src_in, src_out))
    seen_audio: set[str] = set()
    for asset, src_in, src_out in pending:
        up = await _ensure_trimmed_upload(asset, src_in, src_out)
        if up.id in seen_audio:
            continue
        seen_audio.add(up.id)
        refs.append(RefSpec(kind="audio", upload_id=up.id, with_audio=False))

    prompt = plan.prompt.strip()
    # Stable reference tokens belong to the stored plan, model labels only to the submitted graph.
    counts = {"image": 0, "video": 0, "audio": 0}
    labels = {"image": "Picture", "video": "Video", "audio": "Audio"}
    for ref in refs:
        counts[ref.kind] += 1
        prompt = prompt.replace("{{ref:" + ref.upload_id + "}}", f"<{labels[ref.kind]} {counts[ref.kind]}>")
    if "{{ref:" in prompt:
        raise ValueError("Промпт ссылается на отсутствующий референс — проверьте карточки")
    n_audio = sum(1 for r in refs if r.kind == "audio")
    if n_audio:
        # Always rewrite soundscape/retention in place (appending a second section is ignored by H3).
        prompt = apply_timeline_audio_to_prompt(prompt, n_audio, lipsync=plan.lipsync)

    styles = [StyleSpec(style_id=st.style_id, strength=st.strength) for st in plan.styles]
    return UIParams(
        prompt=prompt or "A short cinematic shot.",
        refs=refs,
        aspect=plan.aspect,
        duration=min(150, plan.render_duration or plan.duration),
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

    created: list[Generation] = []
    # Same plan id can appear twice on a track after a bad duplicate — enqueue once.
    seen: set[str] = set()
    for plan_id in plan_ids:
        if plan_id in seen:
            continue
        seen.add(plan_id)
        hit = find_plan(doc, plan_id)
        if not hit:
            raise ValueError(f"План {plan_id} не найден")
        _track, plan = hit
        ui = await build_ui_params(doc, plan)
        # mode=draft → пресет «Черновик» из настроек; final → quality уже на плане (чип / селект).
        if mode == "draft":
            ui = ui.model_copy(update={"quality": "draft"})
        gens = services.create_generations(ui, project_id)
        for g in gens:
            with session() as s:
                row = s.get(Generation, g.id)
                info = dict(row.info or {})
                info["plan_id"] = plan_id
                info["plan_mode"] = mode
                info.pop("draft_only", None)
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
                prompt=plan.prompt,
                refs=[
                    {"kind": r.kind, "uploadId": r.upload_id, "withAudio": r.with_audio}
                    for r in ui.refs
                ],
                generation_id=g.id,
                error=None,
            )
    return created
