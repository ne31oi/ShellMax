import * as THREE from "three";
import type { LightState, PostState, PrecipKind } from "../types";

/** Grade / grain / flare / CA / fisheye / leak via one fullscreen shader. */
const POST_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uGrade: { value: 0 },
    uSat: { value: 1 },
    uWarm: { value: 0 },
    uTeal: { value: 0 },
    uGrain: { value: 0 },
    uFlare: { value: 0 },
    uHalation: { value: 0 },
    uLeak: { value: 0 },
    uCA: { value: 0 },
    uFisheye: { value: 0 },
    uAnamorphic: { value: 0 },
    uOpacity: { value: 1 },
    uTime: { value: 0 },
    uDouble: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uGrade, uSat, uWarm, uTeal, uGrain, uFlare, uHalation, uLeak, uCA, uFisheye, uAnamorphic, uOpacity, uTime, uDouble;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

    vec2 distort(vec2 uv) {
      vec2 c = uv * 2.0 - 1.0;
      c.x *= 1.0 + uAnamorphic * 0.25;
      float r2 = dot(c, c);
      c *= 1.0 + uFisheye * r2;
      return c * 0.5 + 0.5;
    }

    void main() {
      vec2 uv = distort(vUv);
      vec2 ca = vec2(uCA * 0.004, 0.0);
      float r = texture2D(tDiffuse, uv + ca).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - ca).b;
      vec3 col = vec3(r, g, b);

      if (uDouble > 0.01) {
        vec3 ghost = texture2D(tDiffuse, uv + vec2(0.03, -0.02)).rgb;
        col = mix(col, max(col, ghost), uDouble);
      }

      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(luma), col, uSat);
      col.r += uWarm * 0.08;
      col.b -= uWarm * 0.05;
      col.r += uTeal * 0.05;
      col.g += uTeal * 0.02;
      col.b += uTeal * 0.08;
      if (uGrade > 0.5) { // bleach-ish
        col = mix(col, vec3(luma) * 1.1 + col * 0.3, 0.55);
      }

      float n = hash(uv * vec2(1200.0, 800.0) + uTime) - 0.5;
      col += n * uGrain * 0.22;

      float d = length(vUv - 0.5);
      col += vec3(1.0, 0.9, 0.7) * uFlare * pow(max(0.0, 1.0 - d * 1.8), 4.0);
      col += vec3(1.0, 0.4, 0.2) * uHalation * pow(luma, 2.0) * 0.35;
      col += vec3(1.0, 0.55, 0.25) * uLeak * smoothstep(0.55, 1.0, vUv.x + vUv.y * 0.2) * 0.45;

      gl_FragColor = vec4(col, uOpacity);
    }
  `,
};

export function createPostMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(POST_SHADER.uniforms),
    vertexShader: POST_SHADER.vertexShader,
    fragmentShader: POST_SHADER.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
}

export function applyGradeUniforms(mat: THREE.ShaderMaterial, post: PostState, opacity: number, time: number): void {
  const u = mat.uniforms;
  u.uOpacity.value = opacity;
  u.uTime.value = time;
  u.uGrain.value = post.grain;
  u.uFlare.value = post.flare;
  u.uHalation.value = post.halation;
  u.uLeak.value = post.lightLeak;
  u.uCA.value = post.chromatic;
  u.uFisheye.value = post.fisheye;
  u.uAnamorphic.value = post.anamorphic;
  u.uDouble.value = post.doubleExposure;
  u.uGrade.value = post.grade === "bleach" ? 1 : 0;

  switch (post.grade) {
    case "warm":
      u.uSat.value = 1.05;
      u.uWarm.value = 1;
      u.uTeal.value = 0;
      break;
    case "cool":
      u.uSat.value = 1.0;
      u.uWarm.value = -0.8;
      u.uTeal.value = 0.3;
      break;
    case "tealOrange":
      u.uSat.value = 1.15;
      u.uWarm.value = 0.35;
      u.uTeal.value = 1;
      break;
    case "desat":
      u.uSat.value = 0.45;
      u.uWarm.value = 0;
      u.uTeal.value = 0;
      break;
    case "hypersat":
      u.uSat.value = 1.55;
      u.uWarm.value = 0.15;
      u.uTeal.value = 0.2;
      break;
    case "mono":
      u.uSat.value = 0;
      u.uWarm.value = 0;
      u.uTeal.value = 0;
      break;
    case "palette":
      u.uSat.value = 0.85;
      u.uWarm.value = 0.25;
      u.uTeal.value = 0.15;
      break;
    case "bleach":
      u.uSat.value = 0.55;
      u.uWarm.value = -0.1;
      u.uTeal.value = 0;
      break;
    default:
      u.uSat.value = 1;
      u.uWarm.value = 0;
      u.uTeal.value = 0;
  }
}

export function placeKeyLight(light: THREE.DirectionalLight, fill: THREE.DirectionalLight, rim: THREE.DirectionalLight, state: LightState, target: THREE.Object3D): void {
  const dist = 4.5;
  const az = (state.keyAzimuth * Math.PI) / 180;
  const el = (state.keyElevation * Math.PI) / 180;
  light.position.set(
    Math.sin(az) * Math.cos(el) * dist,
    Math.sin(el) * dist + 1.2,
    Math.cos(az) * Math.cos(el) * dist,
  );
  light.target = target;
  light.intensity = state.keyIntensity;
  light.color = new THREE.Color(state.keyColor);
  light.castShadow = true;

  fill.position.set(-light.position.x * 0.6, 1.6, light.position.z * 0.5);
  fill.intensity = state.fillIntensity;
  fill.color = new THREE.Color("#cdd7e6");

  const raz = (state.rimAzimuth * Math.PI) / 180;
  rim.position.set(Math.sin(raz) * 3.5, 2.2, Math.cos(raz) * 3.5);
  rim.intensity = state.rimIntensity;
  rim.color = new THREE.Color("#fff8f0");
}

export function createPrecipSystem(kind: PrecipKind): THREE.Points | null {
  if (kind === "none") return null;
  const count = kind === "rain" ? 600 : 350;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 10;
    positions[i * 3 + 1] = Math.random() * 5;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const color =
    kind === "embers" ? 0xff6a2a :
    kind === "snow" ? 0xffffff :
    kind === "dust" ? 0xc2b280 :
    kind === "smoke" || kind === "fog" || kind === "haze" || kind === "mist" ? 0x9aa3ad :
    0xa8c4e0;
  const mat = new THREE.PointsMaterial({
    color,
    size: kind === "rain" ? 0.035 : kind === "embers" ? 0.06 : 0.05,
    transparent: true,
    opacity: kind === "fog" || kind === "haze" ? 0.35 : 0.7,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.name = "precip";
  pts.userData.kind = kind;
  return pts;
}

export function tickPrecip(pts: THREE.Points, dt: number): void {
  const kind = pts.userData.kind as PrecipKind;
  const pos = pts.geometry.getAttribute("position") as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const speed = kind === "rain" ? 4.5 : kind === "embers" ? 0.6 : kind === "snow" ? 0.5 : 0.25;
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3 + 1]! -= speed * dt * (kind === "embers" ? 0.4 + Math.random() : 1);
    if (kind === "embers" || kind === "dust") arr[i * 3]! += Math.sin(i + dt) * 0.01;
    if (arr[i * 3 + 1]! < 0) {
      arr[i * 3 + 1] = 4.5;
      arr[i * 3] = (Math.random() - 0.5) * 10;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 10;
    }
  }
  pos.needsUpdate = true;
}
