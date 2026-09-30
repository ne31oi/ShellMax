import type { CameraKeyframe, ResolvedDemo, Vec3 } from "./types";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/** Map timeline u∈[0,1] through path style. */
export function pathT(u: number, path: ResolvedDemo["path"]): number {
  const t = clamp01(u);
  switch (path) {
    case "hold":
      return 0;
    case "whip":
      return t < 0.15 ? 0 : t > 0.45 ? 1 : easeInOut((t - 0.15) / 0.3);
    case "orbit": {
      return t;
    }
    case "crane":
    case "follow":
    case "linear":
    default:
      return easeInOut(t);
  }
}

export function sampleCamera(demo: ResolvedDemo, u: number): CameraKeyframe {
  const t = pathT(u, demo.path);
  if (demo.path === "orbit") {
    const radius = Math.hypot(demo.start.pos.x, demo.start.pos.z);
    const baseAngle = Math.atan2(demo.start.pos.x, demo.start.pos.z);
    const angle = baseAngle + t * (Math.PI * 0.75);
    const pos = {
      x: Math.sin(angle) * radius,
      y: demo.start.pos.y + Math.sin(t * Math.PI) * 0.15,
      z: Math.cos(angle) * radius,
    };
    return {
      pos,
      lookAt: lerpVec(demo.start.lookAt, demo.end.lookAt, t),
      fov: lerp(demo.start.fov, demo.end.fov, t),
      roll: lerp(demo.start.roll, demo.end.roll, t),
      focusDistance: lerp(demo.start.focusDistance, demo.focusEnd, t),
    };
  }

  // Edit cuts: jump / smash / axial switch poses mid-way.
  if (demo.edit.kind !== "none" && demo.edit.kind !== "dissolve" && demo.edit.kind !== "fade" && demo.edit.kind !== "jl") {
    const cut = demo.edit.cutAt;
    if (u >= cut) {
      const alt = alternateShot(demo);
      if (demo.edit.kind === "quick") {
        const slice = Math.floor(((u - cut) / (1 - cut)) * 4);
        return slice % 2 === 0 ? alt : demo.end;
      }
      return alt;
    }
  }

  return {
    pos: lerpVec(demo.start.pos, demo.end.pos, t),
    lookAt: lerpVec(demo.start.lookAt, demo.end.lookAt, t),
    fov: lerp(demo.start.fov, demo.end.fov, t),
    roll: lerp(demo.start.roll, demo.end.roll, t),
    // Focus can rack even when the support is locked-off.
    focusDistance: lerp(demo.start.focusDistance, demo.focusEnd, easeInOut(clamp01(u))),
  };
}

/** Second beat for montage demos. */
export function alternateShot(demo: ResolvedDemo): CameraKeyframe {
  const s = demo.start;
  switch (demo.edit.kind) {
    case "axial":
      return {
        ...s,
        pos: { x: s.pos.x, y: s.pos.y, z: Math.max(0.7, s.pos.z * 0.45) },
        fov: s.fov * 0.9,
        focusDistance: s.focusDistance * 0.55,
      };
    case "jump":
      return {
        ...s,
        pos: { x: s.pos.x + 0.35, y: s.pos.y, z: s.pos.z * 0.92 },
        lookAt: { x: s.lookAt.x + 0.1, y: s.lookAt.y, z: s.lookAt.z },
      };
    case "smash":
      return {
        ...demo.end,
        pos: { x: -1.2, y: 1.5, z: 1.1 },
        lookAt: { x: 0, y: 1.5, z: 0 },
        fov: 28,
      };
    case "cross":
      return {
        ...s,
        pos: { x: -2.2, y: 1.4, z: 2.4 },
        lookAt: { x: -0.7, y: 1.4, z: 0 },
      };
    case "match":
    case "graphic":
    case "action":
    case "invisible":
    default:
      return {
        ...demo.end,
        pos: { x: s.pos.x + 1.6, y: s.pos.y, z: s.pos.z * 0.85 },
        lookAt: { x: 0.55, y: s.lookAt.y, z: 0 },
      };
  }
}

export interface SampledFrame {
  u: number;
  camera: CameraKeyframe;
  /** 0..1 action phase for mannequin, respects timeScale / freeze. */
  actionPhase: number;
  opacity: number;
  blurMix: number;
  timeScale: number;
}

/**
 * Deterministic frame at normalized time u∈[0,1].
 * Pause and scrub must call this — never depend on wall-clock deltas for pose.
 */
export function sampleFrame(demo: ResolvedDemo, uRaw: number): SampledFrame {
  const u = clamp01(uRaw);
  if (demo.freezeAt != null && u >= demo.freezeAt) {
    const frozen = demo.freezeAt;
    return {
      u: frozen,
      camera: sampleCamera(demo, frozen),
      actionPhase: frozen,
      opacity: 1,
      blurMix: demo.post.motionBlur,
      timeScale: 0,
    };
  }

  const timeScale = lerp(demo.timeScale, demo.timeScaleEnd, u);
  let opacity = 1;
  if (demo.edit.kind === "fade") {
    opacity = u < 0.2 ? u / 0.2 : u > 0.8 ? (1 - u) / 0.2 : 1;
  } else if (demo.edit.kind === "dissolve") {
    const cut = demo.edit.cutAt;
    opacity = u < cut - 0.08 ? 1 : u > cut + 0.08 ? 1 : 0.55;
  }

  return {
    u,
    camera: sampleCamera(demo, u),
    actionPhase: clamp01(u * timeScale),
    opacity,
    blurMix: demo.post.motionBlur,
    timeScale,
  };
}

/** Zoom-only change keeps camera position; used by geometry tests. */
export function isZoomOnly(demo: ResolvedDemo): boolean {
  const a = demo.start.pos;
  const b = demo.end.pos;
  return a.x === b.x && a.y === b.y && a.z === b.z && demo.start.fov !== demo.end.fov;
}

export function isDollyOnly(demo: ResolvedDemo): boolean {
  return demo.start.pos.z !== demo.end.pos.z && demo.start.fov === demo.end.fov && !demo.subjectSizeLock;
}

export function subjectAngularSize(camera: CameraKeyframe, subjectHeight = 1.7): number {
  const dist = Math.hypot(camera.pos.x - camera.lookAt.x, camera.pos.y - camera.lookAt.y, camera.pos.z - camera.lookAt.z);
  const fovRad = (camera.fov * Math.PI) / 180;
  return (2 * Math.atan((subjectHeight * 0.5) / Math.max(0.01, dist))) / fovRad;
}
