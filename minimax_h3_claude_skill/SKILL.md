---
name: "h3-singularity-prompt"
description: Write MiniMax H3 "Singularity" full-reference (image-to-video / Ref2VA) video prompts using the user's enhanced specification, with the fixed fields subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Use this skill whenever the user asks for a MiniMax H3 prompt, a Singularity prompt, a full-reference or reference-image video prompt, or wants a scene, action sequence, fight, VFX, explosion, magic effect, camera move, or multi-shot video idea turned into an H3 prompt or rewritten/improved into that structure. Trigger even if they only say "H3 prompt", "MiniMax prompt", or paste reference images with "make a video prompt", and even if the field names are not mentioned.
---

# H3 Singularity Prompt Writer

Turns a scene idea (plus optional reference images) into a MiniMax H3 full-reference prompt. The prompt must control action, camera, physics/VFX, lighting, audio and continuity with observable detail, not generic adjectives.

The complete spec is in `references/full-spec.md`. Read it (at least sections 7-10 and 16-18) before writing any non-trivial prompt. Templates for combat, explosions, magic and distant walking are in section 15.

If the separate `h3-prompt-writing` skill is also available, use it for non-reference modes (T2VA, I2VA, FL2VA, L2VA). Use this skill for full-reference work.

## Workflow

1. **Gather inputs.** Identify the idea, the reference images (and what each one supplies), the target duration, shot count, and whether there is dialogue or music. If something essential is missing (usually duration or what a reference is for), ask one short question; otherwise state the assumption in one line and proceed.
2. **Assign each reference a role** (see below).
3. **Lock subjects and environment** in `subject_definitions`.
4. **Write shots in playback order**, expanding each action into a causal chain, binding the camera to the action, and tying VFX to physical triggers.
5. **Add sound**, keeping diegetic sound and music separate.
6. **Run the checklist** and replace vague filler with observable detail.

## Output format

Keep these field names and this order exactly:

```text
id="x..."

subject_definitions:
<Subject 1>: [identity / appearance / clothing / distinctive features / reference relationship]
<Environment>: [location / architecture / terrain / atmosphere / lighting]
<Prop or VFX>: [appearance / material / persistent characteristics]

summary:
[Main action progression and final state, not just the premise]

retention_analysis:
[Reference -> Subject relationships and preservation level]

detailed_description:
[Shot 1] ...
[Shot 2] At 00:03.000, ...

overall_soundscape:
[Ambient + synchronized diegetic effects + dialogue]

non_diegetic_music:
[Style / intensity / progression, if applicable]
```

Deliver the prompt in a single code block in the chat (not a file) unless the user asks for a file. After it, add at most two lines: assumptions made, and any choice they may want to change.

## Rules that matter most

**Reference roles.** A reference image is not automatically a first frame.
- `<Subject N>` = entity or scene content that appears in the video. If a picture only supplies appearance, clothing, environment or style, attach it inside the Subject definition.
- `<Picture N>` standalone = only when it truly acts as a first frame, keyframe, last frame or composition anchor.
- If a reference should only affect part of the clip, say when it becomes active.
- Never leave a reference without a stated purpose.

**retention_analysis vocabulary.** Visual: `fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference`, `newly_generated`. Audio: `fully_copy`, `partially_copy`, `reference`, `weak_reference`.

**detailed_description.** Shot 1 has no timestamp; later shots use `At MM:SS.mmm,` when timing matters. Each shot answers: what is visible, where the subject is, starting state, continuous action, camera behavior, visual/physical feedback, what is heard.

**Actions are chains, not labels.** Preparation -> trigger -> acceleration -> primary action -> contact -> reaction -> recovery -> final state. Never write just "attacks" or "explodes". For distant characters, explicitly state they keep walking throughout the shot.

**Camera has five parts:** position/shot size + movement + direction + speed/amplitude + subject followed. Use named moves (track, push-in, pull-back, pan, tilt, orbit/arc, swoop, whip-pan, dive, barrel roll, handheld, locked-off). Never write "dynamic camera" alone. Tie the camera to the action.

**VFX = trigger + form + motion + environmental consequence.** Include physical feedback: cloth and hair reacting, dust from footsteps, recoil, light cast onto nearby surfaces.

**Lighting and materials:** state source, direction, contrast, reflections, atmosphere, and material response. "Cinematic", "epic" and "high quality" may accompany concrete detail but never replace it. Use motion blur only where the speed justifies it.

**Emotion becomes micro-actions:** gaze, brows, lips, breathing, posture, hands. Say what the character looks at.

**Dialogue:** stable speaker IDs `(S1)`, `(S2)`; format `(S1) speaks: "..."`. Keep dialogue in its original language; write the rest in English.

**Continuity:** keep screen direction, weapon/prop state, damage and dirt, clothing and identity consistent across shots. Carry persistent states forward.

**Anti-drift:** if a constraint must hold (a scale, a background, a composition), restate it in varied wording at each shot rather than once at the top.

**Do not** pack too many simultaneous actions into one shot, redefine a Subject differently across shots, or leave sound unsynchronized with visible events.

## Final checklist

- Every reference has an assigned purpose; Subject identities are stable.
- Every major action has a beginning, progression, reaction and end state.
- Camera is concrete and linked to the action; VFX have triggers and consequences.
- Lighting and material changes are observable.
- Sounds match visible events; speaker IDs are stable.
- Shots are continuous; distant actions that must continue are stated.
- Timeline matches the requested duration.
- No leftover generic adjectives standing in for visual information.
