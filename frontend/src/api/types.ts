export type RefKind = "image" | "video" | "audio";

export interface Upload {
  id: string;
  kind: RefKind;
  orig_name: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  has_audio: boolean;
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

export interface Generation {
  id: number;
  project_id: number;
  status: GenStatus;
  stage: Stage | null;
  progress: number;
  ui_params: UIParams;
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
