import { useRef, useState } from "react";
import { urls } from "../../api/client";
import type { HeadSwapTarget, MediaAsset } from "../../api/types";
import { SectionTitle } from "../ui";
import { CropEditor } from "./CropEditor";

/** A selection always belongs to one decoded frame; seeking discards the old rectangle. */
export function HeadSwapTargetEditor({ asset, value, onChange }: {
  asset: MediaAsset; value: HeadSwapTarget | null; onChange: (target: HeadSwapTarget | null) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState(value?.frame_index ?? 0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const fps = asset.fps || 24;
  const lastFrame = Math.max(0, Math.round((asset.duration || 0) * fps) - 1);
  const seek = (next: number) => {
    setFrame(next);
    setReady(false);
    onChange(null);
    if (video.current) video.current.currentTime = next / fps;
  };
  return <section className="space-y-2">
    <SectionTitle>Кого заменяем в клипе</SectionTitle>
    <p className="text-xs text-muted">Обведите только нужную голову целиком, включая волосы и уши.
      Выберите кадр, на котором лицо хорошо видно.</p>
    <div className="flex justify-center" data-testid="head-swap-target">
      <CropEditor src={urls.assetFile(asset.id)} value={value?.box ?? null} emptySelection minSize={0.01}
        onChange={(box) => { if (ready) onChange({ frame_index: frame, box }); }}
        heightClass="max-h-56 max-w-full" mediaAspect={(asset.width || 1) / (asset.height || 1)}
        media={<video ref={video} src={urls.assetFile(asset.id)} preload="auto" muted playsInline
          className="block max-h-56 max-w-full w-auto" aria-label="Кадр для выбора исходной головы"
          onLoadedData={() => {
            if (video.current && frame > 0) video.current.currentTime = frame / fps;
            else setReady(true);
          }} onSeeked={() => setReady(true)} onError={() => setFailed(true)} />} />
    </div>
    {failed ? <p className="text-xs text-bad">Не удалось открыть видео — выберите другой клип.</p> :
      <label className="flex items-center gap-3 text-[11px] text-faint">
        <span className="shrink-0 tabular-nums">Кадр {frame + 1} · {(frame / fps).toFixed(2)} с</span>
        <input className="w-full accent-accent" type="range" min={0} max={lastFrame} step={1}
          value={frame} onChange={(e) => seek(Number(e.target.value))} aria-label="Кадр выбора головы" />
      </label>}
    <div className="flex items-center justify-between text-[11px]">
      <span className={value ? "text-accent" : "text-faint"}>{value ? "Исходная голова выбрана" : "Нарисуйте рамку на видео"}</span>
      {value && <button className="text-muted hover:text-text" onClick={() => onChange(null)}>Выбрать заново</button>}
    </div>
  </section>;
}
