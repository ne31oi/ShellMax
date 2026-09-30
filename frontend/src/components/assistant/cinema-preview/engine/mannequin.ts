import * as THREE from "three";

const SKIN = 0xb8a08a;
const JOINT = 0x8a7a68;

function mat(color: number, rough = 0.75): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 });
}

function limb(
  parent: THREE.Object3D,
  size: [number, number, number],
  pos: [number, number, number],
  color = SKIN,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat(color));
  mesh.position.set(...pos);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Matte articulated mannequin with volumetric nose, cheeks, eye sockets. */
export function createMannequin(): THREE.Group {
  const root = new THREE.Group();
  root.name = "mannequin";

  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);

  const torso = limb(hips, [0.34, 0.48, 0.2], [0, 0.28, 0]);
  torso.name = "torso";

  const head = new THREE.Group();
  head.position.set(0, 0.62, 0);
  hips.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 16), mat(SKIN, 0.7));
  skull.scale.set(1, 1.15, 1.05);
  skull.castShadow = true;
  head.add(skull);

  const cheekL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), mat(SKIN, 0.65));
  cheekL.position.set(-0.07, -0.02, 0.08);
  head.add(cheekL);
  const cheekR = cheekL.clone();
  cheekR.position.x = 0.07;
  head.add(cheekR);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.07, 8), mat(SKIN, 0.6));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, -0.01, 0.13);
  head.add(nose);

  const socketMat = mat(0x2a2430, 0.4);
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), socketMat);
  eyeL.position.set(-0.045, 0.025, 0.1);
  eyeL.scale.set(1, 0.7, 0.5);
  head.add(eyeL);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.045;
  head.add(eyeR);

  const jaw = limb(head, [0.16, 0.08, 0.12], [0, -0.1, 0.02]);
  jaw.name = "jaw";

  const shoulderL = new THREE.Group();
  shoulderL.position.set(-0.22, 0.48, 0);
  hips.add(shoulderL);
  const armL = limb(shoulderL, [0.08, 0.42, 0.08], [0, -0.22, 0], JOINT);
  armL.name = "armL";

  const shoulderR = new THREE.Group();
  shoulderR.position.set(0.22, 0.48, 0);
  hips.add(shoulderR);
  const armR = limb(shoulderR, [0.08, 0.42, 0.08], [0, -0.22, 0], JOINT);
  armR.name = "armR";

  const legL = new THREE.Group();
  legL.position.set(-0.1, 0, 0);
  root.add(legL);
  limb(legL, [0.1, 0.9, 0.12], [0, 0.45, 0], JOINT).name = "legL";

  const legR = new THREE.Group();
  legR.position.set(0.1, 0, 0);
  root.add(legR);
  limb(legR, [0.1, 0.9, 0.12], [0, 0.45, 0], JOINT).name = "legR";

  root.userData.parts = { hips, head, shoulderL, shoulderR, legL, legR, armL, armR };
  return root;
}

export function poseMannequin(
  root: THREE.Group,
  action: string,
  phase: number,
  headYawDeg = 0,
): void {
  const parts = root.userData.parts as {
    hips: THREE.Group;
    head: THREE.Group;
    shoulderL: THREE.Group;
    shoulderR: THREE.Group;
    legL: THREE.Group;
    legR: THREE.Group;
  };
  const swing = Math.sin(phase * Math.PI * 2);

  parts.hips.rotation.set(0, 0, 0);
  parts.head.rotation.set(0, 0, 0);
  parts.shoulderL.rotation.set(0, 0, 0);
  parts.shoulderR.rotation.set(0, 0, 0);
  parts.legL.rotation.set(0, 0, 0);
  parts.legR.rotation.set(0, 0, 0);
  root.position.x = 0;
  root.position.z = 0;
  root.rotation.y = 0;

  switch (action) {
    case "walk":
      parts.legL.rotation.x = swing * 0.55;
      parts.legR.rotation.x = -swing * 0.55;
      parts.shoulderL.rotation.x = -swing * 0.45;
      parts.shoulderR.rotation.x = swing * 0.45;
      root.position.z = phase * 1.8;
      break;
    case "turn":
      root.rotation.y = phase * Math.PI;
      parts.head.rotation.y = Math.sin(phase * Math.PI) * 0.3;
      break;
    case "react":
      parts.head.rotation.x = -0.15 - Math.sin(phase * Math.PI) * 0.1;
      parts.shoulderL.rotation.z = 0.4;
      parts.shoulderR.rotation.z = -0.4;
      break;
    case "raiseHand":
      parts.shoulderR.rotation.x = -Math.PI * 0.7 * Math.min(1, phase * 2);
      break;
    case "lookAside":
      parts.head.rotation.y = 0.7;
      break;
    default:
      parts.head.rotation.y = Math.sin(phase * Math.PI * 2) * 0.05;
      break;
  }

  // Composition look-space / short-siding (catalog 6.14 / 6.15) overrides idle head drift.
  if (headYawDeg !== 0) {
    parts.head.rotation.y = (headYawDeg * Math.PI) / 180;
  }
}
