import type { CameraKeyframe, FramingKind, Vec3 } from "../types";

/** Approximate vertical FOV (deg) for full-frame focal length. */
export function fovFromFocalMm(focalMm: number): number {
  const sensorHalfH = 12; // 24mm height / 2
  return (2 * Math.atan(sensorHalfH / Math.max(4, focalMm)) * 180) / Math.PI;
}

/** Camera distance that roughly yields the framing at ~50mm on a 1.7m figure. */
export function distanceForFraming(framing: FramingKind): number {
  switch (framing) {
    case "extremeWide":
      return 14;
    case "establishing":
      return 11;
    case "master":
      return 8;
    case "wide":
      return 6.5;
    case "full":
      return 4.4;
    case "cowboy":
      return 3.5;
    case "medium":
      return 2.7;
    case "mcu":
      return 1.95;
    case "cu":
      return 1.35;
    case "ecu":
      return 0.85;
    case "insert":
      return 0.55;
    case "cutaway":
      return 3.2;
    case "reaction":
      return 1.5;
    case "twoShot":
      return 3.8;
    case "ots":
      return 2.4;
  }
}

export function lookHeightForFraming(framing: FramingKind): number {
  switch (framing) {
    case "extremeWide":
    case "establishing":
    case "master":
    case "wide":
    case "full":
      return 1.15;
    case "cowboy":
      return 1.25;
    case "medium":
      return 1.35;
    case "mcu":
    case "reaction":
      return 1.48;
    case "cu":
      return 1.55;
    case "ecu":
      return 1.58;
    case "insert":
      return 0.95;
    case "cutaway":
      return 1.4;
    case "twoShot":
      return 1.35;
    case "ots":
      return 1.45;
  }
}

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function keyframe(pos: Vec3, lookAt: Vec3, fov: number, roll = 0, focusDistance = 3): CameraKeyframe {
  return { pos, lookAt, fov, roll, focusDistance };
}

export function focusOf(pos: Vec3, lookAt: Vec3): number {
  return Math.hypot(pos.x - lookAt.x, pos.y - lookAt.y, pos.z - lookAt.z);
}

/**
 * Framing sets subject size; focal length scales distance so the same crop keeps
 * roughly constant size while perspective (wide vs tele) changes.
 */
export function defaultCameraForFraming(framing: FramingKind, focalMm = 50): CameraKeyframe {
  const dist = distanceForFraming(framing) * (Math.max(8, focalMm) / 50);
  const lookY = lookHeightForFraming(framing);
  const camY = framing === "insert" ? 0.95 : Math.max(1.2, lookY);
  const pos = v3(0, camY, dist);
  const lookAt = v3(0, lookY, 0);
  return keyframe(pos, lookAt, fovFromFocalMm(focalMm), 0, focusOf(pos, lookAt));
}

export type AngleKind =
  | "eye"
  | "low"
  | "high"
  | "birds"
  | "worms"
  | "dutch"
  | "pov"
  | "profile"
  | "threeQuarter"
  | "reverse";

export function angleKindFromTags(tags: string[] | undefined): AngleKind | null {
  const set = new Set(tags ?? []);
  if (set.has("lowAngle")) return "low";
  if (set.has("highAngle")) return "high";
  if (set.has("birdsEye")) return "birds";
  if (set.has("wormsEye")) return "worms";
  if (set.has("dutch")) return "dutch";
  if (set.has("pov")) return "pov";
  if (set.has("profile")) return "profile";
  if (set.has("threeQuarter")) return "threeQuarter";
  if (set.has("reverse")) return "reverse";
  if (set.has("eyeLevel")) return "eye";
  return null;
}

/** Place camera on a sphere around lookAt — preserves subject distance (крупность+оптика). */
export function placeOnSphere(lookAt: Vec3, radius: number, azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const cosEl = Math.cos(el);
  return {
    x: lookAt.x + radius * cosEl * Math.sin(az),
    y: lookAt.y + radius * Math.sin(el),
    z: lookAt.z + radius * cosEl * Math.cos(az),
  };
}

/**
 * Apply angle on top of framed+lensed camera.
 * Never changes FOV. Keeps subject distance (radius to lookAt) so крупность/оптика survive.
 */
export function applyAngleToCamera(
  base: CameraKeyframe,
  _framing: FramingKind,
  kind: AngleKind | null,
  rollDeg?: number,
): CameraKeyframe {
  const lookAt = { ...base.lookAt };
  const radius = Math.max(0.35, focusOf(base.pos, lookAt));
  const fov = base.fov; // optics wins — angle must not touch FOV
  let roll = rollDeg ?? base.roll;
  let pos = { ...base.pos };

  if (!kind || kind === "eye") {
    if (rollDeg != null && rollDeg !== 0) {
      return keyframe(pos, lookAt, fov, rollDeg, radius);
    }
    return keyframe(pos, lookAt, fov, base.roll, radius);
  }

  switch (kind) {
    case "low":
      pos = placeOnSphere(lookAt, radius, 0, -28);
      break;
    case "high":
      pos = placeOnSphere(lookAt, radius, 0, 38);
      break;
    case "birds":
      pos = placeOnSphere(lookAt, radius, 0, 82);
      break;
    case "worms":
      pos = placeOnSphere(lookAt, radius, 0, -62);
      break;
    case "dutch":
      roll = rollDeg ?? 18;
      break;
    case "pov":
      // Eye-line forward from the framed look height; FOV stays from optics.
      pos = { x: lookAt.x, y: lookAt.y, z: lookAt.z + 0.28 };
      lookAt.z += Math.max(2.2, radius);
      break;
    case "profile":
      pos = placeOnSphere(lookAt, radius, 90, 4);
      break;
    case "threeQuarter":
      pos = placeOnSphere(lookAt, radius, 38, 6);
      break;
    case "reverse":
      pos = placeOnSphere(lookAt, radius, 180, 4);
      break;
    default:
      break;
  }

  return keyframe(pos, lookAt, fov, roll, focusOf(pos, lookAt));
}

/** Lateral subject offset for composition modes (metres in world X). */
export function compositionOffsetX(kind: string, framing: FramingKind): number {
  const span = distanceForFraming(framing) * 0.12;
  switch (kind) {
    case "thirds":
    case "leadRoom":
      return span;
    case "shortSiding":
      return -span * 0.85;
    case "asymmetry":
    case "weight":
      return span * 0.7;
    case "negative":
      return -span * 1.1;
    case "center":
    case "symmetry":
    default:
      return 0;
  }
}

/** Subject size proxy used in composition tests (independent of angle azimuth). */
export function subjectDistance(camera: CameraKeyframe): number {
  return focusOf(camera.pos, camera.lookAt);
}
