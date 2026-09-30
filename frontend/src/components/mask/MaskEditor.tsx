import { useEffect, useRef, useState, type PointerEvent } from "react";
import { urls } from "../../api/client";
import type { MaskKey, MaskLayer, MaskPoint, MaskSelection, MediaAsset, ShapeMaskLayer } from "../../api/types";
import { maskAt, putMaskKey } from "../../lib/mask-shapes";
import { Button, Select } from "../ui";
import { AutoMaskOverlay } from "./AutoMaskOverlay";
import type { PointMode } from "./MaskTrackingControls";

export function MaskEditor({ asset, layers, onChange, start, end, pointMode, selection, onPoint }: {
  asset: MediaAsset; layers: MaskLayer[]; onChange: (layers: MaskLayer[]) => void; start: number; end: number;
  pointMode: PointMode; selection: MaskSelection; onPoint: (time: number, point: MaskPoint, mode: Exclude<PointMode, null>) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(start);
  const [selected, setSelected] = useState(0);
  const [kind, setKind] = useState<"ellipse" | "rect">("ellipse");
  const drag = useRef<{ x: number; y: number; move: boolean; shape?: MaskKey; before: MaskLayer[] } | null>(null);
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const position = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
  };
  const begin = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    video.current?.pause();
    const p = position(event);
    if (pointMode) { onPoint(start + Math.round((time - start) * 24) / 24, p, pointMode); return; }
    if (layers[selected]?.kind === "auto") return;
    const shape = layers[selected] && maskAt(layers[selected], time);
    const move = !!shape && Math.abs(p.x - shape.x) < shape.w / 2 && Math.abs(p.y - shape.y) < shape.h / 2;
    drag.current = { ...p, move, shape: shape ?? undefined, before: structuredClone(layers) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const motion = (event: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = position(event);
    if (d.move && d.shape) {
      const key = { ...d.shape, t: time, x: clamp(d.shape.x + p.x - d.x), y: clamp(d.shape.y + p.y - d.y) };
      onChange(d.before.map((layer, i) => i === selected && layer.kind !== "auto" ? putMaskKey(layer, key, start) : layer));
    } else {
      const key = { t: time, x: (p.x + d.x) / 2, y: (p.y + d.y) / 2, w: Math.max(0.001, Math.abs(p.x - d.x)), h: Math.max(0.001, Math.abs(p.y - d.y)), rot: 0 };
      const layer: ShapeMaskLayer = { kind, keys: [key], motion: "linear", mode: "add", visible: true };
      if (!d.before.length) { onChange([...d.before, layer]); setSelected(d.before.length); }
      else onChange(d.before.map((old, i) => i === selected && old.kind !== "auto" ? putMaskKey({ ...old, kind }, key, start) : old));
    }
  };
  const seek = (value: number) => { const t = Math.max(start, Math.min(Math.max(start, end - 1 / 24), value)); setTime(t); if (video.current) video.current.currentTime = t; };
  useEffect(() => { const t = Math.max(start, Math.min(end - 1 / 24, time)); setTime(t); if (video.current) video.current.currentTime = t; }, [start, end]);
  const layer = layers[selected];
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <Select value={kind} onChange={(value) => { const next = value as "ellipse" | "rect"; setKind(next); onChange(layers.map((l, i) => i === selected && l.kind !== "auto" ? { ...l, kind: next } : l)); }} options={[{ value: "ellipse", label: "Овал" }, { value: "rect", label: "Прямоугольник" }]} />
      <Button size="sm" onClick={() => { onChange([...layers, { kind, keys: [{ t: start + Math.round((time - start) * 24) / 24, x: 0.5, y: 0.5, w: 0.3, h: 0.4, rot: 0 }], motion: "linear", mode: "add", visible: true }]); setSelected(layers.length); }} disabled={layers.length >= 16}>Добавить область</Button>
      {layers.length > 0 && <Select value={String(selected)} onChange={(value) => { setSelected(Number(value)); }} options={layers.map((l, i) => ({ value: String(i), label: `${i + 1}. ${l.kind === "auto" ? "SAM" : l.mode === "cut" ? "Вычесть" : "Область"}` }))} />}
      {layer && <Button size="sm" onClick={() => { onChange(layers.filter((_, i) => i !== selected)); setSelected(0); }}>Удалить область</Button>}
    </div>
    <div className="relative mx-auto max-h-[340px] overflow-hidden rounded-lg bg-black" style={{ aspectRatio: `${asset.width || 16}/${asset.height || 9}`, maxWidth: `min(100%, ${340 * (asset.width || 16) / (asset.height || 9)}px)` }}>
      <video ref={video} src={urls.assetFile(asset.id)} muted playsInline preload="metadata" className="h-full w-full" onLoadedMetadata={() => seek(start)} onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full touch-none cursor-crosshair" aria-label={pointMode ? "Выбрать объект SAM" : "Нарисовать маску"} role="img"
        onPointerDown={begin} onPointerMove={motion} onPointerUp={(e) => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { drag.current = null; }}>
        {layers.map((l, i) => { if (l.kind === "auto") return <AutoMaskOverlay key={i} layer={l} time={time} />; const s = maskAt(l, time); if (!s) return null; const attrs = { fill: l.mode === "cut" ? "#f8717155" : "#a3e63555", stroke: i === selected ? "#fff" : "#a3e635", strokeWidth: 0.004, transform: `rotate(${s.rot} ${s.x} ${s.y})` };
          return l.kind === "ellipse" ? <ellipse key={i} cx={s.x} cy={s.y} rx={s.w / 2} ry={s.h / 2} {...attrs} /> : <rect key={i} x={s.x - s.w / 2} y={s.y - s.h / 2} width={s.w} height={s.h} {...attrs} />;
        })}
        {selection.points.filter((p) => Math.abs(p.time - time) < 1 / 48).flatMap((p) => (["positive", "negative"] as const).flatMap((mode) => p[mode].map((point, i) => <circle key={`${mode}-${i}`} cx={point.x} cy={point.y} r={0.012} fill={mode === "positive" ? "#a3e635" : "#f87171"} stroke="#fff" strokeWidth={0.003} />)))}
      </svg>
    </div>
    <input type="range" aria-label="Кадр маски" className="w-full accent-accent" min={start} max={Math.max(start, end - 1 / 24)} step={1 / 24} value={time} onChange={(e) => seek(Number(e.target.value))} />
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span>{time.toFixed(2)} с</span><Button size="sm" onClick={() => seek(time - 1 / 24)}>← кадр</Button><Button size="sm" onClick={() => seek(time + 1 / 24)}>кадр →</Button>
      {layer && <><Select value={layer.mode} onChange={(value) => onChange(layers.map((l, i) => i === selected ? { ...l, mode: value as "add" | "cut" } : l))} options={[{ value: "add", label: "Добавить к маске" }, { value: "cut", label: "Вычесть из маски" }]} />
        {layer.kind !== "auto" && layer.keys.map((k) => <button key={k.t} className="rounded border border-line px-1.5 py-1 hover:text-fg" onClick={() => seek(k.t)} title="Перейти к ключевому кадру">◆ {k.t.toFixed(2)}</button>)}
        {layer.kind !== "auto" && layer.keys.length > 1 && <Button size="sm" onClick={() => onChange(layers.map((l, i) => i === selected && l.kind !== "auto" ? { ...l, keys: l.keys.filter((k) => Math.abs(k.t - time) > 0.001) } : l))}>Удалить ключ</Button>}
      </>}
    </div>
    {selection.points.map((p) => <button key={p.time} className="mr-1 rounded border border-line px-1.5 py-1 text-xs text-muted" onClick={() => seek(p.time)}>Точки · {p.time.toFixed(2)} с</button>)}
    {layer && layer.kind !== "auto" && <details className="text-xs text-muted"><summary className="cursor-pointer">Положение и размер области</summary><div className="grid grid-cols-2 gap-2 pt-2">
      {(["x", "y", "w", "h"] as const).map((field) => <label key={field}>{({ x: "По горизонтали", y: "По вертикали", w: "Ширина", h: "Высота" })[field]}
        <input aria-label={`Маска: ${field}`} type="range" min={field === "w" || field === "h" ? 0.01 : 0} max={1} step={0.01} value={maskAt(layer, time)?.[field] ?? 0.5} className="w-full accent-accent"
          onChange={(e) => { const key = maskAt(layer, time); if (key) onChange(layers.map((l, i) => i === selected && l.kind !== "auto" ? putMaskKey(l, { ...key, [field]: Number(e.target.value) }, start) : l)); }} />
      </label>)}
    </div></details>}
    <p className="text-[11px] text-muted">Нарисуйте область мышью или нажмите «Добавить область». На другом кадре переместите её или измените размер — появится ключевой кадр, между ключами маска движется плавно.</p>
  </div>;
}
