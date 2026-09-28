import type { Generation } from "./types";
import type { Plan, Track, TimelineDoc } from "../store/timeline";

export interface Passport {
  concept: string; hero: string; costume: string; locations: string; palette: string;
  constraints: string; aspect: string; lipsync: string;
}
export interface CameraCard {
  support: string; start: string; path: string; orientation: string; lens_focus: string;
  speed: string; anchor_parallax: string; end: string;
}
export interface Shot {
  id: string; name: string; start: number; duration: number; idea: string; action: string;
  music: string; subject_motion: string; background_motion: string; incoming_cut: string;
  outgoing_cut: string; camera: CameraCard; light: string; ref_ids: string[]; lipsync: boolean; prompt: string;
}
export interface BlockVersion {
  version: number; shots: Shot[]; review: string[]; draft_approved: boolean; final_approved: boolean;
  selected_draft: Record<string, number>; selected_final: Record<string, number>;
}
export interface ClipBlock {
  id: string; name: string; start: number; end: number; intent: string; versions: BlockVersion[]; stale: boolean;
}
export interface Section { start: number; end: number; label: string; tentative: boolean }
export interface AudioAnalysis {
  fingerprint: string; start: number; end: number; lyrics: string; sections: Section[];
  words: { start: number; end: number; word: string; probability: number }[];
  beats: number[]; energy: number[][]; changes: number[][]; pauses: number[][]; repetitions: number[][]; warnings: string[];
}
export interface ClipDocument {
  name: string; idea: string; audio_asset_id: number; audio_start: number; audio_end: number;
  ref_ids: string[]; passport: Passport; passport_approved: boolean; analysis: AudioAnalysis | null;
  blocks: ClipBlock[]; quality: "draft" | "standard" | "high";
  messages: { role: string; content: string }[];
}
export type OperationKind = "analyze" | "discuss" | "treatment" | "develop" | "generate" | "review" | "preview";
export interface ClipJob {
  id: string; clip_id: string; kind: OperationKind | "download_audio";
  status: "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";
  stage: string; progress: number; base_revision: number; error: string | null;
  request: { block_id?: string; mode?: "draft" | "final"; selections?: Record<string, number> };
  result: { text?: string; analysis?: AudioAnalysis; passport?: Passport; blocks?: ClipBlock[];
    block_id?: string; shots?: Shot[]; review?: string[]; technical?: string[]; observations?: string[];
    notice?: string; asset_id?: number; failed?: number[]; previous_document?: ClipDocument };
}
export interface ClipProject {
  id: string; project_id: number; chat_id: string; revision: number; document: ClipDocument;
  jobs: ClipJob[]; takes: Generation[];
}
export interface ClipListItem { id: string; name: string; revision: number }
export interface ClipEdit {
  passport?: Passport; name?: string; idea?: string; lyrics?: string; sections?: Section[]; ref_ids?: string[];
  quality?: "draft" | "standard" | "high"; audio_asset_id?: number; audio_start?: number; audio_end?: number;
}
export interface ClipOperation {
  kind: OperationKind; text?: string; block_id?: string; mode?: "draft" | "final";
  selections?: Record<string, number>; shot_ids?: string[];
}
export interface PlanProposal { revision: number; track_id: string; plans: Plan[]; audio_track: Track }
export interface AssemblyProposal { revision: number; timeline: TimelineDoc }
