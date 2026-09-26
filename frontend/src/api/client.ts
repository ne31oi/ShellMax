import type {
  EngineProfile,
  EngineState,
  FsListing,
  Generation,
  MediaAsset,
  Meta,
  ProfileRow,
  ScannedModel,
  Style,
  UIParams,
  Upload,
} from "./types";

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
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* not json */
    }
    const message =
      typeof detail === "string"
        ? detail
        : detail && typeof detail === "object" && "message" in detail
          ? String((detail as { message: unknown }).message)
          : `Ошибка ${res.status}`;
    throw new ApiError(message, res.status, detail);
  }
  return res.json() as Promise<T>;
}

const get = <T>(url: string) => request<T>("GET", url);
const post = <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {});
const put = <T>(url: string, body: unknown) => request<T>("PUT", url, body);
const del = <T>(url: string) => request<T>("DELETE", url);

const q = (params: Record<string, string | number>) =>
  "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

export const api = {
  meta: () => get<Meta>("/api/meta"),
  estimate: (aspect: string, quality: string, duration: number) =>
    get<{ seconds: number }>("/api/estimate" + q({ aspect, quality, duration })),

  uiState: () => get<Record<string, unknown>>("/api/state/ui"),
  saveUiState: (value: Record<string, unknown>) => put("/api/state/ui", value),

  engine: () => get<EngineState>("/api/engine"),
  engineAction: (action: "start" | "stop" | "restart") => post<EngineState>(`/api/engine/${action}`),
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

  fsList: (path: string) => get<FsListing>("/api/fs/list" + q({ path })),
  fsCheck: (path: string) => get<{ path: string; exists: boolean; size: number | null; name: string }>("/api/fs/check" + q({ path })),
  scanModels: () => get<Record<string, ScannedModel[]>>("/api/models/scan"),

  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<Upload>("POST", "/api/uploads", fd);
  },
  uploadInfo: (id: string) => get<Upload>(`/api/uploads/${id}`),

  generations: () => get<Generation[]>("/api/generations"),
  generate: (params: UIParams) => post<Generation[]>("/api/generations", params),
  retry: (id: number, same_seed: boolean, variants = 1) =>
    post<Generation[]>(`/api/generations/${id}/retry`, { same_seed, variants }),
  cancel: (id: number) => post(`/api/generations/${id}/cancel`),
  deleteGeneration: (id: number) => del(`/api/generations/${id}`),

  assets: () => get<MediaAsset[]>("/api/assets"),
  assetAsUpload: (assetId: number) => post<Upload>(`/api/assets/${assetId}/as-upload`),
  frameToRef: (assetId: number, t: number) => post<Upload>(`/api/assets/${assetId}/frame`, { t }),
  importAsset: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<MediaAsset>("POST", "/api/assets/import", fd);
  },
  reveal: (assetId: number) => post(`/api/assets/${assetId}/reveal`),
};

export const urls = {
  uploadThumb: (id: string) => `/api/uploads/${id}/thumb`,
  uploadFile: (id: string) => `/api/uploads/${id}/file`,
  assetFile: (id: number) => `/api/assets/${id}/file`,
  assetThumb: (id: number) => `/api/assets/${id}/thumb`,
};
