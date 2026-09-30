import { Pause, Play, RotateCcw, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CinematicTechniquePreset } from "../../../api/types";
import { Button, Select, Slider } from "../../ui";
import { playJlCutCue } from "./audioCue";
import { reconcileTechniques } from "./reconcile";
import type { FocusMode, ViewMode } from "./types";
import { DEMO_DURATION_S } from "./types";

type EngineModule = typeof import("./engine/CinemaEngine");

function parseAspect(aspect: string): number {
  const m = aspect.match(/(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)/);
  if (m) return Number(m[1]) / Number(m[2]);
  if (aspect.includes("9:16") || /vertical|portrait/i.test(aspect)) return 9 / 16;
  if (aspect.includes("1:1") || /square/i.test(aspect)) return 1;
  return 16 / 9;
}

export function CinemaPreview({
  techniques,
  selectedByCategory,
  aspect,
}: {
  techniques: CinematicTechniquePreset[];
  selectedByCategory: Record<string, string>;
  aspect: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<InstanceType<EngineModule["CinemaEngine"]> | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [webglError, setWebglError] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("shot");
  const [focusMode, setFocusMode] = useState<FocusMode>("combined");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const selectedIds = useMemo(
    () => Object.values(selectedByCategory).filter((id) => id && id !== "auto"),
    [selectedByCategory],
  );

  const selectedTechniques = useMemo(
    () => techniques.filter((t) => selectedIds.includes(t.id)),
    [techniques, selectedIds],
  );

  // Keep preview focus in sync with the real selection (reset → combined / base).
  useEffect(() => {
    if (selectedIds.length === 0) {
      if (focusMode !== "combined") setFocusMode("combined");
      return;
    }
    if (focusMode !== "combined" && !selectedIds.includes(focusMode)) {
      setFocusMode("combined");
    }
  }, [selectedIds, focusMode]);

  const activeIds = useMemo(() => {
    if (focusMode === "combined" || selectedIds.length === 0) return selectedIds;
    return selectedIds.includes(focusMode) ? [focusMode] : selectedIds;
  }, [focusMode, selectedIds]);

  const reconciled = useMemo(() => reconcileTechniques(activeIds), [activeIds]);
  const conflict =
    focusMode === "combined" && selectedIds.length > 1 ? reconcileTechniques(selectedIds).conflict : null;

  // Prefer solo preview when combined mode hits a hard conflict.
  useEffect(() => {
    if (conflict && focusMode === "combined") {
      setFocusMode(conflict.preferSoloId);
    }
  }, [conflict, focusMode]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Lazy-load Three.js engine once.
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    void import("./engine/CinemaEngine")
      .then((mod) => {
        if (cancelled) return;
        const engine = new mod.CinemaEngine(canvas);
        if (engine.status === "no-webgl") {
          setWebglError(true);
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        setEngineReady(true);
        setWebglError(false);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Не удалось загрузить 3D-модуль");
        setWebglError(true);
      });

    return () => {
      cancelled = true;
      engineRef.current?.dispose();
      engineRef.current = null;
      setEngineReady(false);
    };
  }, []);

  // Resize + visibility
  useEffect(() => {
    const host = hostRef.current;
    const engine = engineRef.current;
    if (!host || !engineReady) return;

    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) engineRef.current?.setSize(cr.width, cr.height);
    });
    ro.observe(host);

    const io = new IntersectionObserver(
      ([entry]) => engineRef.current?.setVisible(!!entry?.isIntersecting),
      { threshold: 0.05 },
    );
    io.observe(host);

    engine?.setSize(host.clientWidth, host.clientHeight);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, [engineReady]);

  useEffect(() => {
    engineRef.current?.setAspectRatio(parseAspect(aspect));
  }, [aspect, engineReady]);

  useEffect(() => {
    engineRef.current?.setViewMode(viewMode);
  }, [viewMode, engineReady]);

  const selectionKey = selectedIds.join("|");

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !engineReady) return;
    engine.setDemo(reconciled.demo);
    if (reducedMotion) {
      engine.pause();
      engine.scrub(0);
      setPlaying(false);
    } else {
      setPlaying(true);
    }
    setProgress(0);
  }, [reconciled, engineReady, reducedMotion, selectionKey]);

  // Poll progress for slider
  useEffect(() => {
    if (!engineReady) return;
    const id = window.setInterval(() => {
      const eng = engineRef.current;
      if (!eng) return;
      setProgress(eng.progress);
      setPlaying(eng.isPlaying);
    }, 100);
    return () => clearInterval(id);
  }, [engineReady]);

  const focusOptions = [
    { value: "combined", label: selectedIds.length ? `Все выбранные (${selectedIds.length})` : "База (без выбора)" },
    ...selectedTechniques.map((t) => ({
      value: t.id,
      label: `${t.source_id ?? t.id} · ${t.label}`,
    })),
  ];

  const retry = () => {
    setWebglError(false);
    setLoadError(null);
    setEngineReady(false);
    engineRef.current?.dispose();
    engineRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    void import("./engine/CinemaEngine").then((mod) => {
      const engine = new mod.CinemaEngine(canvas);
      if (engine.status === "no-webgl") {
        setWebglError(true);
        engine.dispose();
        return;
      }
      engineRef.current = engine;
      setEngineReady(true);
      engine.setAspectRatio(parseAspect(aspect));
      engine.setViewMode(viewMode);
      engine.setDemo(reconciled.demo);
    });
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-raised/50">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div>
          <h3 className="text-[13px] font-semibold">Предпросмотр</h3>
          <p className="text-[10px] text-faint">Учебная сцена · не из промпта и референсов</p>
        </div>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={viewMode === "shot" ? "primary" : "outline"}
            aria-pressed={viewMode === "shot"}
            onClick={() => setViewMode("shot")}
          >
            Кадр
          </Button>
          <Button
            type="button"
            size="sm"
            variant={viewMode === "schematic" ? "primary" : "outline"}
            aria-pressed={viewMode === "schematic"}
            onClick={() => setViewMode("schematic")}
          >
            Схема
          </Button>
        </div>
      </div>

      <div
        ref={hostRef}
        className="relative aspect-video w-full bg-black"
        style={{ aspectRatio: String(parseAspect(aspect)) }}
      >
        <canvas ref={canvasRef} className="h-full w-full touch-none" />
        {webglError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 p-4 text-center">
            <p className="text-[12px] text-muted">
              {loadError ?? "WebGL недоступен — предпросмотр отключён. Выбор техник работает как раньше."}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={retry}>
              Повторить
            </Button>
          </div>
        )}
        {!engineReady && !webglError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-faint">
            Загрузка сцены…
          </div>
        )}
      </div>

      <div className="space-y-2 p-3">
        {conflict && focusMode !== "combined" && (
          <p className="rounded-md bg-warn/10 px-2 py-1.5 text-[11px] leading-snug text-warn">
            {conflict.reason} Показан отдельный приём — ваш выбор в списках не изменён.
          </p>
        )}

        <Select
          label="Показать"
          value={focusMode === "combined" || selectedIds.includes(focusMode) ? focusMode : "combined"}
          onChange={(v) => setFocusMode(v as FocusMode)}
          options={focusOptions}
        />

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={playing ? "Пауза" : "Воспроизведение"}
            onClick={() => {
              const eng = engineRef.current;
              if (!eng) return;
              if (eng.isPlaying) {
                eng.pause();
                setPlaying(false);
              } else {
                if (eng.progress >= 1) eng.replay();
                else eng.play();
                setPlaying(true);
              }
            }}
          >
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Повтор"
            onClick={() => {
              engineRef.current?.replay();
              setPlaying(true);
            }}
          >
            <RotateCcw size={13} />
          </Button>
          <div className="min-w-0 flex-1">
            <Slider
              min={0}
              max={1}
              step={1 / (DEMO_DURATION_S * 30)}
              value={progress}
              onChange={(v) => {
                engineRef.current?.scrub(v);
                setProgress(v);
                setPlaying(false);
              }}
            />
          </div>
          {reconciled.demo.edit.audioCue && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="Пример звука J/L-cut"
              onClick={() => playJlCutCue(reconciled.demo.edit.audioCue!)}
            >
              <Volume2 size={13} />
            </Button>
          )}
        </div>

        {reducedMotion && (
          <p className="text-[10px] text-faint">Система просит меньше анимации — запуск вручную.</p>
        )}

        {reconciled.demo.edit.audioCue && (
          <div className="grid grid-cols-2 gap-1 text-[10px] text-faint">
            <div className="rounded bg-panel px-2 py-1">
              Видео {reconciled.demo.edit.audioCue === "lcut" ? "ведёт" : "следует"}
            </div>
            <div className="rounded bg-panel px-2 py-1">
              Звук {reconciled.demo.edit.audioCue === "jcut" ? "ведёт" : "следует"}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
