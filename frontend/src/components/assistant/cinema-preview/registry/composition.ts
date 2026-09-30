import type {
  CameraKeyframe,
  CompositionKind,
  FramingKind,
  LightState,
  ResolvedDemo,
  Vec3,
} from "../types";
import { distanceForFraming } from "./framing";

/**
 * Composition layouts derived from cinematography_catalog.json §6 only.
 * Each case mirrors the catalog's responsible effect — nothing invented beyond demo geometry.
 */
export interface CompositionLayout {
  heroOffset: Vec3;
  cameraTruck: Vec3;
  lookBias: Vec3;
  /** Head yaw deg: + looks toward screen-right (character facing camera). */
  headYawDeg: number;
  doorway: boolean;
  doorwayClose: boolean;
  corridor: boolean;
  leadingLines: boolean;
  hideDepthMarkers: boolean;
  /** Catalog 6.9: doors / fabric / plants / silhouettes / architecture — not faces or hands. */
  fgProp: "none" | "architecture" | "plant" | "silhouette" | "layered";
  secondMannequin: boolean;
  dirtyOccluder: boolean;
  tonalBg: boolean;
  figureGround: boolean;
  /** Catalog 6.11: large dark mass opposing a small bright face. */
  weightWall: boolean;
  lightPatch?: Partial<LightState>;
  dofBoost?: number;
}

