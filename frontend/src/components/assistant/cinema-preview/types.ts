/** Demo profiles and resolved preview state for cinematography techniques. */

export const DEMO_DURATION_S = 6;
export const PREVIEW_FPS = 30;

export const CAT = {
  motion: "Движение камеры",
  framing: "Крупность и тип плана",
  angle: "Ракурс и точка зрения",
  optics: "Объективы и оптика",
  composition: "Композиция",
  light: "Свет",
  focus: "Фокус и глубина резкости",
  color: "Цвет и плёночный образ",
  time: "Время и движение",
  fx: "Оптические и внутрикамерные эффекты",
  atmosphere: "Атмосфера и погода",
  editing: "Монтаж и переходы",
  genre: "Жанровый образ",
} as const;

export type CategoryName = (typeof CAT)[keyof typeof CAT];

export type FramingKind =
  | "extremeWide"
  | "establishing"
  | "master"
  | "wide"
  | "full"
  | "cowboy"
  | "medium"
  | "mcu"
  | "cu"
  | "ecu"
  | "insert"
  | "cutaway"
  | "reaction"
  | "twoShot"
  | "ots";

export type CameraSupport =
  | "tripod"
  | "dolly"
  | "handheld"
  | "crane"
  | "drone"
  | "steadicam"
  | "gimbal"
  | "orbit";

export type PathKind = "hold" | "linear" | "arc" | "whip" | "orbit" | "crane" | "follow";

export type PrecipKind = "none" | "rain" | "snow" | "embers" | "dust" | "smoke" | "haze" | "fog" | "mist";

export type GradeKind =
  | "natural"
  | "warm"
  | "cool"
  | "tealOrange"
  | "desat"
  | "hypersat"
  | "mono"
  | "bleach"
  | "palette";

export type EditKind =
  | "none"
  | "match"
  | "graphic"
  | "action"
  | "jump"
  | "smash"
  | "dissolve"
  | "fade"
  | "cross"
  | "axial"
  | "invisible"
  | "jl"
  | "quick";

export type MannequinAction = "idle" | "walk" | "turn" | "react" | "raiseHand" | "lookAside";

export type CompositionKind =
  | "thirds"
  | "center"
  | "symmetry"
  | "asymmetry"
  | "leading"
  | "vanishing"
  | "frameInFrame"
  | "negative"
  | "foreground"
  | "layered"
  | "weight"
  | "figureGround"
  | "tonal"
  | "leadRoom"
  | "shortSiding"
  | "dirty"
  | "clean";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraKeyframe {
  pos: Vec3;
  lookAt: Vec3;
  fov: number;
  roll: number;
  focusDistance: number;
}

/** Per-technique demo profile. Sparse fields override defaults when reconciled. */
export interface DemoProfile {
  id: string;
  category: CategoryName | string;
  framing?: FramingKind;
  support?: CameraSupport;
  path?: PathKind;
  /** Focal length in mm (full-frame equivalent). */
  focalMm?: number;
  start?: CameraKeyframe;
  end?: CameraKeyframe;
  subjectSizeLock?: boolean;
  roll?: number;
  focusDistance?: number;
  focusEnd?: number;
  dofStrength?: number;
  splitDiopter?: boolean;
  fisheye?: number;
  anamorphic?: number;
  composition?: CompositionKind;
  light?: Partial<LightState>;
  grade?: GradeKind;
  grain?: number;
  flare?: number;
  halation?: number;
  bokehBoost?: number;
  doubleExposure?: number;
  lightLeak?: number;
  chromatic?: number;
  forcedPerspective?: boolean;
  precip?: PrecipKind;
  wetDown?: boolean;
  fogDensity?: number;
  timeScale?: number;
  timeScaleEnd?: number;
  freezeAt?: number | null;
  motionBlur?: number;
  edit?: EditKind;
  audioCue?: "jcut" | "lcut";
  mannequinAction?: MannequinAction;
  secondMannequin?: boolean;
  doorway?: boolean;
  macroProp?: boolean;
  practical?: boolean;
  /** Applied as environment base before other categories. */
  genreBase?: boolean;
  /** Soft conflict tags checked by reconcile. */
  tags?: string[];
}

export interface LightState {
  keyAzimuth: number;
  keyElevation: number;
  keyIntensity: number;
  keyColor: string;
  keySoftness: number;
  fillIntensity: number;
  rimIntensity: number;
  rimAzimuth: number;
  ambient: number;
  underlight: number;
  eyeLight: number;
  practical: boolean;
  window: boolean;
  volumetric: boolean;
  gobo: boolean;
  tempBias: number;
}

export interface SceneProps {
  secondMannequin: boolean;
  doorway: boolean;
  macroProp: boolean;
  precip: PrecipKind;
  wetDown: boolean;
  fogDensity: number;
  /** Active composition kind for set dressing. */
  composition?: CompositionKind;
  heroOffset?: { x: number; y: number; z: number };
  headYawDeg?: number;
  doorwayClose?: boolean;
  corridor?: boolean;
  leadingLines?: boolean;
  hideDepthMarkers?: boolean;
  fgProp?: "none" | "architecture" | "plant" | "silhouette" | "layered";
  dirtyOccluder?: boolean;
  tonalBg?: boolean;
  figureGround?: boolean;
  weightWall?: boolean;
}

export interface PostState {
  grade: GradeKind;
  grain: number;
  flare: number;
  halation: number;
  bokehBoost: number;
  doubleExposure: number;
  lightLeak: number;
  chromatic: number;
  fisheye: number;
  anamorphic: number;
  motionBlur: number;
  splitDiopter: boolean;
  forcedPerspective: boolean;
}

export interface EditState {
  kind: EditKind;
  audioCue: "jcut" | "lcut" | null;
  cutAt: number;
}

export interface ResolvedDemo {
  duration: number;
  framing: FramingKind;
  support: CameraSupport;
  path: PathKind;
  subjectSizeLock: boolean;
  start: CameraKeyframe;
  end: CameraKeyframe;
  focusEnd: number;
  dofStrength: number;
  light: LightState;
  scene: SceneProps;
  post: PostState;
  edit: EditState;
  mannequinAction: MannequinAction;
  timeScale: number;
  timeScaleEnd: number;
  freezeAt: number | null;
  composition: CompositionKind;
  sourceIds: string[];
}

export interface ConflictInfo {
  reason: string;
  preferSoloId: string;
}

export interface ReconcileResult {
  demo: ResolvedDemo;
  conflict: ConflictInfo | null;
}

export type ViewMode = "shot" | "schematic";
export type FocusMode = "combined" | string;
