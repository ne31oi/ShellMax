import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, urls } from "../../api/client";
import type { CropBox, RefItem, Upload } from "../../api/types";
import { tagOf } from "../../lib/refs";
import { useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { CropEditor } from "../face/CropEditor";
import { Button, Dialog, Select, Spinner } from "../ui";
import { TrimBar } from "./TrimBar";

const VIDEO_MIN = 2;
const VIDEO_MAX = 15; // the model expects 2-15 s video references

/** Crop / fragment of a reference. Always edits the original file; applying makes a derived file. */
export function RefEditor() {
  const uid = useUI((s) => s.refEditor);
  const refs = useForm((s) => s.refs);
  const item = refs.find((r) => r.uid === uid);
  const close = () => useUI.getState().openRefEditor(null);
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && close()} title={item ? `Изменить ${tagOf(refs, item.uid)}` : ""} wide>
      {item && <Body key={item.uid + item.upload.id} item={item} onDone={close} />}
    </Dialog>
  );
}

function Body({ item, onDone }: { item: RefItem; onDone: () => void }) {
  const cur = item.upload;
  const [src, setSrc] = useState<Upload | null>(cur.source_id ? null : cur);
  const [crop, setCrop] = useState<CropBox | null>(cur.edit?.crop ?? null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [ratio, setRatio] = useState("free");
  const [peaks, setPeaks] = useState<number[]>();
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const formAspect = useForm((s) => s.aspect.split(" ")[0]); // "16:9"

  useEffect(() => {
    if (cur.source_id) api.uploadInfo(cur.source_id).then(setSrc).catch(() => setError("Оригинал референса не найден"));
  }, [cur.source_id]);
  useEffect(() => {
    if (!src || src.kind === "image") return;
    setRange([cur.edit?.start ?? 0, cur.edit?.end ?? src.duration ?? 0]);
    if (src.kind === "audio" || src.has_audio) api.uploadPeaks(src.id).then((r) => setPeaks(r.peaks)).catch(() => undefined);
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  // play only the chosen fragment
  useEffect(() => {
    const el = media.current;
    if (!el || !range) return;
    let raf = 0;
    const tick = () => {
      setPlayhead(el.currentTime);
      if (el.currentTime >= range[1]) {
        el.pause();
        el.currentTime = range[0];
      }
      if (!el.paused) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => { setPlaying(true); raf = requestAnimationFrame(tick); };
    const onPause = () => { setPlaying(false); setPlayhead(el.currentTime); };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [range, src]);

  if (!src) return <div className="flex h-40 items-center justify-center">{error ? <p className="text-xs text-bad">{error}</p> : <Spinner />}</div>;

  const duration = src.duration ?? 0;
  const mediaAspect = src.width && src.height ? src.width / src.height : 1;
  const length = range ? range[1] - range[0] : duration;
  const badLength = src.kind === "video" && (length < VIDEO_MIN || length > VIDEO_MAX);

  const seek = (t: number) => {
    if (media.current) media.current.currentTime = t;
    setPlayhead(t);
  };
  const togglePlay = () => {
    const el = media.current;
    if (!el || !range) return;
    if (!el.paused) return el.pause();
    if (el.currentTime < range[0] || el.currentTime >= range[1] - 0.05) el.currentTime = range[0];
    void el.play();
  };

  const ratioValue = (r: string) => {
    const [w, h] = (r === "video" ? formAspect : r).split(":").map(Number);
    return w && h ? w / h : null;
  };
  const chooseRatio = (r: string) => {
    setRatio(r);
    const target = ratioValue(r);
    if (!target) return;
    // largest box of that ratio around the current region's centre
    const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const k = mediaAspect / target; // normalized height per normalized width
    let w = Math.max(c.w, c.h / k);
    let h = w * k;
    if (h > 1) [h, w] = [1, 1 / k];
    if (w > 1) [w, h] = [1, k];
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const x = Math.min(Math.max(cx - w / 2, 0), 1 - w), y = Math.min(Math.max(cy - h / 2, 0), 1 - h);
    setCrop({ x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) });
  };

  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      const up = await api.editUpload(src.id, {
        crop: src.kind === "audio" ? null : crop,
        start: range?.[0] ?? null,
        end: range?.[1] ?? null,
      });
      useForm.getState().replaceRefUpload(item.uid, up);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось применить");
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    useForm.getState().replaceRefUpload(item.uid, src);
    onDone();
  };

  const fileUrl = urls.uploadFile(src.id);
  const ratioOptions = [
    { value: "free", label: "Свободно" },
    { value: "video", label: `Как у видео (${formAspect})` },
    { value: "1:1", label: "1:1" },
    { value: "3:4", label: "3:4" },
    { value: "4:3", label: "4:3" },
    { value: "9:16", label: "9:16" },
    { value: "16:9", label: "16:9" },
  ];

  return (
    <div className="space-y-4 p-5">
      {src.kind !== "audio" && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex w-full items-end gap-3">
            <div className="w-48">
              <Select label="Пропорции области" value={ratio} onChange={chooseRatio} options={ratioOptions} />
            </div>
            <p className="pb-1.5 text-xs text-muted">
              Выделите область, которую увидит модель. Всё за рамкой отрежется. {crop && (
                <button className="text-accent hover:underline" onClick={() => { setCrop(null); setRatio("free"); }}>Весь кадр</button>
              )}
            </p>
          </div>
          <CropEditor
            src={fileUrl}
            value={crop}
            onChange={setCrop}
            ratio={ratioValue(ratio)}
            mediaAspect={mediaAspect}
            heightClass="max-h-[52vh]"
            media={src.kind === "video" ? (
              <video ref={media} src={fileUrl} preload="auto" playsInline className="block max-h-[52vh] w-auto" />
            ) : undefined}
          />
          {crop && src.width && src.height && (
            <p className="text-[11px] tabular-nums text-faint">
              {Math.round(crop.w * src.width)}×{Math.round(crop.h * src.height)} px из {src.width}×{src.height}
            </p>
          )}
        </div>
      )}

      {src.kind !== "image" && range && (
        <div className="space-y-2">
          {src.kind === "audio" && <audio ref={media} src={fileUrl} preload="auto" />}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={togglePlay}>
              {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? "Пауза" : "Фрагмент"}
            </Button>
            <span className="text-xs text-muted">
              Выберите фрагмент {src.kind === "audio" ? "звука" : "видео"}: тяните края или саму подсветку.
            </span>
          </div>
          <TrimBar
            duration={duration}
            start={range[0]}
            end={range[1]}
            onChange={(s, e) => setRange([s, e])}
            peaks={peaks}
            playhead={playhead}
            onSeek={seek}
          />
          {badLength && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-warn">
              Модель ожидает видео-референс длиной {VIDEO_MIN}–{VIDEO_MAX} с.
              {length > VIDEO_MAX && (
                <button className="text-accent hover:underline" onClick={() => setRange([range[0], range[0] + VIDEO_MAX])}>
                  Взять {VIDEO_MAX} с от начала фрагмента
                </button>
              )}
            </p>
          )}
        </div>
      )}

      {error && <p className="text-xs text-bad">{error}</p>}

      <div className="flex items-center gap-2 border-t border-line pt-4">
        {cur.source_id && (
          <Button variant="ghost" onClick={reset} title="Вернуть исходный файл целиком">
            <RotateCcw size={14} /> Сбросить
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onDone}>Отмена</Button>
        <Button variant="primary" onClick={apply} disabled={busy}>
          {busy && <Spinner />} Применить
        </Button>
      </div>
    </div>
  );
}