function v(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

/** Lateral span scales with framing distance so thirds / lead-room stay readable. */
function spanFor(framing: FramingKind): number {
  return Math.max(0.35, distanceForFraming(framing) * 0.22);
}

export function compositionLayout(kind: CompositionKind, framing: FramingKind): CompositionLayout {
  const s = spanFor(framing);
  const base: CompositionLayout = {
    heroOffset: v(),
    cameraTruck: v(),
    lookBias: v(),
    headYawDeg: 0,
    doorway: false,
    doorwayClose: false,
    corridor: false,
    leadingLines: false,
    hideDepthMarkers: false,
    fgProp: "none",
    secondMannequin: false,
    dirtyOccluder: false,
    tonalBg: false,
    figureGround: false,
    weightWall: false,
  };

  switch (kind) {
    // 6.1 RULE OF THIRDS — masses on 3×3 lines/intersections; natural readable asymmetry
    case "thirds":
      return {
        ...base,
        heroOffset: v(-s * 0.95, 0, 0),
        lookBias: v(-s * 0.35, 0, 0),
        headYawDeg: 10,
      };

    // 6.2 CENTERED — object on central axis; iconic / control / confrontation / formalism
    case "center":
      return {
        ...base,
        heroOffset: v(),
        lookBias: v(),
        hideDepthMarkers: true,
      };

    // 6.3 SYMMETRY — left/right visually balanced; order, ritual, power, sterility
    case "symmetry":
      return {
        ...base,
        heroOffset: v(),
        doorway: true,
        corridor: true,
        hideDepthMarkers: true,
        lightPatch: { keyAzimuth: 0, fillIntensity: 0.55, rimIntensity: 0.35, keySoftness: 0.55 },
      };

    // 6.4 ASYMMETRY — unequal masses held by visual balance; life, tension, instability
    case "asymmetry":
      return {
        ...base,
        heroOffset: v(s * 0.9, 0, 0),
        lookBias: v(s * 0.25, 0, 0),
        fgProp: "architecture",
        headYawDeg: -14,
      };

    // 6.5 LEADING LINES — architecture/road/light lines guide the eye to the story point
    case "leading":
      return {
        ...base,
        heroOffset: v(s * 0.4, 0, -0.2),
        lookBias: v(s * 0.1, 0, -0.5),
        leadingLines: true,
        headYawDeg: -18,
      };

    // 6.6 VANISHING POINT / ONE-POINT — lines converge to one point; depth, tunnel, pull
    case "vanishing":
      return {
        ...base,
        heroOffset: v(0, 0, -0.5),
        cameraTruck: v(0, 0.12, 0.4),
        lookBias: v(0, 0, -1.4),
        corridor: true,
        doorway: true,
        leadingLines: true,
        hideDepthMarkers: true,
      };

    // 6.7 FRAME WITHIN FRAME — door/window/arch/passage as a second frame; isolation, observation
    case "frameInFrame":
      return {
        ...base,
        heroOffset: v(0, 0, -1.7),
        lookBias: v(0, 0.04, -1.7),
        doorway: true,
        doorwayClose: true,
        hideDepthMarkers: true,
      };

    // 6.8 NEGATIVE SPACE — large part of frame relatively empty; loneliness, waiting, graphic silence
    case "negative":
      return {
        ...base,
        heroOffset: v(-s * 1.2, 0, 0),
        lookBias: v(s * 0.7, 0, 0),
        cameraTruck: v(-s * 0.1, 0, 0),
        hideDepthMarkers: true,
        headYawDeg: 20,
      };

    // 6.9 FOREGROUND INTEREST — near-camera object adds depth / partially hides; doors, fabric, plants, silhouettes, architecture
    case "foreground":
      return {
        ...base,
        heroOffset: v(s * 0.3, 0, 0),
        fgProp: "plant",
        dofBoost: 0.4,
      };

    // 6.10 LAYERED DEPTH — story on FG / MG / BG; layers ≠ deep focus (one plane may stay sharp)
    case "layered":
      return {
        ...base,
        heroOffset: v(0.1, 0, 0),
        fgProp: "layered",
        secondMannequin: true,
        dofBoost: 0.3,
      };

    // 6.11 VISUAL WEIGHT — pick the first-look winner; small bright face can outweigh a huge dark wall
    case "weight":
      return {
        ...base,
        heroOffset: v(s * 0.85, 0, 0),
        lookBias: v(s * 0.35, 0, 0),
        weightWall: true,
        lightPatch: { keyIntensity: 2.35, fillIntensity: 0.12, ambient: 0.08, keySoftness: 0.35 },
      };

    // 6.12 FIGURE-GROUND — separate subject from BG via luminance/color/DOF/rim/backlight/silhouette
    case "figureGround":
      return {
        ...base,
        figureGround: true,
        hideDepthMarkers: true,
        lightPatch: {
          fillIntensity: 0.06,
          ambient: 0.05,
          rimIntensity: 1.35,
          rimAzimuth: 170,
          keyIntensity: 1.9,
          keySoftness: 0.4,
        },
        dofBoost: 0.25,
      };

    // 6.13 TONAL CONTRAST — steer the lightest and darkest spots so the eye finds the main thing
    case "tonal":
      return {
        ...base,
        heroOffset: v(s * 0.35, 0, 0),
        tonalBg: true,
        lightPatch: { keyIntensity: 2.4, fillIntensity: 0.08, ambient: 0.04, keySoftness: 0.2 },
      };

    // 6.14 LOOK SPACE / LEAD ROOM — space in front of the gaze / motion
    case "leadRoom":
      return {
        ...base,
        // Hero left, looking right into open space
        heroOffset: v(-s * 0.85, 0, 0),
        lookBias: v(s * 0.55, 0, 0),
        headYawDeg: 28,
      };

    // 6.15 SHORT SIDING — face toward nearest edge; free space stays behind; discomfort / closedness
    case "shortSiding":
      return {
        ...base,
        // Hero right, looking further toward the right edge; empty space behind (left)
        heroOffset: v(s * 0.95, 0, 0),
        lookBias: v(s * 0.55, 0, 0),
        headYawDeg: 34,
      };

    // 6.16 DIRTY FRAME — edges partially blocked; presence, realism, observation from space
    case "dirty":
      return {
        ...base,
        heroOffset: v(s * 0.2, 0, 0),
        fgProp: "silhouette",
        secondMannequin: true,
        dirtyOccluder: true,
        dofBoost: 0.15,
      };

    // 6.17 CLEAN FRAME — minimum accidental overlaps / distracting edges; clarity, graphic, iconic
    case "clean":
      return {
        ...base,
        heroOffset: v(),
        hideDepthMarkers: true,
        lightPatch: { fillIntensity: 0.5, ambient: 0.3, rimIntensity: 0.15 },
      };

    default:
      return base;
  }
}

function shiftKey(k: CameraKeyframe, truck: Vec3, look: Vec3): CameraKeyframe {
  return {
    ...k,
    pos: { x: k.pos.x + truck.x, y: k.pos.y + truck.y, z: k.pos.z + truck.z },
    lookAt: { x: k.lookAt.x + look.x, y: k.lookAt.y + look.y, z: k.lookAt.z + look.z },
  };
}

/** Apply composition layout onto an already framed/angled demo. */
export function applyCompositionLayout(demo: ResolvedDemo, layout: CompositionLayout): void {
  // Track the (possibly offset) hero, then add artistic look bias (lead room / negative space).
  const look = {
    x: layout.lookBias.x + layout.heroOffset.x,
    y: layout.lookBias.y + layout.heroOffset.y,
    z: layout.lookBias.z + layout.heroOffset.z,
  };
  demo.start = shiftKey(demo.start, layout.cameraTruck, look);
  demo.end = shiftKey(demo.end, layout.cameraTruck, look);

  demo.scene = {
    ...demo.scene,
    doorway: demo.scene.doorway || layout.doorway,
    secondMannequin: demo.scene.secondMannequin || layout.secondMannequin,
    macroProp: demo.scene.macroProp || layout.fgProp !== "none",
    composition: demo.composition,
    heroOffset: layout.heroOffset,
    headYawDeg: layout.headYawDeg,
    doorwayClose: layout.doorwayClose,
    corridor: layout.corridor,
    leadingLines: layout.leadingLines,
    hideDepthMarkers: layout.hideDepthMarkers,
    fgProp: layout.fgProp,
    dirtyOccluder: layout.dirtyOccluder,
    tonalBg: layout.tonalBg,
    figureGround: layout.figureGround,
    weightWall: layout.weightWall,
  };

  if (layout.lightPatch) {
    demo.light = { ...demo.light, ...layout.lightPatch };
  }
  if (layout.dofBoost) {
    demo.dofStrength = Math.min(1, demo.dofStrength + layout.dofBoost);
  }
}

/** Distinctness helper for tests: layout fingerprint that must differ across catalog kinds. */
export function compositionFingerprint(kind: CompositionKind, framing: FramingKind = "full"): string {
  const L = compositionLayout(kind, framing);
  return [
    L.heroOffset.x.toFixed(2),
    L.lookBias.x.toFixed(2),
    L.headYawDeg,
    L.doorway ? 1 : 0,
    L.doorwayClose ? 1 : 0,
    L.corridor ? 1 : 0,
    L.leadingLines ? 1 : 0,
    L.hideDepthMarkers ? 1 : 0,
    L.fgProp,
    L.secondMannequin ? 1 : 0,
    L.dirtyOccluder ? 1 : 0,
    L.tonalBg ? 1 : 0,
    L.figureGround ? 1 : 0,
    L.weightWall ? 1 : 0,
    L.dofBoost ?? 0,
    L.lightPatch ? JSON.stringify(L.lightPatch) : "",
  ].join("|");
}
