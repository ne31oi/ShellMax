"""Context for writing prompts for a masked edit of an existing clip."""

import re
import uuid
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator

from .. import settings
from ..db.models import Generation, MediaAsset, Upload, session
from ..media import library
from . import prompt
from .references import load_references


class MaskPromptRef(BaseModel):
    upload_id: str
    with_audio: Literal[False] = False


class MaskPromptIn(BaseModel):
    source_asset_id: int
    text: str = Field(min_length=1, max_length=40000)
    prompt: str = Field(default="", max_length=40000)
    refs: list[MaskPromptRef] = Field(default_factory=list, max_length=15)
    start: float = Field(default=0, ge=0, le=150)
    end: float = Field(gt=0, le=150)
    keep_audio: bool = True
    invert: bool = False
    target_hint: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def valid_fragment(self):
        if self.end <= self.start:
            raise ValueError("Выберите фрагмент в пределах клипа")
        if not self.text.strip():
            raise ValueError("Опишите, что заменить в выбранной области")
        return self


def mask_system(refs: list[prompt.RefInfo], duration: float, *, keep_audio: bool, invert: bool,
                has_audio: bool = True) -> str:
    area = "outside the mask" if invert else "inside the mask"
    sound = ("The original fragment audio is copied by the application. Write overall_soundscape: "
             "Preserve the original clip audio unchanged. Write non_diegetic_music: N/A. "
             "Do not invent an Audio label for the source soundtrack or add dialogue, music or effects."
             if keep_audio else "Audio will be generated. Describe sound only as requested by the user; "
             "do not invent dialogue or lyrics. The source soundtrack has no reference label.")
    if keep_audio and not has_audio:
        sound = ("The source clip is silent. Preserve silence in overall_soundscape; non_diegetic_music: N/A. "
                 "Do not add dialogue, music or effects and do not invent an Audio label for the source.")
    references = (prompt._refs_block(refs) if refs else
                  "No replacement references are attached. Picture, Video and Audio reference labels are forbidden. "
                  "The requested replacement is newly_generated; the unedited source content remains preserved.")
    return f"""Write a MiniMax H3 prompt for a MASKED EDIT of an existing video, not a new scene.

{prompt.SPEC_BLOCK}

=== MASKED EDIT ===
The edited fragment lasts exactly {duration:.6f} seconds. Change only {area}.
Preserve the original shot progression, camera position, lens perspective, framing, subject placement,
scale, original motion, timing, interactions and lighting. The unedited region uses original pixels.
Do not invent camera moves, cuts, poses, expressions, locations or events to fill the duration.
Describe the requested replacement as the final visible result, integrated into the original movement,
perspective, contacts, occlusions and light. Use the replacement reference for identity, appearance or
the object requested by the user; its pose, background and camera do not override the original clip.
When replacing a person/object, audit every section so the original appearance is not reintroduced.
retention_analysis must distinguish replaced appearance from preserved source motion and surroundings.
Source preview frames are CONTEXT ONLY, not generation references: assign them no Picture/Video labels.
Still previews reveal framing and appearance; they do not prove motion between frames.
Historical source-prompt descriptions are context, not observed facts or replacement identity.
{sound}

=== REPLACEMENT REFERENCES ===
{references}
Reference descriptions define the replacement's appearance only; preserve the source performance and camera.

{prompt.HONESTY}

{prompt.OUTPUT_CONTRACT}"""


async def prepare_mask_prompt(body: MaskPromptIn) -> tuple[str, str, list[Path], list[prompt.RefInfo]]:
    with session() as store:
        asset = store.get(MediaAsset, body.source_asset_id)
        if asset is None or asset.kind != "video":
            raise HTTPException(404, "Клип не найден")
        if body.end > float(asset.duration or 0) + 0.05:
            raise HTTPException(422, "Выберите фрагмент в пределах клипа")
        if not Path(asset.path).is_file():
            raise HTTPException(422, "Исходный клип не найден — добавьте его заново")
        if any(store.get(Upload, ref.upload_id) is None for ref in body.refs):
            raise HTTPException(404, "Референс не найден — выберите его заново")
        infos, images = load_references(store, body.refs)
        generation = store.get(Generation, asset.generation_id) if asset.generation_id else None
        original = str((generation.ui_params or {}).get("prompt", "")) if generation else ""
    # Historical labels belong to a different reference list and must never shift replacement labels.
    original = re.sub(r"<(?:Picture|Video|Audio)\s+\d+>|\{\{ref:[a-z0-9]+(?::audio)?\}\}",
                      "[historical reference]", original, flags=re.I)
    directory = settings.DATA_DIR / "assistant_tmp"
    directory.mkdir(parents=True, exist_ok=True)
    stamp = uuid.uuid4().hex[:12]
    previews = []
    times = sorted({body.start, max(body.start, body.end - 1 / 24)})
    for index, time in enumerate(times):
        path = directory / f"mask_{stamp}_{index}.jpg"
        try:
            await library.extract_frame(Path(asset.path), path, time)
        except RuntimeError:
            continue
        previews.append((path, time))
    context = [f"Source clip: {asset.name}. Selected interval: {body.start:.6f}–{body.end:.6f} seconds.",
               f"Selected object (user/SAM description, not a verified observation): {body.target_hint or '(not specified)'}."]
    if original:
        context += ["Historical source prompt (context only; replacement references take priority):", original[:12000]]
    if previews:
        context += ["Source previews follow the replacement-reference images. They have NO generation labels."]
        context += [f"Attached image {len(images) + index}: source preview at {time:.6f} s, context only."
                    for index, (_, time) in enumerate(previews, 1)]
    else:
        context += ["Source previews are unavailable. Do not claim to have viewed the source clip."]
    if body.prompt.strip():
        context += ["Current masked-edit prompt:", f"```text\n{body.prompt.strip()}\n```",
                    "Edit this prompt only as requested; return the full updated prompt."]
    context += ["User's replacement request:", body.text.strip(),
                "Return the complete H3 masked-edit prompt in the required text fence."]
    system = mask_system(infos, body.end - body.start,
                         keep_audio=body.keep_audio, invert=body.invert, has_audio=asset.has_audio)
    return system, "\n\n".join(context), images + [path for path, _ in previews], infos
