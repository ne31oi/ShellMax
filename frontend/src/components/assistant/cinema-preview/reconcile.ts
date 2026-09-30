import {
  CAT,
  DEMO_DURATION_S,
  type ConflictInfo,
  type DemoProfile,
  type FramingKind,
  type LightState,
  type ReconcileResult,
  type ResolvedDemo,
} from "./types";
import {
  angleKindFromTags,
  applyAngleToCamera,
  defaultCameraForFraming,
  fovFromFocalMm,
  subjectDistance,
  type AngleKind,
} from "./registry/framing";
import { applyCompositionLayout, compositionLayout } from "./registry/composition";
import { getDemoProfile } from "./registry";

export const DEFAULT_LIGHT: LightState = {
  keyAzimuth: 45,
  keyElevation: 35,
  keyIntensity: 1.6,
  keyColor: "#fff5e6",
  keySoftness: 0.65,
  fillIntensity: 0.35,
  rimIntensity: 0.25,
  rimAzimuth: 160,
  ambient: 0.22,
  underlight: 0,
  eyeLight: 0.15,
  practical: false,
  window: false,
  volumetric: false,
  gobo: false,
  tempBias: 0,
};

function mergeLight(base: LightState, patch?: Partial<LightState>): LightState {
  return patch ? { ...base, ...patch } : base;
}

function categoryOrder(category: string): number {
  switch (category) {
    case CAT.genre:
      return 0;
    case CAT.framing:
      return 1;
    case CAT.angle:
      return 2;
    case CAT.optics:
      return 3;
    case CAT.composition:
      return 4;
    case CAT.light:
      return 5;
    case CAT.focus:
      return 6;
    case CAT.color:
      return 7;
    case CAT.atmosphere:
      return 8;
    case CAT.fx:
      return 9;
    case CAT.time:
      return 10;
    case CAT.motion:
      return 11;
    case CAT.editing:
      return 12;
    default:
      return 50;
  }
}

function softFramingFromTags(tags: string[] | undefined): FramingKind | null {
  const soft = (tags ?? []).find((t) => t.startsWith("softFraming:"));
  if (!soft) return null;
  return soft.slice("softFraming:".length) as FramingKind;
}

function detectConflict(profiles: DemoProfile[]): ConflictInfo | null {
  const tags = new Set(profiles.flatMap((p) => p.tags ?? []));
  const framing = profiles.find((p) => p.category === CAT.framing)?.framing;
  const hasMacro = tags.has("macro") || framing === "insert";
  const hasWide =
    tags.has("wideFrame") ||
    framing === "full" ||
    framing === "wide" ||
    framing === "extremeWide" ||
    framing === "establishing" ||
    framing === "master";

  if (hasMacro && hasWide) {
    const prefer =
      profiles.find((p) => (p.tags ?? []).includes("macro"))?.id ??
      profiles.find((p) => p.category === CAT.optics)?.id ??
      profiles[0]!.id;
    return {
      reason: "Макро и полный рост / широкий план принципиально несовместимы в одном кадре.",
      preferSoloId: prefer,
    };
  }
  if (tags.has("fisheye") && tags.has("tele")) {
    const prefer = profiles.find((p) => (p.tags ?? []).includes("fisheye"))?.id ?? profiles[0]!.id;
    return {
      reason: "Fisheye и телесжатие задают противоположную перспективу.",
      preferSoloId: prefer,
    };
  }
  if (tags.has("shallow") && tags.has("deep")) {
    const prefer = profiles.find((p) => p.category === CAT.focus)?.id ?? profiles[0]!.id;
    return {
      reason: "Нельзя одновременно держать мелкую и глубокую резкость.",
      preferSoloId: prefer,
    };
  }
  return null;
}

