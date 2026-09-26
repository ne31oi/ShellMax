export type RefKind = "image" | "video" | "audio";

export interface Upload {
  id: string;
  kind: RefKind;
  orig_name: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  has_audio: boolean;
  source_id?: string | null; // set on an edited (cropped / trimmed) reference: the original upload
  edit?: { crop?: CropBox; start?: number; end?: number } | null;
}

/** A reference card in the generation panel. `uid` is stable across reorders (tags renumber). */
export interface RefItem {
  uid: string;
  upload: Upload;
  withAudio: boolean;
}

export interface LoraSpec {
  path: string;
  strength: number;
  enabled: boolean;
}

export interface ExpertParams {
  steps: number;
  scheduler: string;
  sampler: string;
  extend_steps: number;
  split_step: number;
  ref_image_size: "match" | "max";
  sparse_tau: number;
  sparse_start: number;
  sparse_end: number;
  low_vram_heads: number;
  chunk_ff_chunks: number;
  chunk_ff_seq_threshold: number;
  video_force_rate: number;
  crf: number;
}

export interface FaceRecipe {
  unet: string;
  lora: string;
  lora_strength: number;
  steps: number;
  sampler: string;
  scheduler: string;
  ref_image_size: "match" | "max";
  crop_factor: number;
  canvas: number;
  smooth_window: number;
  size_smooth_window: number;
  select: string;
  face_px_small: number;
  face_px_large: number;
  mask_dilation: number;
  feather: number;
  colour_match: number;
  blend: number;
  crf: number;
}

export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceUIParams {
  source_asset_id: number;
  identity_upload_id: string;
  closeup_upload_id: string | null;
  closeup_crop: CropBox | null;
  prompt: string;
  denoise: number;
  select: string | null;
  seed: number | null;
  profile_id: number | null;
}

export interface FaceStrength {
  id: string;
  label: string;
  denoise: number;
  hint: string;
}

export interface FaceDefaults {
  asset: MediaAsset;
  identity: Upload | null;
  closeup_crop: CropBox | null;
  prompt: string;
  source_prompt: string;
  frames: number;
  warnings: string[];
  presets: FaceStrength[];
}

export interface EngineProfile {
  name: string;
  unet: string;
  text_encoder: string;
  vae_video: string;
  vae_audio: string;
  upscaler: string;
  loras_main: LoraSpec[];
  loras_final: LoraSpec[];
  low_vram: boolean;
  expert: ExpertParams;
  face: FaceRecipe;
}

export interface ProfileRow {
  id: number;
  name: string;
  is_default: boolean;
  data: EngineProfile;
  problems: { field: string; path: string }[];
}

export interface Style {
  id: number;
  name: string;
  path: string;
  default_strength: number;
  triggers: string[];
  preview_asset_id: number | null;
}

export interface StyleChoice {
  style_id: number;
  strength: number;
}

export interface UIParams {
  prompt: string;
  refs: { kind: RefKind; upload_id: string; with_audio: boolean }[];
  aspect: string;
  duration: number;
  quality: string;
  styles: { style_id: number; strength: number | null }[];
  seed: number | null;
  variants: number;
  profile_id: number | null;
}

export type GenStatus = "queued" | "running" | "done" | "draft_only" | "error" | "cancelled";
export type Stage = "load" | "encode" | "pass1" | "draft" | "upscale" | "pass2" | "final" | "decode" | "done";

export type JobKind = "generate" | "face";

export interface Generation {
  id: number;
  project_id: number;
  kind: JobKind;
  source_asset_id: number | null; // face: the refined clip
  // stage_seconds: exact seconds per stage; cold: models were loaded from disk (left out of averages)
  info: { track_report?: string; stage_seconds?: Record<string, number>; cold?: boolean } | null;
  status: GenStatus;
  stage: Stage | null;
  progress: number;
  ui_params: UIParams & Partial<FaceUIParams>;
  full_params: Record<string, unknown> | null;
  seed: number;
  profile_name: string;
  draft_asset_id: number | null;
  output_asset_id: number | null;
  error: string | null;
  error_kind: "oom" | "missing_file" | "engine_down" | "generic" | null;
  /** live only: progress of the node running right now (e.g. sampler step 1 of 2) */
  step?: { value: number; max: number } | null;
  estimate_s: number | null;
  elapsed_s: number | null;
  created: string;
  started: string | null;
  finished: string | null;
}

export interface MediaAsset {
  id: number;
  project_id: number;
  kind: "video" | "image" | "audio";
  name: string;
  path: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  has_audio: boolean;
  source: "generated" | "draft" | "imported";
  generation_id: number | null;
  thumb: string | null;
  created: string;
}

export type EngineStateName = "not_installed" | "stopped" | "starting" | "ready" | "error" | "external";

export interface EngineState {
  state: EngineStateName;
  detail: string;
  url: string;
  pid: number | null;
}

export interface QualityPreset {
  id: string;
  label: string;
  resolutions: Record<string, { base: [number, number]; final: [number, number] }>;
}

export interface Meta {
  fps: number;
  aspects: { id: string; ratio: [number, number]; short: string }[];
  quality: QualityPreset[];
  duration: { min: number; max: number; optimal: [number, number] };
  max_refs: Record<RefKind, number>;
  defaults: { aspect: string; duration: number; quality: string; prompt_template: string };
  face_strength: FaceStrength[];
}

export interface FsListing {
  path: string;
  parent: string | null;
  dirs: string[];
  files: { name: string; size: number }[];
}

export interface ScannedModel {
  path: string;
  name: string;
  rel: string;
  size: number;
}

// ---------------------------------------------------------------- assistant (local LLM)
export interface AssistantFile {
  id: string;
  label: string;
  status: "ready" | "missing" | "downloading" | "error";
  received: number;
  total: number;
  error?: string | null;
}

export interface AssistantStatus {
  model: string;
  label: string;
  ready: boolean;
  files: AssistantFile[];
  total_bytes: number;
  received_bytes: number;
  downloading: boolean;
  running: boolean;
  starting: boolean;
  busy: boolean;
}

export interface AssistantModel {
  id: string;
  label: string;
  hint: string;
  ready: boolean;
  size: number; // bytes still to download
}

export interface AssistantSettings {
  model: string;
  device: "gpu" | "cpu";
  context_size: number;
  max_output_tokens: number;
  kv_cache: "off" | "q8_0" | "q5_1" | "q4_0";
  video_vision: boolean;
  sampling_override: boolean;
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  presence_penalty: number;
  frequency_penalty: number;
  repeat_penalty: number;
}

/** Ideas assistant chats (backend AssistantChat). */
export interface ChatAttachment {
  id: string;
  name: string;
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  attachment?: ChatAttachment;
}
export interface ChatInfo {
  id: string;
  title: string;
  updated: string;
  count: number;
}
export interface Chat {
  id: string;
  title: string;
  messages: ChatMessage[];
}

/** Time estimate from this machine's finished jobs (backend jobs/estimator.py). */
export interface Estimate {
  seconds: number;
  basis: "exact" | "scaled" | "prior"; // same-size average | scaled from other sizes | no history yet
  samples: number;
}

export type AssistantEvent =
  | { stage: "loading" | "writing" }
  | { delta: string }
  | { done: true; prompt: string; cancelled: boolean }
  | { error: string };
