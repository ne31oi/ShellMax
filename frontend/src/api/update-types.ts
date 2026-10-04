export interface EngineUpdateComponent {
  id: string;
  name: string;
  kind: "core" | "nodes" | "dependencies";
  current: string;
  latest: string;
  current_label?: string;
  latest_label?: string;
  available: boolean;
  blocked: string | null;
  error: string | null;
}

export interface EngineUpdateStatus {
  phase: "idle" | "checking" | "ready" | "preparing" | "backup" | "installing" | "verifying" | "restoring" | "done" | "error";
  message: string;
  checked_at: number | null;
  check_id: string | null;
  active: boolean;
  installing: boolean;
  can_restore: boolean;
  backup: string | null;
  components: EngineUpdateComponent[];
  packages: { name: string; current: string | null; latest: string }[];
  log: string[];
}