/** Non-camera fields only — camera is composed once at the end. */
function applyLookFields(demo: ResolvedDemo, profile: DemoProfile): void {
  if (profile.support) demo.support = profile.support;
  if (profile.path) demo.path = profile.path;
  if (profile.subjectSizeLock != null) demo.subjectSizeLock = profile.subjectSizeLock;
  if (profile.mannequinAction) demo.mannequinAction = profile.mannequinAction;
  if (profile.composition) demo.composition = profile.composition;
  if (profile.secondMannequin) demo.scene.secondMannequin = true;
  if (profile.doorway) demo.scene.doorway = true;
  if (profile.macroProp) demo.scene.macroProp = true;
  if (profile.precip) demo.scene.precip = profile.precip;
  if (profile.wetDown) demo.scene.wetDown = true;
  if (profile.fogDensity != null) demo.scene.fogDensity = profile.fogDensity;

  if (profile.light) demo.light = mergeLight(demo.light, profile.light);
  if (profile.light?.practical) demo.light.practical = true;

  if (profile.grade) demo.post.grade = profile.grade;
  if (profile.grain != null) demo.post.grain = profile.grain;
  if (profile.flare != null) demo.post.flare = profile.flare;
  if (profile.halation != null) demo.post.halation = profile.halation;
  if (profile.bokehBoost != null) demo.post.bokehBoost = profile.bokehBoost;
  if (profile.doubleExposure != null) demo.post.doubleExposure = profile.doubleExposure;
  if (profile.lightLeak != null) demo.post.lightLeak = profile.lightLeak;
  if (profile.chromatic != null) demo.post.chromatic = profile.chromatic;
  if (profile.fisheye != null) demo.post.fisheye = profile.fisheye;
  if (profile.anamorphic != null) demo.post.anamorphic = profile.anamorphic;
  if (profile.motionBlur != null) demo.post.motionBlur = profile.motionBlur;
  if (profile.splitDiopter) demo.post.splitDiopter = true;
  if (profile.forcedPerspective) demo.post.forcedPerspective = true;

  if (profile.dofStrength != null) demo.dofStrength = profile.dofStrength;
  if (profile.timeScale != null) demo.timeScale = profile.timeScale;
  if (profile.timeScaleEnd != null) demo.timeScaleEnd = profile.timeScaleEnd;
  if (profile.freezeAt !== undefined) demo.freezeAt = profile.freezeAt;
  if (profile.edit) {
    demo.edit.kind = profile.edit;
    demo.edit.cutAt = 0.48;
  }
  if (profile.audioCue) demo.edit.audioCue = profile.audioCue;

  demo.sourceIds.push(profile.id);
}

function applyMotionDeltas(demo: ResolvedDemo, profile: DemoProfile): void {
  if (!profile.start || !profile.end) return;
  const start = profile.start;
  const end = profile.end;
  const dx = end.pos.x - start.pos.x;
  const dy = end.pos.y - start.pos.y;
  const dz = end.pos.z - start.pos.z;
  const dlx = end.lookAt.x - start.lookAt.x;
  const dly = end.lookAt.y - start.lookAt.y;
  const dlz = end.lookAt.z - start.lookAt.z;

  demo.end = {
    pos: { x: demo.start.pos.x + dx, y: demo.start.pos.y + dy, z: demo.start.pos.z + dz },
    lookAt: { x: demo.start.lookAt.x + dlx, y: demo.start.lookAt.y + dly, z: demo.start.lookAt.z + dlz },
    fov: demo.start.fov,
    roll: demo.start.roll + (end.roll - start.roll),
    focusDistance: demo.start.focusDistance + (end.focusDistance - start.focusDistance),
  };

  if (profile.subjectSizeLock) {
    const d0 = Math.max(0.05, subjectDistance(demo.start));
    const d1 = Math.max(0.05, subjectDistance(demo.end));
    const halfH = 0.85;
    const targetFrac = (2 * Math.atan(halfH / d0)) / ((demo.start.fov * Math.PI) / 180);
    const ang1 = 2 * Math.atan(halfH / d1);
    demo.end.fov = (ang1 / Math.max(0.001, targetFrac)) * (180 / Math.PI);
  } else {
    const fovScale = start.fov !== 0 ? end.fov / start.fov : 1;
    demo.end.fov = demo.start.fov * fovScale;
  }
}

function blankDemo(): ResolvedDemo {
  const start = defaultCameraForFraming("full", 50);
  return {
    duration: DEMO_DURATION_S,
    framing: "full",
    support: "tripod",
    path: "hold",
    subjectSizeLock: false,
    start,
    end: {
      pos: { ...start.pos },
      lookAt: { ...start.lookAt },
      fov: start.fov,
      roll: 0,
      focusDistance: start.focusDistance,
    },
    focusEnd: start.focusDistance,
    dofStrength: 0.25,
    light: { ...DEFAULT_LIGHT },
    scene: {
      secondMannequin: false,
      doorway: false,
      macroProp: false,
      precip: "none",
      wetDown: false,
      fogDensity: 0,
      composition: "center",
      heroOffset: { x: 0, y: 0, z: 0 },
      headYawDeg: 0,
      doorwayClose: false,
      corridor: false,
      leadingLines: false,
      hideDepthMarkers: false,
      fgProp: "none",
      dirtyOccluder: false,
      tonalBg: false,
      figureGround: false,
      weightWall: false,
    },
    post: {
      grade: "natural",
      grain: 0,
      flare: 0,
      halation: 0,
      bokehBoost: 0,
      doubleExposure: 0,
      lightLeak: 0,
      chromatic: 0,
      fisheye: 0,
      anamorphic: 0,
      motionBlur: 0,
      splitDiopter: false,
      forcedPerspective: false,
    },
    edit: { kind: "none", audioCue: null, cutAt: 0.5 },
    mannequinAction: "idle",
    timeScale: 1,
    timeScaleEnd: 1,
    freezeAt: null,
    composition: "center",
    sourceIds: [],
  };
}

