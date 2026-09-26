import clsx from "clsx";
import { AudioLines, Check, ChevronDown, Clock, Palette, Plus, Sparkles } from "lucide-react";
import { forwardRef, useEffect, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import type { Estimate } from "../../api/types";
import { estimateBasis, fmtEstimate, fmtSeconds, frameCount } from "../../lib/format";
import { tagOf } from "../../lib/refs";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Popover, Slider, Tip } from "../ui";

const Chip = forwardRef<HTMLButtonElement, { icon?: ReactNode; children: ReactNode; active?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ icon, children, active, className, ...props }, ref) => (
    <button
      ref={ref}
      className={clsx(
        "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors data-[state=open]:border-accent/60 data-[state=open]:bg-hover",
        active ? "border-accent/50 bg-accent/10 text-fg" : "border-line bg-raised text-fg hover:bg-hover",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="truncate">{children}</span>
      <ChevronDown size={12} className="shrink-0 text-faint" />
    </button>
  ),
);

// ---------------------------------------------------------------- format
function AspectIcon({ ratio, size = 18 }: { ratio: [number, number]; size?: number }) {
  const [w, h] = ratio;
  const scale = size / Math.max(w, h);
  return (
    <span className="inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <span className="rounded-[2px] border-[1.5px] border-current" style={{ width: w * scale, height: h * scale }} />
    </span>
  );
}

export function FormatChip() {
  const aspects = useLibrary((s) => s.meta?.aspects ?? []);
  const aspect = useForm((s) => s.aspect);
  const set = useForm((s) => s.set);
  const current = aspects.find((a) => a.id === aspect);
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={<Chip icon={current && <AspectIcon ratio={current.ratio} size={14} />}>{current?.short ?? aspect}</Chip>}
      className="w-64"
    >
      <div className="grid grid-cols-4 gap-1.5">
        {aspects.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              set({ aspect: a.id });
              setOpen(false);
            }}
            className={clsx(
              "flex flex-col items-center gap-1 rounded-lg py-2 text-xs",
              a.id === aspect ? "bg-accent/15 text-accent" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <AspectIcon ratio={a.ratio} size={22} />
            {a.short}
          </button>
        ))}
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------- duration
const MAX_FRAMES = 20 * 24;
const VALID = Array.from({ length: 40 }, (_, k) => 5 + 17 * k).filter((f) => f >= 22 && f <= MAX_FRAMES);
const QUICK = [2, 5, 10, 15];

