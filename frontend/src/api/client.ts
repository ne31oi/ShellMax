import type {
  AssistantEvent,
  Chat,
  ChatAttachment,
  ChatInfo,
  Estimate,
  AssistantModel,
  AssistantSettings,
  AssistantStatus,
  CropBox,
  EngineProfile,
  EnhanceDefaults,
  EnhanceUIParams,
  FaceDefaults,
  FaceUIParams,
  InterpolateDefaults,
  InterpolateUIParams,
  EngineState,
  FsListing,
  Generation,
  MediaAsset,
  Meta,
  ProfileRow,
  Project,
  QualityPresetValues,
  QualitySettings,
  ScannedModel,
  Style,
  UIParams,
  Upload,
} from "./types";
import { useUI } from "../store/ui";
import type { ClipProject, ClipListItem, ClipEdit, ClipOperation, ClipJob, PlanProposal, AssemblyProposal } from "./clip-types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const looksHtml = /^\s*</.test(text);
  if (!res.ok || looksHtml) {
    let detail: unknown = null;
    if (!looksHtml) {
      try {
        detail = JSON.parse(text).detail;
      } catch {
        /* not json */
      }
    }
    const message = looksHtml
      ? "Сервер вернул HTML вместо API — перезапустите ShellMax (кнопка питания в шапке)"
      : typeof detail === "string"
        ? detail
        : detail && typeof detail === "object" && "message" in detail
          ? String((detail as { message: unknown }).message)
          : `Ошибка ${res.status}`;
    throw new ApiError(message, looksHtml ? 502 : res.status, detail);
  }
  return JSON.parse(text) as T;
}

const get = <T>(url: string) => request<T>("GET", url);
const post = <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {});
const put = <T>(url: string, body: unknown) => request<T>("PUT", url, body);
const del = <T>(url: string) => request<T>("DELETE", url);

const q = (params: Record<string, string | number>) =>
  "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

/** Active project for REST calls that scope media/jobs. */
function pid(explicit?: number): number {
  return explicit ?? useUI.getState().projectId;
}

