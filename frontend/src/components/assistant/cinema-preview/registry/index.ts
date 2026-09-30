import type { DemoProfile } from "../types";
import { CAT } from "../types";
import { defaultCameraForFraming, v3 } from "./framing";
import { allTechniqueIds, rawProfiles } from "./rawProfiles";

type RawProfile = DemoProfile & {
  end_x_delta?: number;
  end_y_delta?: number;
  end_z_delta?: number;
  end_fov_scale?: number;
  pan_yaw?: number;
  tilt_pitch?: number;
  cam_x?: number;
  cam_y?: number;
  cam_z?: number;
  look_x?: number;
  look_y?: number;
  look_z?: number;
  fov?: number;
};

/**
 * Bake motion start/end against a neutral full/50mm rig.
 * Framing / optics / angle ownership is enforced later in reconcile.
 */
function finalize(raw: RawProfile): DemoProfile {
  const bakeFraming = raw.category === CAT.framing && raw.framing ? raw.framing : "full";
  const bakeFocal = raw.category === CAT.optics && raw.focalMm != null ? raw.focalMm : 50;
  const base = defaultCameraForFraming(bakeFraming, bakeFocal);
  if (raw.fov != null) base.fov = raw.fov;
  if (raw.cam_x != null) base.pos.x = raw.cam_x;
  if (raw.cam_y != null) base.pos.y = raw.cam_y;
  if (raw.cam_z != null) base.pos.z = raw.cam_z;
  if (raw.look_x != null) base.lookAt.x = raw.look_x;
  if (raw.look_y != null) base.lookAt.y = raw.look_y;
  if (raw.look_z != null) base.lookAt.z = raw.look_z;
  if (raw.roll != null) base.roll = raw.roll;
  if (raw.focusDistance != null) base.focusDistance = raw.focusDistance;

  const end = {
    pos: { ...base.pos },
    lookAt: { ...base.lookAt },
    fov: base.fov,
    roll: base.roll,
    focusDistance: raw.focusEnd ?? base.focusDistance,
  };

  if (raw.end_x_delta != null) end.pos.x += raw.end_x_delta;
  if (raw.end_y_delta != null) end.pos.y += raw.end_y_delta;
  if (raw.end_z_delta != null) end.pos.z += raw.end_z_delta;
  if (raw.end_fov_scale != null) end.fov = base.fov * raw.end_fov_scale;

  if (raw.pan_yaw != null) {
    const rad = (raw.pan_yaw * Math.PI) / 180;
    const dx = Math.sin(rad) * 4;
    const dz = (1 - Math.cos(rad)) * 2;
    end.lookAt = v3(base.lookAt.x + dx, base.lookAt.y, base.lookAt.z - dz);
  }
  if (raw.tilt_pitch != null) {
    end.lookAt = v3(base.lookAt.x, base.lookAt.y + raw.tilt_pitch * 0.04, base.lookAt.z);
  }
  if (raw.path === "orbit") {
    end.pos = v3(base.pos.z * 0.85, base.pos.y, base.pos.z * 0.15);
  }
  if (raw.subjectSizeLock && raw.end_z_delta != null) {
    const z0 = Math.max(0.4, base.pos.z);
    const z1 = Math.max(0.4, end.pos.z);
    end.fov = base.fov * (z1 / z0);
  }

  const {
    end_x_delta: _x,
    end_y_delta: _y,
    end_z_delta: _z,
    end_fov_scale: _f,
    pan_yaw: _p,
    tilt_pitch: _t,
    cam_x: _cx,
    cam_y: _cy,
    cam_z: _cz,
    look_x: _lx,
    look_y: _ly,
    look_z: _lz,
    fov: _fov,
    ...rest
  } = raw;

  const profile: DemoProfile = {
    ...rest,
    start: base,
    end,
  };

  // Ownership: only the framing category may carry a framing field into reconcile.
  if (raw.category !== CAT.framing) delete profile.framing;
  // Ownership: only optics may carry focalMm.
  if (raw.category !== CAT.optics || raw.focalMm == null) delete profile.focalMm;
  else profile.focalMm = raw.focalMm;

  return profile;
}

const CACHE: Record<string, DemoProfile> = {};

export function clearDemoProfileCache(): void {
  for (const key of Object.keys(CACHE)) delete CACHE[key];
}

export function getDemoProfile(id: string): DemoProfile | null {
  if (CACHE[id]) return CACHE[id];
  const raw = rawProfiles()[id];
  if (!raw) return null;
  const profile = finalize(raw);
  CACHE[id] = profile;
  return profile;
}

export function everyDemoProfile(): DemoProfile[] {
  return allTechniqueIds().map((id) => getDemoProfile(id)!);
}

export { allTechniqueIds };
export { fovFromFocalMm } from "./framing";
