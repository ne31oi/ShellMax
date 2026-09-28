import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { ClipJob } from "../../api/clip-types";
import { Button, SectionTitle, Spinner } from "../ui";

export function AudioModelSettings() {
  const [status, setStatus] = useState<{ ready: boolean; job: ClipJob | null } | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => api.audioModel().then((s) => { if (alive) setStatus(s); }).catch((e: Error) => { if (alive) setError(e.message); });
    void reload(); const timer = setInterval(() => void reload(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const busy = starting || status?.job?.status === "queued" || status?.job?.status === "running";
  return <section className="space-y-2 rounded-xl border border-line p-3">
    <SectionTitle>Анализ аудио для клипа</SectionTitle>
    <p className="text-xs text-muted">Whisper medium · распознавание слов и таймкодов локально на CPU. Одна загрузка модели, затем работа без сети.</p>
    {status?.ready ? <p className="text-xs text-ok">Модель готова</p> : <Button size="sm" disabled={busy || !status} onClick={async () => {
      setStarting(true); setError("");
      try { const job = await api.downloadAudioModel(); setStatus({ ready: false, job }); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setStarting(false); }
    }}>{busy ? <Spinner size={12} /> : null}{busy ? "Скачиваю модель…" : "Скачать модель слов"}</Button>}
    {(error || status?.job?.error) && <p role="alert" className="text-xs text-bad">{error || status?.job?.error}</p>}
  </section>;
}