export function DurationChip() {
  const duration = useForm((s) => s.duration);
  const set = useForm((s) => s.set);
  const frames = frameCount(duration);
  const idx = Math.max(0, VALID.findIndex((f) => f >= frames));
  const seconds = frames / 24;
  const optimal = frames >= 124 && frames <= 362;
  // sound the clip should cover: audio refs and video refs whose soundtrack is passed on
  const refs = useForm((st) => st.refs);
  const sounds = refs
    .filter((r) => (r.upload.kind === "audio" || (r.upload.kind === "video" && r.withAudio)) && r.upload.duration)
    .map((r) => {
      const f = Math.min(frameCount(r.upload.duration!), VALID[VALID.length - 1]);
      return { uid: r.uid, tag: tagOf(refs, r.uid)!, length: r.upload.duration!, frames: f, clipped: frameCount(r.upload.duration!) > f };
    });
  const shorter = sounds.filter((x) => seconds + 1e-3 < x.length);
  return (
    <Popover trigger={<Chip icon={<Clock size={13} className="text-muted" />}>{fmtSeconds(seconds)}</Chip>} className="w-72">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-2xl font-semibold tabular-nums">{fmtSeconds(seconds)}</span>
        <span className="text-xs text-faint">{frames} кадров · 24 fps</span>
      </div>
      <div className="relative">
        {/* the model's trained range */}
        <div
          className="pointer-events-none absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-ok/15"
          style={{
            left: `${(VALID.indexOf(124) / (VALID.length - 1)) * 100}%`,
            right: `${100 - (VALID.indexOf(362) / (VALID.length - 1)) * 100}%`,
          }}
        />
        <Slider value={idx} min={0} max={VALID.length - 1} step={1} onChange={(i) => set({ duration: VALID[i] / 24 })} />
      </div>
      <p className={clsx("mt-1.5 text-[11px]", optimal ? "text-ok" : "text-faint")}>
        {optimal ? "В диапазоне, на котором обучалась модель" : "Модель лучше всего работает на 5–15 секундах"}
      </p>
      <div className="mt-3 grid grid-cols-4 gap-1.5">
        {QUICK.map((q) => {
          const f = frameCount(q);
          return (
            <button
              key={q}
              onClick={() => set({ duration: f / 24 })}
              className={clsx("rounded-lg py-1.5 text-xs", f === frames ? "bg-accent/15 text-accent" : "bg-raised text-muted hover:text-fg")}
            >
              {q} с
            </button>
          );
        })}
      </div>
      {sounds.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-1.5 text-[11px] text-faint">Под длину звука (видео чуть длиннее, чтобы звук вошёл целиком)</p>
          <div className="flex flex-col gap-1">
            {sounds.map((x) => (
              <button
                key={x.uid}
                onClick={() => set({ duration: x.frames / 24 })}
                className={clsx(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs",
                  x.frames === frames ? "bg-accent/15 text-accent" : "bg-raised text-muted hover:text-fg",
                )}
              >
                <AudioLines size={13} />
                <span className="flex-1">Под {x.tag} · {fmtSeconds(x.length)}</span>
                <span className="tabular-nums">→ {fmtSeconds(x.frames / 24)}{x.clipped ? " (максимум)" : ""}</span>
              </button>
            ))}
          </div>
          {shorter.length > 0 && (
            <p className="mt-1.5 text-[11px] text-warn">Видео короче, чем {shorter.map((x) => x.tag).join(", ")}: конец звука не войдёт</p>
          )}
        </div>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------- quality
export function useEstimates(): Record<string, Estimate | undefined> {
  const aspect = useForm((s) => s.aspect);
  const duration = useForm((s) => s.duration);
  const quality = useLibrary((s) => s.meta?.quality ?? []);
  const generationsCount = useLibrary((s) => Object.keys(s.generations).length);
  const [est, setEst] = useState<Record<string, Estimate | undefined>>({});
  useEffect(() => {
    const t = setTimeout(async () => {
      const pairs = await Promise.all(
        quality.map(async (q) => [q.id, await api.estimate(aspect, q.id, duration).catch(() => undefined)] as const),
      );
      setEst(Object.fromEntries(pairs));
    }, 250);
    return () => clearTimeout(t);
  }, [aspect, duration, quality, generationsCount]);
  return est;
}

export function QualityChip({ estimates }: { estimates: Record<string, Estimate | undefined> }) {
  const presets = useLibrary((s) => s.meta?.quality ?? []);
  const quality = useForm((s) => s.quality);
  const aspect = useForm((s) => s.aspect);
  const set = useForm((s) => s.set);
  const [open, setOpen] = useState(false);
  const current = presets.find((p) => p.id === quality);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={<Chip icon={<Sparkles size={13} className="text-muted" />}>{current?.label ?? quality}</Chip>}
      className="w-80 p-1.5"
    >
      {presets.map((p) => {
        const [w, h] = p.resolutions[aspect]?.final ?? [0, 0];
        return (
          <button
            key={p.id}
            onClick={() => {
              set({ quality: p.id });
              setOpen(false);
            }}
            className={clsx("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left", p.id === quality ? "bg-accent/10" : "hover:bg-hover")}
          >
            <span className="w-4">{p.id === quality && <Check size={14} className="text-accent" />}</span>
            <span className="flex-1">
              <span className="block text-[13px] font-medium">
                {p.label}
                {p.id === "standard" && <span className="ml-1.5 text-[11px] font-normal text-faint">как в воркфлоу</span>}
              </span>
              <span className="text-xs text-muted tabular-nums">{w}×{h}</span>
            </span>
            <Tip text={estimateBasis(estimates[p.id])} side="right">
              <span className="text-xs text-faint tabular-nums">
                {fmtEstimate(estimates[p.id]?.seconds)}
                {estimates[p.id]?.basis === "exact" && <span className="block text-[10px] opacity-70">по {estimates[p.id]!.samples}</span>}
              </span>
            </Tip>
          </button>
        );
      })}
      {quality === "high" && <p className="px-2.5 pb-1 pt-1 text-[11px] text-warn">Высокое качество требует много видеопамяти и времени</p>}
    </Popover>
  );
}

// ---------------------------------------------------------------- style (creative LoRA)
export function StyleChip() {
  const styles = useLibrary((s) => s.styles);
  const chosen = useForm((s) => s.styles);
  const set = useForm((s) => s.set);
  const openSettings = useUI((s) => s.openSettings);

  const label =
    chosen.length === 0
      ? "Стиль"
      : chosen.length === 1
        ? `${styles.find((s) => s.id === chosen[0].style_id)?.name ?? "Стиль"} ×${chosen[0].strength.toFixed(1)}`
        : `${chosen.length} стиля`;

  const toggle = (id: number, strength: number) =>
    set({
      styles: chosen.some((c) => c.style_id === id)
        ? chosen.filter((c) => c.style_id !== id)
        : [...chosen, { style_id: id, strength }],
    });

  return (
    <Popover trigger={<Chip icon={<Palette size={13} className="text-muted" />} active={chosen.length > 0}>{label}</Chip>} className="w-80 p-1.5" align="end">
      {styles.length === 0 ? (
        <div className="px-3 py-4 text-center">
          <p className="text-[13px]">Стилей пока нет</p>
          <p className="mb-3 mt-1 text-xs text-muted">Стиль — это LoRA, которую вы подключаете по пути. Добавьте её один раз, дальше выбирайте здесь.</p>
          <Button size="sm" onClick={() => openSettings("styles")}>
            <Plus size={13} /> Добавить стиль
          </Button>
        </div>
      ) : (
        <>
          {styles.map((st) => {
            const sel = chosen.find((c) => c.style_id === st.id);
            return (
              <div key={st.id} className={clsx("rounded-lg px-2.5 py-2", sel ? "bg-accent/10" : "hover:bg-hover")}>
                <button className="flex w-full items-center gap-2.5 text-left" onClick={() => toggle(st.id, st.default_strength)}>
                  <span
                    className={clsx(
                      "flex h-4 w-4 items-center justify-center rounded border",
                      sel ? "border-accent bg-accent text-accent-fg" : "border-line-strong",
                    )}
                  >
                    {sel && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="flex-1 truncate text-[13px]">{st.name}</span>
                  {sel && <span className="text-xs tabular-nums text-muted">×{sel.strength.toFixed(2)}</span>}
                </button>
                {sel && (
                  <Slider
                    className="mt-1.5"
                    value={sel.strength}
                    min={0}
                    max={1.5}
                    step={0.05}
                    onChange={(v) => set({ styles: chosen.map((c) => (c.style_id === st.id ? { ...c, strength: v } : c)) })}
                  />
                )}
              </div>
            );
          })}
          <button onClick={() => openSettings("styles")} className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-muted hover:bg-hover hover:text-fg">
            Управлять стилями…
          </button>
        </>
      )}
    </Popover>
  );
}