/**
 * Resolve framing with strict ownership:
 * 1) CAT.framing always wins
 * 2) else soft suggestion from optics tags (macro→insert)
 * 3) else default full
 * Angle / motion / fx / genre never own крупность.
 */
function resolveFraming(profiles: DemoProfile[]): FramingKind {
  const explicit = profiles.find((p) => p.category === CAT.framing)?.framing;
  if (explicit) return explicit;
  for (const p of profiles) {
    if (p.category === CAT.angle) continue;
    const soft = softFramingFromTags(p.tags);
    if (soft) return soft;
  }
  return "full";
}

function resolveFocalMm(profiles: DemoProfile[]): number {
  const optics = profiles.find((p) => p.category === CAT.optics && p.focalMm != null);
  return optics?.focalMm ?? 50;
}

function resolveAngle(profiles: DemoProfile[]): { kind: AngleKind | null; roll?: number } {
  const angleProfile = profiles.find((p) => p.category === CAT.angle);
  let roll: number | undefined;
  for (const p of profiles) {
    if (p.roll != null) roll = p.roll;
  }
  return {
    kind: angleProfile ? angleKindFromTags(angleProfile.tags) : null,
    roll,
  };
}

/**
 * Merge selected technique profiles into one shot.
 * Layers never overwrite peer camera ownership:
 *   крупность → дистанция/look
 *   оптика → FOV (+ дистанция под тот же crop)
 *   ракурс → положение на сфере вокруг lookAt
 *   движение → дельты от уже собранного старта
 *   свет/цвет/атмосфера/fx/… → аддитивно
 */
export function reconcileTechniques(selectedIds: string[]): ReconcileResult {
  const profiles = selectedIds
    .map((id) => getDemoProfile(id))
    .filter((p): p is DemoProfile => !!p)
    .sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category));

  const demo = blankDemo();
  let motion: DemoProfile | null = null;

  for (const profile of profiles) {
    applyLookFields(demo, profile);
    if (profile.category === CAT.motion) motion = profile;
    if (profile.category === CAT.genre && profile.path && profile.path !== "hold" && profile.start && profile.end) {
      motion = profile;
    }
    if (profile.category === CAT.time && profile.path && profile.path !== "hold" && profile.start && profile.end) {
      motion = profile;
    }
  }

  const framing = resolveFraming(profiles);
  const focalMm = resolveFocalMm(profiles);
  const { kind: angle, roll: angleRoll } = resolveAngle(profiles);

  demo.framing = framing;

  // Compose camera once: framing + optics, then angle on the sphere.
  let cam = defaultCameraForFraming(framing, focalMm);
  cam = applyAngleToCamera(cam, framing, angle, angleRoll);

  const focusOverride = profiles.find((p) => p.focusDistance != null)?.focusDistance;
  if (focusOverride != null) cam.focusDistance = focusOverride;

  demo.start = {
    pos: { ...cam.pos },
    lookAt: { ...cam.lookAt },
    fov: cam.fov,
    roll: cam.roll,
    focusDistance: cam.focusDistance,
  };
  demo.end = {
    pos: { ...cam.pos },
    lookAt: { ...cam.lookAt },
    fov: cam.fov,
    roll: cam.roll,
    focusDistance: cam.focusDistance,
  };

  // Guard: optics FOV must survive angle.
  demo.start.fov = fovFromFocalMm(focalMm);
  demo.end.fov = demo.start.fov;

  const focusEnd = profiles.find((p) => p.focusEnd != null)?.focusEnd;
  if (focusEnd != null) demo.focusEnd = focusEnd;
  else demo.focusEnd = cam.focusDistance;

  if (motion) {
    applyMotionDeltas(demo, motion);
    // Motion may change FOV (zoom / dolly-zoom); framing identity stays in demo.framing.
  }

  // Composition rearranges subject / dressing / lateral bias — after camera stack & motion.
  applyCompositionLayout(demo, compositionLayout(demo.composition, demo.framing));

  if (demo.framing === "twoShot" || demo.framing === "ots") demo.scene.secondMannequin = true;
  if (demo.framing === "insert") demo.scene.macroProp = true;

  const conflict = profiles.length > 1 ? detectConflict(profiles) : null;
  return { demo, conflict };
}

export function resetDemo(): ResolvedDemo {
  return blankDemo();
}

export function isWideFraming(framing: FramingKind): boolean {
  return framing === "extremeWide" || framing === "establishing" || framing === "master" || framing === "wide" || framing === "full";
}
