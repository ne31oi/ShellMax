export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)} с`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m} мин ${s} с` : `${m} мин`;
}

/** "~3 мин" style estimate. */
export function fmtEstimate(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  if (seconds < 90) return `~${Math.max(10, Math.round(seconds / 10) * 10)} с`;
  return `~${Math.round(seconds / 60)} мин`;
}

export function fmtTimecode(t: number, fps = 24): string {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

export function fmtSeconds(t: number): string {
  return `${t.toFixed(t < 10 ? 1 : 0).replace(".", ",")} с`;
}

export function fmtSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1).replace(".", ",")} ГБ` : `${Math.round(bytes / 1024 ** 2)} МБ`;
}

export function frameCount(duration: number, fps = 24): number {
  // same as the workflow's Frame Count Calculator (node 75)
  const n = Math.max(5, Math.round(duration * fps));
  return n + ((((5 - (n % 17)) % 17) + 17) % 17);
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function stripQuotes(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "").trim();
}
