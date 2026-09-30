import { describe, expect, it } from "vitest";
import catalog from "./catalogIds.json";
import { reconcileTechniques, resetDemo } from "./reconcile";
import { allTechniqueIds, clearDemoProfileCache, getDemoProfile } from "./registry";
import { compositionFingerprint } from "./registry/composition";
import { subjectDistance } from "./registry/framing";
import {
  isDollyOnly,
  isZoomOnly,
  sampleCamera,
  sampleFrame,
  subjectAngularSize,
} from "./sample";
import { CAT } from "./types";

describe("cinema preview registry", () => {
  it("covers every catalog technique id", () => {
    clearDemoProfileCache();
    const ids = allTechniqueIds().sort();
    const catalogIds = catalog.map((r) => r.id).sort();
    expect(ids).toEqual(catalogIds);
    expect(ids).toHaveLength(155);
    for (const id of ids) {
      const profile = getDemoProfile(id);
      expect(profile).not.toBeNull();
      expect(profile!.id).toBe(id);
      // Angle never owns framing / focal length.
      if (profile!.category === CAT.angle) {
        expect(profile!.framing).toBeUndefined();
        expect(profile!.focalMm).toBeUndefined();
      }
      if (profile!.category !== CAT.framing) {
        expect(profile!.framing).toBeUndefined();
      }
      if (profile!.category !== CAT.optics) {
        expect(profile!.focalMm).toBeUndefined();
      }
    }
  });
});

describe("reconcileTechniques", () => {
  it("resets to static full-body soft key defaults", () => {
    const demo = resetDemo();
    expect(demo.framing).toBe("full");
    expect(demo.path).toBe("hold");
    expect(demo.support).toBe("tripod");
    expect(demo.start.fov).toBeCloseTo(demo.end.fov, 5);
    expect(demo.light.keyAzimuth).toBe(45);
    expect(demo.light.keySoftness).toBeGreaterThan(0.5);
    expect(demo.sourceIds).toEqual([]);
  });

  it("applies genre as base then lets explicit light win", () => {
    const { demo } = reconcileTechniques(["t14_1", "t7_8"]);
    expect(demo.post.grade).toBe("mono");
    expect(demo.light.fillIntensity).toBeGreaterThan(1);
    expect(demo.sourceIds).toContain("t14_1");
    expect(demo.sourceIds).toContain("t7_8");
  });

  it("flags macro + full body as incompatible", () => {
    const { conflict } = reconcileTechniques(["t5_12", "t3_5"]);
    expect(conflict).not.toBeNull();
    expect(conflict!.reason.toLowerCase()).toContain("макро");
    expect(["t5_12", "t3_5"]).toContain(conflict!.preferSoloId);
  });

  it("keeps framing from крупность while motion may animate away", () => {
    const { demo } = reconcileTechniques(["t3_9", "t2_3"]);
    expect(demo.framing).toBe("cu");
    expect(demo.end.pos.z).not.toBe(demo.start.pos.z);
  });

  it("does not let ракурс rewrite крупность", () => {
    const pairs: Array<[string, string]> = [
      ["t3_9", "t4_1"],
      ["t3_9", "t4_2"],
      ["t3_9", "t4_3"],
      ["t3_9", "t4_4"],
      ["t3_9", "t4_5"],
      ["t3_9", "t4_6"],
      ["t3_9", "t4_8"],
      ["t3_9", "t4_9"],
      ["t3_9", "t4_10"],
      ["t3_5", "t4_2"],
      ["t3_1", "t4_3"],
    ];
    for (const [framingId, angleId] of pairs) {
      const alone = reconcileTechniques([framingId]).demo;
      const combo = reconcileTechniques([framingId, angleId]).demo;
      expect(combo.framing).toBe(alone.framing);
      // Subject distance (крупность crop) must stay — angle only orbits.
      expect(subjectDistance(combo.start)).toBeCloseTo(subjectDistance(alone.start), 5);
      expect(combo.start.fov).toBeCloseTo(alone.start.fov, 5);
    }
  });

  it("stacks крупность + ракурс + оптика into one camera", () => {
    const aloneCu = reconcileTechniques(["t3_9"]).demo;
    const aloneLow = reconcileTechniques(["t4_2"]).demo;
    const aloneTele = reconcileTechniques(["t5_6"]).demo;
    const { demo } = reconcileTechniques(["t3_9", "t4_2", "t5_6"]);

    expect(demo.framing).toBe("cu");
    expect(demo.sourceIds).toEqual(["t3_9", "t4_2", "t5_6"]);

    // Optics FOV (85mm) wins.
    expect(demo.start.fov).toBeCloseTo(aloneTele.start.fov, 5);
    expect(demo.start.fov).toBeLessThan(aloneCu.start.fov);

    // Low angle: below look target, but distance matches CU+85mm crop.
    expect(demo.start.pos.y).toBeLessThan(demo.start.lookAt.y);
    const cuTele = reconcileTechniques(["t3_9", "t5_6"]).demo;
    expect(subjectDistance(demo.start)).toBeCloseTo(subjectDistance(cuTele.start), 5);

    // Not a full-body low-angle distance.
    expect(subjectDistance(demo.start)).toBeLessThan(subjectDistance(aloneLow.start));
  });

  it("keeps крупность when POV is selected", () => {
    const { demo } = reconcileTechniques(["t3_9", "t4_7"]);
    expect(demo.framing).toBe("cu");
    // POV may re-seat the camera, but must not claim mcu framing or change optics FOV.
    expect(demo.start.fov).toBeCloseTo(reconcileTechniques(["t3_9"]).demo.start.fov, 5);
  });

  it("lets optics change FOV without stealing framing", () => {
    const { demo } = reconcileTechniques(["t3_4", "t5_2"]);
    expect(demo.framing).toBe("wide");
    expect(demo.start.fov).toBeGreaterThan(reconcileTechniques(["t3_4"]).demo.start.fov);
  });

  it("composes light + color + atmosphere on top of camera stack", () => {
    const { demo } = reconcileTechniques(["t3_8", "t4_2", "t5_6", "t7_15", "t9_4", "t12_2"]);
    expect(demo.framing).toBe("mcu");
    expect(demo.start.pos.y).toBeLessThan(demo.start.lookAt.y);
    expect(demo.post.grade).toBe("tealOrange");
    expect(demo.scene.precip).toBe("fog");
    expect(demo.light.keyAzimuth).toBe(45);
  });

  it("macro alone soft-falls back to insert; explicit framing still wins", () => {
    expect(reconcileTechniques(["t5_12"]).demo.framing).toBe("insert");
    expect(reconcileTechniques(["t3_9", "t5_12"]).demo.framing).toBe("cu");
  });

  it("makes each composition kind visually distinct from the catalog", () => {
    const kinds = [
      "thirds", "center", "symmetry", "asymmetry", "leading", "vanishing", "frameInFrame",
      "negative", "foreground", "layered", "weight", "figureGround", "tonal", "leadRoom",
      "shortSiding", "dirty", "clean",
    ] as const;
    const prints = kinds.map((k) => compositionFingerprint(k));
    expect(new Set(prints).size).toBe(kinds.length);

    // Spot-check catalog semantics
    const thirds = reconcileTechniques(["t6_1"]).demo;
    const center = reconcileTechniques(["t6_2"]).demo;
    const lead = reconcileTechniques(["t6_14"]).demo;
    const short = reconcileTechniques(["t6_15"]).demo;
    const frame = reconcileTechniques(["t6_7"]).demo;
    const dirty = reconcileTechniques(["t6_16"]).demo;
    const clean = reconcileTechniques(["t6_17"]).demo;

    expect(Math.abs(thirds.scene.heroOffset!.x)).toBeGreaterThan(0.2);
    expect(center.scene.heroOffset!.x).toBe(0);
    expect(center.scene.hideDepthMarkers).toBe(true);
    // 6.14 space in front of gaze vs 6.15 face toward nearest edge
    expect(lead.scene.heroOffset!.x).toBeLessThan(0);
    expect(lead.scene.headYawDeg!).toBeGreaterThan(0);
    expect(short.scene.heroOffset!.x).toBeGreaterThan(0);
    expect(short.scene.headYawDeg!).toBeGreaterThan(0);
    // 6.7 door/window/arch as second frame
    expect(frame.scene.doorway).toBe(true);
    expect(frame.scene.doorwayClose).toBe(true);
    // 6.16 edges blocked vs 6.17 clean edges
    expect(dirty.scene.dirtyOccluder).toBe(true);
    expect(clean.scene.hideDepthMarkers).toBe(true);
    expect(clean.scene.fgProp).toBe("none");
  });
});

