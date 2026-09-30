import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import type { ResolvedDemo, ViewMode } from "../types";
import { PREVIEW_FPS } from "../types";
import { sampleFrame } from "../sample";
import { createMannequin, poseMannequin } from "./mannequin";
import {
  createCorridor,
  createDoorway,
  createFgInterest,
  createLeadingLines,
  createMacroProp,
  createPavilion,
  createPracticalLamp,
  createWeightWall,
  setPavilionDepthMarkers,
  tintPavilionBackground,
} from "./pavilion";
import {
  applyGradeUniforms,
  createPostMaterial,
  createPrecipSystem,
  placeKeyLight,
  tickPrecip,
} from "./effects";

export type EngineStatus = "ok" | "no-webgl";

export class CinemaEngine {
  readonly canvas: HTMLCanvasElement;
  status: EngineStatus = "ok";

  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 80);
  private schematicCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
  private controls: OrbitControls | null = null;
  private composer: EffectComposer | null = null;
  private gradePass: ShaderPass | null = null;
  private bokehPass: BokehPass | null = null;

  private key: THREE.DirectionalLight;
  private fill: THREE.DirectionalLight;
  private rim: THREE.DirectionalLight;
  private ambient: THREE.AmbientLight;
  private under: THREE.PointLight;
  private eye: THREE.PointLight;
  private lightTarget = new THREE.Object3D();

  private pavilion: THREE.Group;
  private hero: THREE.Group;
  private other: THREE.Group | null = null;
  private doorway: THREE.Group | null = null;
  private macro: THREE.Mesh | null = null;
  private practical: THREE.Group | null = null;
  private precip: THREE.Points | null = null;
  private trajectory: THREE.Line | null = null;
  private compDressing: THREE.Group | null = null;
  private camGizmo: THREE.Group;
  private lightGizmos: THREE.Group;

  private demo: ResolvedDemo | null = null;
  private viewMode: ViewMode = "shot";
  private aspect = 16 / 9;
  private playing = false;
  private u = 0;
  private lastTs = 0;
  private raf = 0;
  private visible = true;
  private disposed = false;
  private needsFrame = true;
  private frameBudgetMs = 1000 / PREVIEW_FPS;
  private accum = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.scene.background = new THREE.Color(0x1a1c20);

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: "low-power",
      });
    } catch {
      this.status = "no-webgl";
      this.key = new THREE.DirectionalLight();
      this.fill = new THREE.DirectionalLight();
      this.rim = new THREE.DirectionalLight();
      this.ambient = new THREE.AmbientLight();
      this.under = new THREE.PointLight();
      this.eye = new THREE.PointLight();
      this.pavilion = new THREE.Group();
      this.hero = new THREE.Group();
      this.camGizmo = new THREE.Group();
      this.lightGizmos = new THREE.Group();
      return;
    }

    if (!this.renderer.capabilities.isWebGL2) {
      // WebGL1 still works for our scene; keep going.
    }

    const r = this.renderer;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

    this.pavilion = createPavilion();
    this.scene.add(this.pavilion);

    this.hero = createMannequin();
    this.scene.add(this.hero);

    this.lightTarget.position.set(0, 1.4, 0);
    this.scene.add(this.lightTarget);

    this.key = new THREE.DirectionalLight(0xfff5e6, 1.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.fill = new THREE.DirectionalLight(0xcdd7e6, 0.35);
    this.rim = new THREE.DirectionalLight(0xfff8f0, 0.25);
    this.ambient = new THREE.AmbientLight(0x8a909a, 0.22);
    this.under = new THREE.PointLight(0xff8866, 0, 4);
    this.under.position.set(0, 0.2, 0.4);
    this.eye = new THREE.PointLight(0xffffff, 0.15, 1.2);
    this.eye.position.set(0, 1.55, 0.35);
    this.scene.add(this.key, this.fill, this.rim, this.ambient, this.under, this.eye);

    this.camGizmo = this.makeCamGizmo();
    this.camGizmo.visible = false;
    this.scene.add(this.camGizmo);

    this.lightGizmos = new THREE.Group();
    this.lightGizmos.visible = false;
    this.scene.add(this.lightGizmos);

    this.schematicCam.position.set(6, 4, 7);
    this.schematicCam.lookAt(0, 1, 0);
    this.controls = new OrbitControls(this.schematicCam, canvas);
    this.controls.target.set(0, 1.1, 0);
    this.controls.enableDamping = true;
    this.controls.enabled = false;

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.shotCam));
    this.bokehPass = new BokehPass(this.scene, this.shotCam, {
      focus: 3,
      aperture: 0.00025,
      maxblur: 0.01,
    });
    this.composer.addPass(this.bokehPass);
    this.gradePass = new ShaderPass(createPostMaterial());
    this.composer.addPass(this.gradePass);

    this.setSize(canvas.clientWidth || 480, canvas.clientHeight || 270);
    this.loop(0);
  }

  private makeCamGizmo(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.16, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x222831 }),
    );
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 0.18, 12),
      new THREE.MeshStandardMaterial({ color: 0x444b55 }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.22;
    g.add(body, lens);
    return g;
  }

  setAspectRatio(ratio: number): void {
    this.aspect = Math.max(0.4, Math.min(3, ratio));
    this.updateCameraAspect();
    this.needsFrame = true;
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    if (this.controls) this.controls.enabled = mode === "schematic";
    this.camGizmo.visible = mode === "schematic";
    this.lightGizmos.visible = mode === "schematic";
    if (this.trajectory) this.trajectory.visible = mode === "schematic";
    this.needsFrame = true;
  }

  setDemo(demo: ResolvedDemo): void {
    this.demo = demo;
    this.rebuildProps();
    this.rebuildTrajectory();
    this.applyLights();
    this.u = 0;
    this.playing = true;
    this.needsFrame = true;
    this.applyFrame();
    this.renderOnce();
  }

  play(): void {
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  get isPlaying(): boolean {
    return this.playing;
  }
  replay(): void {
    this.u = 0;
    this.playing = true;
    this.needsFrame = true;
  }
  scrub(u: number): void {
    this.u = Math.min(1, Math.max(0, u));
    this.playing = false;
    this.applyFrame();
    this.renderOnce();
  }
  get progress(): number {
    return this.u;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.needsFrame = true;
  }

  retryWebGL(): EngineStatus {
    if (this.renderer) return "ok";
    return this.status;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls?.dispose();
    this.composer?.dispose();
    this.renderer?.dispose();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const m = mesh.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else if (m) m.dispose();
    });
  }

  setSize(width: number, height: number): void {
    if (!this.renderer || width < 2 || height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(dpr);
    // Letterbox to aspect inside the canvas box.
    const boxAspect = width / height;
    let drawW = width;
    let drawH = height;
    if (boxAspect > this.aspect) {
      drawW = height * this.aspect;
    } else {
      drawH = width / this.aspect;
    }
    this.renderer.setSize(width, height, false);
    this.composer?.setSize(width, height);
    this.updateCameraAspect();
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    void drawW;
    void drawH;
    this.needsFrame = true;
  }

  private updateCameraAspect(): void {
    this.shotCam.aspect = this.aspect;
    this.shotCam.updateProjectionMatrix();
    this.schematicCam.aspect = this.aspect;
    this.schematicCam.updateProjectionMatrix();
  }

  private rebuildProps(): void {
    if (!this.demo) return;
    const s = this.demo.scene;

    if (this.other) {
      this.scene.remove(this.other);
      this.other = null;
    }
    if (s.secondMannequin) {
      this.other = createMannequin();
      if (s.dirtyOccluder) {
        // 6.16 — edge occlusion / observation from space
        this.other.position.set(-0.95, 0, 1.55);
        this.other.rotation.y = 1.1;
        this.other.scale.setScalar(1.05);
      } else if (s.fgProp === "layered") {
        // 6.10 — midground layer body
        this.other.position.set(-0.55, 0, -0.9);
        this.other.rotation.y = 0.4;
        this.other.scale.setScalar(0.92);
      } else {
        this.other.position.set(-0.7, 0, 0.15);
        this.other.rotation.y = 0.35;
      }
      this.scene.add(this.other);
    }

    if (this.doorway) {
      this.scene.remove(this.doorway);
      this.doorway = null;
    }
    if (s.doorway) {
      this.doorway = createDoorway(!!s.doorwayClose);
      this.scene.add(this.doorway);
    }

    if (this.macro) {
      this.scene.remove(this.macro);
      this.macro = null;
    }
    // Keep legacy macro prop for optics/insert; composition FG uses dressing group.
    if (s.macroProp && (s.fgProp === "none" || s.fgProp == null)) {
      this.macro = createMacroProp();
      this.scene.add(this.macro);
    }

    if (this.practical) {
      this.scene.remove(this.practical);
      this.practical = null;
    }
    if (this.demo.light.practical) {
      this.practical = createPracticalLamp();
      this.scene.add(this.practical);
    }

    if (this.compDressing) {
      this.scene.remove(this.compDressing);
      this.compDressing = null;
    }
    this.compDressing = new THREE.Group();
    this.compDressing.name = "compDressing";
    if (s.corridor) this.compDressing.add(createCorridor());
    if (s.leadingLines) this.compDressing.add(createLeadingLines());
    if (s.fgProp && s.fgProp !== "none") this.compDressing.add(createFgInterest(s.fgProp));
    if (s.weightWall) this.compDressing.add(createWeightWall());
    this.scene.add(this.compDressing);

    setPavilionDepthMarkers(this.pavilion, !s.hideDepthMarkers);
    tintPavilionBackground(
      this.pavilion,
      s.tonalBg ? "tonal" : s.figureGround ? "figureGround" : "normal",
    );

    if (this.precip) {
      this.scene.remove(this.precip);
      this.precip = null;
    }
    this.precip = createPrecipSystem(s.precip);
    if (this.precip) this.scene.add(this.precip);

    this.scene.fog = s.fogDensity > 0
      ? new THREE.FogExp2(0x1a1c20, s.fogDensity)
      : null;

    const floor = this.pavilion.getObjectByName("floor") as THREE.Mesh | null;
    if (floor) {
      floor.material = new THREE.MeshStandardMaterial(
        s.wetDown
          ? { color: 0x2a3038, roughness: 0.25, metalness: 0.35 }
          : { color: 0x3a3d42, roughness: 0.9, metalness: 0 },
      );
    }
  }

  private rebuildTrajectory(): void {
    if (this.trajectory) {
      this.scene.remove(this.trajectory);
      this.trajectory = null;
    }
    if (!this.demo) return;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const frame = sampleFrame(this.demo, i / 24);
      pts.push(new THREE.Vector3(frame.camera.pos.x, frame.camera.pos.y, frame.camera.pos.z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.trajectory = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x6ec8ff }));
    this.trajectory.visible = this.viewMode === "schematic";
    this.scene.add(this.trajectory);
  }

  private applyLights(): void {
    if (!this.demo) return;
    const L = this.demo.light;
    placeKeyLight(this.key, this.fill, this.rim, L, this.lightTarget);
    this.ambient.intensity = L.ambient;
    this.under.intensity = L.underlight;
    this.eye.intensity = L.eyeLight;

    // Softness approximated via shadow radius / fill.
    this.key.shadow.radius = 1 + L.keySoftness * 6;

    while (this.lightGizmos.children.length) this.lightGizmos.remove(this.lightGizmos.children[0]!);
    for (const src of [this.key, this.fill, this.rim]) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 10, 8),
        new THREE.MeshBasicMaterial({ color: src.color }),
      );
      marker.position.copy(src.position);
      this.lightGizmos.add(marker);
    }
  }

  private applyFrame(): void {
    if (!this.demo) return;
    const frame = sampleFrame(this.demo, this.u);
    const cam = frame.camera;

    this.shotCam.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
    this.shotCam.lookAt(cam.lookAt.x, cam.lookAt.y, cam.lookAt.z);
    this.shotCam.fov = cam.fov;
    this.shotCam.rotation.z += (cam.roll * Math.PI) / 180;
    // Re-apply lookAt then roll around view axis
    this.shotCam.lookAt(cam.lookAt.x, cam.lookAt.y, cam.lookAt.z);
    this.shotCam.rotateZ((cam.roll * Math.PI) / 180);
    this.shotCam.updateProjectionMatrix();

    this.camGizmo.position.copy(this.shotCam.position);
    this.camGizmo.lookAt(cam.lookAt.x, cam.lookAt.y, cam.lookAt.z);

    const off = this.demo.scene.heroOffset ?? { x: 0, y: 0, z: 0 };
    const headYaw = this.demo.scene.headYawDeg ?? 0;
    poseMannequin(this.hero, this.demo.mannequinAction, frame.actionPhase, headYaw);
    this.hero.position.x = off.x;
    this.hero.position.y = off.y;
    this.hero.position.z = off.z;
    // Keep lookAt tracking the hero after composition offset.
    this.lightTarget.position.set(off.x, 1.4 + off.y, off.z);

    if (this.other) poseMannequin(this.other, "idle", frame.actionPhase * 0.7);

    if (this.bokehPass) {
      const uniforms = this.bokehPass.uniforms as {
        focus: { value: number };
        aperture: { value: number };
        maxblur: { value: number };
      };
      uniforms.focus.value = cam.focusDistance;
      const dof = this.demo.dofStrength + this.demo.post.bokehBoost * 0.5;
      uniforms.aperture.value = 0.00008 + dof * 0.00055;
      uniforms.maxblur.value = 0.002 + dof * 0.012;
      this.bokehPass.enabled = dof > 0.12;
    }

    if (this.gradePass) {
      applyGradeUniforms(this.gradePass.material as THREE.ShaderMaterial, this.demo.post, frame.opacity, this.u * 6);
    }

    // Split diopter: exaggerate dual focus via bokeh focus mid-way oscillation — visual cue on FG prop.
    if (this.demo.post.splitDiopter && this.macro) {
      this.macro.scale.setScalar(1.4);
    }
  }

  private renderOnce(): void {
    if (!this.renderer || !this.composer) return;
    const cam = this.viewMode === "schematic" ? this.schematicCam : this.shotCam;
    const pass = this.composer.passes[0] as RenderPass;
    pass.camera = cam;
    if (this.bokehPass) this.bokehPass.enabled = this.viewMode === "shot" && (this.bokehPass.enabled);
    this.composer.render();
  }

  private loop = (ts: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible || !this.renderer) return;

    const dt = this.lastTs ? Math.min(0.05, (ts - this.lastTs) / 1000) : 0;
    this.lastTs = ts;
    this.accum += dt * 1000;
    if (this.accum < this.frameBudgetMs && !this.needsFrame) {
      if (this.viewMode === "schematic" && this.controls?.enabled) {
        this.controls.update();
        this.renderOnce();
      }
      return;
    }
    this.accum = 0;

    if (this.playing && this.demo) {
      this.u += dt / this.demo.duration;
      if (this.u >= 1) {
        this.u = 1;
        this.playing = false;
      }
      this.needsFrame = true;
    }

    if (this.precip && dt > 0) tickPrecip(this.precip, dt);
    if (this.controls && this.viewMode === "schematic") this.controls.update();

    if (this.needsFrame || this.playing || this.viewMode === "schematic") {
      this.applyFrame();
      this.renderOnce();
      this.needsFrame = false;
    }
  };
}
