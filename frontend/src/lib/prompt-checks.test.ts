import { describe, expect, it } from "vitest";
import type { RefItem, Upload } from "../api/types";
import { checkPrompt } from "./prompt-checks";
import { fromModelPrompt, replacePromptReferences, tagOf, toModelPrompt } from "./refs";
import { capturePrompt, normalizePromptLibrary, shotMarker } from "./prompt-presets";

const ref = (uid: string, kind: Upload["kind"], withAudio = false): RefItem => ({ uid, withAudio,
  upload: { id: uid, kind, orig_name: `${uid}.file`, name: uid, category: "other", description: "", duration: 3, width: 512, height: 512, has_audio: withAudio },
});
const complete = (detail = "[Shot 1] A person walks.") => `subject_definitions:\n<Subject 1> is a person.\nsummary:\nA walk.\nretention_analysis:\n<Subject 1>: newly_generated.\ndetailed_description:\n${detail}\nvisual_style:\nDaylight.\noverall_soundscape:\nSteps.\nnon_diegetic_music:\nN/A`;
const codes = (text: string, refs: RefItem[] = [], duration = 8) => checkPrompt(text, refs, duration).map((i) => i.code);

describe("prompt checks", () => {
  it("accepts complete prompts and free descriptions", () => {
    expect(codes(complete())).toEqual([]);
    expect(codes("Человек идёт по улице")).toEqual([]);
  });
  it("checks cut times in reference mode, including order and duration", () => {
    const issues = codes(complete("[Shot 1] Walk.\n[Shot 2] At 00:04.000, Stop.\n[Shot 3] at 00:03.000, Turn.\n[Shot 4] At 00:08.000, End."));
    expect(issues).toContain("cut-order");
    expect(issues).toContain("cut-duration");
    expect(codes(complete("[Shot 1] Walk.\n[Shot 2] At 00:03.000, Turn."))).toEqual([]);
  });
  it("checks dialogue nesting, language and closing order", () => {
    expect(codes(complete() + "\n<d><d>Hello</d>")).toContain("dialogue-nested");
    expect(codes(complete() + "\n<d>Hello")).toContain("dialogue-unclosed");
    expect(codes(complete() + "\n</d><d>[Russian] Привет</d>")).toContain("dialogue-order");
    expect(codes(complete() + "\n<d>Hello</d>")).toContain("dialogue-language");
  });
  it("does not mistake shot citations in retention for actual cuts", () => {
    expect(codes(complete().replace("newly_generated.", "newly_generated (appears in [Shot 1])."))).toEqual([]);
  });
  it("reports missing subjects and retention entries", () => {
    expect(codes(complete("[Shot 1] <Subject 2> walks."))).toContain("undefined-subject");
    expect(codes(complete().replace("<Subject 1>: newly_generated.", "N/A"))).toContain("missing-retention");
  });
  it("reports duplicate and misplaced sections", () => {
    expect(codes(complete() + "\nsummary:\nAnother.")).toContain("duplicate-section");
    expect(codes(complete() + "\nvisual_style:\nNight.")).toContain("section-order");
  });
  it("detects unresolved stored tokens before serialization removes them", () => {
    expect(codes("Look at {{ref:missing}}.")).toContain("missing-reference");
    expect(codes("Use <Picture 2>.", [ref("a", "image")])).toContain("unknown-reference");
    expect(codes(complete() + " {{ref:a}}", [ref("a", "image"), ref("b", "image")])).toContain("unused-reference");
  });
});

describe("native audio labels", () => {
  it("swaps references atomically and preserves soundtrack channels", () => {
    const refs = [ref("a", "video", true), ref("b", "video", true)];
    const result = replacePromptReferences("<Video 1> {{ref:b}} {{ref:a:audio}}", refs, "a", "b", true);
    expect(result.count).toBe(3);
    expect(toModelPrompt(result.prompt, refs)).toBe("<Video 2> <Video 1> <Audio 2>");
    expect(replacePromptReferences("{{ref:a}}", refs, "a", "a").count).toBe(0);
    expect(replacePromptReferences("{{ref:a:audio}}", [refs[0], { ...refs[1], withAudio: false }], "a", "b").count).toBe(0);
  });
  it("keeps video soundtracks ahead of standalone audio even when cards are interleaved", () => {
    const refs = [ref("song", "audio"), ref("video", "video", true), ref("photo", "image")];
    expect(tagOf(refs, "song")).toBe("Audio 2");
    expect(tagOf(refs, "video", "audio")).toBe("Audio 1");
    const source = "<Video 1> <Audio 1> <Audio 2> <Picture 1>";
    const stored = fromModelPrompt(source, refs);
    expect(stored).toContain("{{ref:video:audio}}");
    expect(toModelPrompt(stored, refs)).toBe(source);
    expect(codes(stored, refs)).toEqual([]);
    expect(codes(stored, refs.map((r) => ({ ...r, withAudio: false })))).toContain("missing-reference");
  });
  it("renumbers stable references when the soundtracks are reordered", () => {
    const a = ref("a", "video", true), b = ref("b", "video", true);
    expect(toModelPrompt("{{ref:a:audio}} {{ref:b:audio}}", [b, a])).toBe("<Audio 2> <Audio 1>");
  });
});

describe("saved prompts", () => {
  it("freezes edited file identity and reference tokens independently of the live form", () => {
    const live = { prompt: "{{ref:a}}", refs: [ref("a", "image")], aspect: "16:9", duration: 4, quality: "standard", look: "cinema", styles: [], cinematicTechniques: {} };
    live.refs[0].upload.source_id = "original";
    const frozen = capturePrompt(live);
    live.refs[0].upload.id = "changed";
    expect(frozen.refs[0].upload.id).toBe("a");
    expect(frozen.refs[0].upload.source_id).toBe("original");
    expect(normalizePromptLibrary([{ id: "p", name: "Scene", category: "scene", snapshot: frozen }])).toHaveLength(1);
    expect(normalizePromptLibrary([{ id: "broken" }, null])).toEqual([]);
  });
  it("formats fractional cut times and picks the next shot number", () => {
    expect(shotMarker("[Shot 1] Walk.", 2.125)).toBe("\n[Shot 2] At 00:02.125, ");
  });
});
