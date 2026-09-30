import * as THREE from "three";
import type { SceneProps } from "../types";

/** Small neutral pavilion with FG / MG / BG depth markers. */
export function createPavilion(): THREE.Group {
  const root = new THREE.Group();
  root.name = "pavilion";

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.9, metalness: 0 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.85, metalness: 0 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x6a7078, roughness: 0.7 });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = "floor";
  root.add(floor);

  const back = new THREE.Mesh(new THREE.PlaneGeometry(16, 6), wallMat);
  back.position.set(0, 3, -6);
  back.receiveShadow = true;
  back.name = "backWall";
  root.add(back);

  const left = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), wallMat);
  left.position.set(-6, 3, 0);
  left.rotation.y = Math.PI / 2;
  left.name = "leftWall";
  root.add(left);

  const right = left.clone();
  right.position.x = 6;
  right.rotation.y = -Math.PI / 2;
  right.name = "rightWall";
  root.add(right);

  const fg = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), accent);
  fg.position.set(-1.1, 0.175, 2.2);
  fg.castShadow = true;
  fg.name = "fgMarker";
  root.add(fg);

  const mg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 1.6, 12), accent);
  mg.position.set(1.4, 0.8, -1.2);
  mg.castShadow = true;
  mg.name = "mgMarker";
  root.add(mg);

  const bg = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 0.08), accent);
  bg.position.set(0, 1.4, -5.5);
  bg.name = "bgMarker";
  root.add(bg);

  return root;
}

/** 6.7 / 6.3 — door / arch as a second frame or mirrored portal. */
export function createDoorway(close = false): THREE.Group {
  const g = new THREE.Group();
  g.name = "doorway";
  const frame = new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.8 });
  const z = close ? -1.35 : -3.2;
  const scale = close ? 1.15 : 1;
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.15 * scale, 2.2 * scale, 0.3), frame);
  left.position.set(-0.55 * scale, 1.1 * scale, z);
  const right = left.clone();
  right.position.x = 0.55 * scale;
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.25 * scale, 0.15, 0.3), frame);
  top.position.set(0, 2.25 * scale, z);
  g.add(left, right, top);
  return g;
}

/** 6.6 / 6.3 — converging walls for one-point / symmetry. */
export function createCorridor(): THREE.Group {
  const g = new THREE.Group();
  g.name = "corridor";
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.82 });
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.2, 8), mat);
  left.position.set(-1.6, 1.6, -2.5);
  left.rotation.y = 0.12;
  const right = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.2, 8), mat);
  right.position.set(1.6, 1.6, -2.5);
  right.rotation.y = -0.12;
  g.add(left, right);
  return g;
}

/** 6.5 / 6.6 — floor / wall lines that pull the eye to a point. */
export function createLeadingLines(): THREE.Group {
  const g = new THREE.Group();
  g.name = "leadingLines";
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a929c, roughness: 0.55, metalness: 0.1 });
  for (let i = 0; i < 5; i++) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 7), mat);
    const t = (i - 2) / 2;
    strip.position.set(t * 1.8, 0.02, -1.2);
    strip.rotation.y = -t * 0.18;
    g.add(strip);
  }
  return g;
}

/**
 * 6.9 FOREGROUND INTEREST — catalog: doors, fabric, plants, silhouettes, architecture
 * (avoid complex foreground faces / hands).
 */
export function createFgInterest(kind: NonNullable<SceneProps["fgProp"]>): THREE.Group {
  const g = new THREE.Group();
  g.name = "fgInterest";
  if (kind === "none") return g;

  if (kind === "plant") {
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.14, 0.2, 10),
      new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.85 }),
    );
    pot.position.set(-0.55, 0.9, 1.55);
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x3d6b45, roughness: 0.7 }),
    );
    leaf.position.set(-0.55, 1.25, 1.55);
    leaf.scale.set(1, 1.4, 0.7);
    g.add(pot, leaf);
    return g;
  }

  if (kind === "architecture") {
    const pillar = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 2.4, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.75 }),
    );
    pillar.position.set(-1.15, 1.2, 1.35);
    pillar.castShadow = true;
    g.add(pillar);
    return g;
  }

  if (kind === "silhouette" || kind === "layered") {
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 1.6, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.9 }),
    );
    slab.position.set(kind === "layered" ? -0.85 : -0.7, 0.9, kind === "layered" ? 1.7 : 1.85);
    slab.rotation.y = 0.35;
    slab.castShadow = true;
    g.add(slab);
    if (kind === "layered") {
      const mid = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 1.1, 0.08),
        new THREE.MeshStandardMaterial({ color: 0x6a7078, roughness: 0.8 }),
      );
      mid.position.set(1.1, 1.0, -0.6);
      g.add(mid);
    }
    return g;
  }

  return g;
}

/** 6.11 — huge dark wall mass opposing the subject. */
export function createWeightWall(): THREE.Mesh {
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(2.8, 3.2, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x121418, roughness: 0.95 }),
  );
  wall.position.set(-1.8, 1.6, -1.2);
  wall.name = "weightWall";
  wall.receiveShadow = true;
  return wall;
}

export function createMacroProp(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.08, 0),
    new THREE.MeshStandardMaterial({ color: 0xc4a574, roughness: 0.45, metalness: 0.2 }),
  );
  mesh.position.set(0.15, 1.05, 0.35);
  mesh.castShadow = true;
  mesh.name = "macroProp";
  return mesh;
}

export function createPracticalLamp(): THREE.Group {
  const g = new THREE.Group();
  g.name = "practical";
  const stand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.04, 1.1, 8),
    new THREE.MeshStandardMaterial({ color: 0x22262c }),
  );
  stand.position.set(1.1, 0.55, 0.6);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xffc078, emissive: 0xff8a3a, emissiveIntensity: 1.4 }),
  );
  bulb.position.set(1.1, 1.2, 0.6);
  g.add(stand, bulb);
  const light = new THREE.PointLight(0xffb45a, 1.2, 6, 2);
  light.position.copy(bulb.position);
  light.castShadow = true;
  g.add(light);
  return g;
}

export function setPavilionDepthMarkers(pavilion: THREE.Group, visible: boolean): void {
  for (const name of ["fgMarker", "mgMarker", "bgMarker"]) {
    const obj = pavilion.getObjectByName(name);
    if (obj) obj.visible = visible;
  }
}

export function tintPavilionBackground(pavilion: THREE.Group, mode: "normal" | "tonal" | "figureGround"): void {
  const back = pavilion.getObjectByName("backWall") as THREE.Mesh | undefined;
  if (!back) return;
  const color = mode === "tonal" || mode === "figureGround" ? 0x0c0e12 : 0x4a4e55;
  back.material = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });
}