describe("sampleFrame determinism", () => {
  it("returns identical poses for the same scrub position", () => {
    const { demo } = reconcileTechniques(["t2_17", "t7_15", "t8_3"]);
    const a = sampleFrame(demo, 0.37);
    const b = sampleFrame(demo, 0.37);
    expect(a).toEqual(b);
    expect(sampleCamera(demo, 0).pos).toEqual(demo.start.pos);
  });

  it("freeze holds the pose after freezeAt", () => {
    const { demo } = reconcileTechniques(["t10_4"]);
    const frozen = sampleFrame(demo, 0.9);
    const atMark = sampleFrame(demo, demo.freezeAt!);
    expect(frozen.camera).toEqual(atMark.camera);
    expect(frozen.timeScale).toBe(0);
  });
});

describe("camera geometry contracts", () => {
  it("zoom changes fov without moving the camera", () => {
    const { demo } = reconcileTechniques(["t2_6"]);
    expect(isZoomOnly(demo)).toBe(true);
    expect(demo.start.pos).toEqual(demo.end.pos);
    expect(demo.end.fov).toBeLessThan(demo.start.fov);
  });

  it("dolly changes perspective distance at constant fov", () => {
    const { demo } = reconcileTechniques(["t2_3"]);
    expect(isDollyOnly(demo)).toBe(true);
  });

  it("dolly zoom keeps subject angular size nearly constant", () => {
    const { demo } = reconcileTechniques(["t2_19"]);
    expect(demo.subjectSizeLock).toBe(true);
    const a = subjectAngularSize(sampleCamera(demo, 0));
    const b = subjectAngularSize(sampleCamera(demo, 1));
    expect(Math.abs(a - b) / a).toBeLessThan(0.08);
  });

  it("rack focus changes focus distance over time", () => {
    const { demo } = reconcileTechniques(["t8_3"]);
    const a = sampleCamera(demo, 0).focusDistance;
    const b = sampleCamera(demo, 1).focusDistance;
    expect(b).toBeGreaterThan(a + 0.5);
  });
});