export const api = {
  clipProjects: (projectId: number) => get<ClipListItem[]>(`/api/assistant/clip-projects?project_id=${projectId}`),
  clipProject: (id: string) => get<ClipProject>(`/api/assistant/clip-projects/${id}`),
  clipRevisions: (id: string) => get<{ revision: number; document: ClipProject["document"] }[]>(`/api/assistant/clip-projects/${id}/revisions`),
  createClipProject: (body: { project_id: number; idea: string; audio_asset_id: number; ref_ids: string[]; audio_start?: number; audio_end?: number }) =>
    post<ClipProject>("/api/assistant/clip-projects", body),
  editClipProject: (id: string, revision: number, patch: ClipEdit) =>
    request<ClipProject>("PATCH", `/api/assistant/clip-projects/${id}`, { revision, ...patch }),
  clipOperation: (id: string, revision: number, operation: ClipOperation) =>
    post<ClipJob>(`/api/assistant/clip-projects/${id}/operations`, { revision, ...operation }),
  acceptClipProposal: (id: string, jid: string, revision: number) => post<ClipProject>(`/api/assistant/clip-projects/${id}/accept/${jid}`, { revision }),
  approveClipPassport: (id: string, revision: number) => post<ClipProject>(`/api/assistant/clip-projects/${id}/approve-passport`, { revision }),
  approveClipBlock: (id: string, bid: string, revision: number, mode: "draft" | "final", selections: Record<string, number>) =>
    post<ClipProject>(`/api/assistant/clip-projects/${id}/blocks/${bid}/approve`, { revision, mode, selections }),
  clipPlanProposal: (id: string, bid: string) => get<PlanProposal>(`/api/assistant/clip-projects/${id}/blocks/${bid}/timeline`),
  clipAssembly: (id: string) => get<AssemblyProposal>(`/api/assistant/clip-projects/${id}/assembly`),
  stopClipJob: (id: string, jid: string) => post(`/api/assistant/clip-projects/${id}/jobs/${jid}/stop`),
  audioModel: () => get<{ ready: boolean; job: ClipJob | null }>("/api/assistant/audio-model"),
  downloadAudioModel: () => post<ClipJob>("/api/assistant/audio-model/download"),
  meta: () => get<Meta>("/api/meta"),
  estimate: (aspect: string, quality: string, duration: number, profileId?: number | null) =>
    get<Estimate>("/api/estimate" + q({ aspect, quality, duration, ...(profileId != null ? { profile_id: profileId } : {}) })),

  uiState: () => get<Record<string, unknown>>("/api/state/ui"),
  saveUiState: (value: Record<string, unknown>) => put("/api/state/ui", value),

  engine: () => get<EngineState>("/api/engine"),
  engineAction: (action: "start" | "stop" | "restart") => post<EngineState>(`/api/engine/${action}`),
  restartAll: () => post<{ ok: boolean }>("/api/system/restart"),
  engineOptions: () => get<{ sampler: string[]; scheduler: string[]; live: boolean }>("/api/engine/options"),
  engineLog: () => get<{ lines: string[] }>("/api/engine/log"),

  profiles: () => get<ProfileRow[]>("/api/profiles"),
  workflowDefaults: () => get<EngineProfile>("/api/profiles/workflow-defaults"),
  createProfile: (data: EngineProfile, is_default = false) => post<{ id: number }>("/api/profiles", { data, is_default }),
  updateProfile: (id: number, data: EngineProfile, is_default = false) =>
    put<{ ok: boolean; problems: ProfileRow["problems"] }>(`/api/profiles/${id}`, { data, is_default }),
  deleteProfile: (id: number) => del(`/api/profiles/${id}`),

  styles: () => get<Style[]>("/api/styles"),
  createStyle: (s: Omit<Style, "id" | "preview_asset_id">) => post<Style>("/api/styles", s),
  updateStyle: (id: number, s: Omit<Style, "id" | "preview_asset_id">) => put<Style>(`/api/styles/${id}`, s),
  deleteStyle: (id: number) => del(`/api/styles/${id}`),

  quality: () => get<QualitySettings>("/api/quality"),
  saveQuality: (presets: Record<string, QualityPresetValues>) => put<QualitySettings>("/api/quality", { presets }),
  resetQuality: () => post<QualitySettings>("/api/quality/reset"),

  projects: () => get<Project[]>("/api/projects"),
  project: (id: number) => get<Project>(`/api/projects/${id}`),
  createProject: (name: string) => post<Project>("/api/projects", { name }),
  renameProject: (id: number, name: string) =>
    request<Project>("PATCH", `/api/projects/${id}`, { name }),
  saveTimeline: (projectId: number, timeline: unknown) =>
    put(`/api/projects/${projectId}/timeline`, timeline),
  exportTimeline: (projectId?: number) => post<MediaAsset>(`/api/projects/${pid(projectId)}/export`),
  enqueuePlans: (projectId: number, planIds: string[], mode: "draft" | "final") =>
    post<{ generations: Generation[]; timeline: unknown }>(`/api/projects/${projectId}/plans/enqueue`, {
      plan_ids: planIds,
      mode,
    }),
  analyzeBeats: (assetId: number, range?: { start?: number; end?: number }) =>
    post<{
      beats: number[];
      downbeats: number[];
      bpm: number | null;
      offset: number;
      windowStart?: number;
      timespace?: "file" | "timeline";
    }>(`/api/assets/${assetId}/analyze-beats`, range ?? {}),
  /** Alias used by plan inspector (same as frameToRef). */
  assetFrameUpload: (assetId: number, t: number) => post<Upload>(`/api/assets/${assetId}/frame`, { t }),

  fsList: (path: string) => get<FsListing>("/api/fs/list" + q({ path })),
  fsCheck: (path: string) => get<{ path: string; exists: boolean; size: number | null; name: string }>("/api/fs/check" + q({ path })),
  scanModels: () => get<Record<string, ScannedModel[]>>("/api/models/scan"),

  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<Upload>("POST", "/api/uploads", fd);
  },
  /** Unique refs used in generations / plans (Import tab). */
  listUsedUploads: () => get<Upload[]>("/api/uploads?used=true"),
  uploadInfo: (id: string) => get<Upload>(`/api/uploads/${id}`),
  chats: () => get<ChatInfo[]>("/api/assistant/chats"),
  chat: (id: string) => get<Chat>(`/api/assistant/chats/${id}`),
  createChat: () => post<Chat>("/api/assistant/chats"),
  deleteChat: (id: string) => del<{ ok: boolean }>(`/api/assistant/chats/${id}`),
  uploadChatAttachment: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<ChatAttachment>("POST", "/api/assistant/attachments", fd);
  },
  editUpload: (id: string, body: { crop: CropBox | null; start: number | null; end: number | null }) =>
    post<Upload>(`/api/uploads/${id}/edit`, body),
  uploadPeaks: (id: string) => get<{ peaks: number[]; duration: number | null }>(`/api/uploads/${id}/peaks`),
  assetPeaks: (id: number) => get<{ peaks: number[]; duration: number | null }>(`/api/assets/${id}/peaks`),

  generations: (projectId?: number) => get<Generation[]>("/api/generations" + q({ project_id: pid(projectId) })),
  generate: (params: UIParams, projectId?: number) =>
    post<Generation[]>("/api/generations" + q({ project_id: pid(projectId) }), params),
  retry: (id: number, same_seed: boolean, variants = 1) =>
    post<Generation[]>(`/api/generations/${id}/retry`, { same_seed, variants }),
  cancel: (id: number) => post(`/api/generations/${id}/cancel`),
  cancelAll: () => post<{ ok: boolean; cancelled: number[] }>("/api/generations/cancel-all"),
  deleteGeneration: (id: number) => del(`/api/generations/${id}`),

  faceDefaults: (assetId: number) => get<FaceDefaults>("/api/face/defaults" + q({ asset_id: assetId })),
  faceDetect: (uploadId: string) => post<{ found: boolean; crop: CropBox }>("/api/face/detect", { upload_id: uploadId }),
  faceRefine: (params: FaceUIParams, projectId?: number) =>
    post<Generation>("/api/face" + q({ project_id: pid(projectId) }), params),
  faceEstimate: (assetId: number) => get<Estimate>("/api/face/estimate" + q({ asset_id: assetId })),

  enhanceDefaults: (assetId: number) => get<EnhanceDefaults>("/api/enhance/defaults" + q({ asset_id: assetId })),
  enhanceEstimate: (assetId: number, scale: number) =>
    get<Estimate>("/api/enhance/estimate" + q({ asset_id: assetId, scale })),
  enhance: (params: EnhanceUIParams, projectId?: number) =>
    post<Generation>("/api/enhance" + q({ project_id: pid(projectId) }), params),

  interpolateDefaults: (assetId: number) =>
    get<InterpolateDefaults>("/api/interpolate/defaults" + q({ asset_id: assetId })),
  interpolateEstimate: (assetId: number, multiplier: number, model: string) =>
    get<Estimate>("/api/interpolate/estimate" + q({ asset_id: assetId, multiplier, model })),
  interpolate: (params: InterpolateUIParams, projectId?: number) =>
    post<Generation>("/api/interpolate" + q({ project_id: pid(projectId) }), params),

  assistantStatus: () => get<AssistantStatus>("/api/assistant/status"),
  assistantModels: () => get<AssistantModel[]>("/api/assistant/models"),
  assistantDownload: () => post("/api/assistant/download"),
  assistantSettings: () => get<AssistantSettings>("/api/assistant/settings"),
  saveAssistantSettings: (s: AssistantSettings) => put("/api/assistant/settings", s),
  assistantStop: () => post("/api/assistant/stop"),
  assistantUnload: () => post("/api/assistant/unload"),

  assets: (projectId?: number) => get<MediaAsset[]>("/api/assets" + q({ project_id: pid(projectId) })),
  assetAsUpload: (assetId: number) => post<Upload>(`/api/assets/${assetId}/as-upload`),
  frameToRef: (assetId: number, t: number) => post<Upload>(`/api/assets/${assetId}/frame`, { t }),
  importAsset: (file: File, projectId?: number) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<MediaAsset>("POST", "/api/assets/import" + q({ project_id: pid(projectId) }), fd);
  },
  reveal: (assetId: number) => post(`/api/assets/${assetId}/reveal`),
  deleteAsset: (assetId: number) => del(`/api/assets/${assetId}`),
};

export const urls = {
  uploadThumb: (id: string) => `/api/uploads/${id}/thumb`,
  uploadFile: (id: string) => `/api/uploads/${id}/file`,
  chatAttachment: (id: string) => `/api/assistant/attachments/${id}`,
  assetFile: (id: number) => `/api/assets/${id}/file`,
  assetThumb: (id: number) => `/api/assets/${id}/thumb`,
};

/** POST that answers with server-sent events; calls onEvent per `data:` line. */
export async function streamAssistant(url: string, body: unknown, onEvent: (e: AssistantEvent) => void, signal?: AbortSignal) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    let msg = `Ошибка ${res.status}`;
    try {
      const d = (await res.json()).detail;
      if (typeof d === "string") msg = d;
    } catch {
      /* not json */
    }
    throw new ApiError(msg, res.status, null);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const ev of events) {
      const line = ev.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)) as AssistantEvent);
      } catch {
        /* partial chunk */
      }
    }
  }
}
