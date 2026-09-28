import clsx from "clsx";
import {
  ChevronDown, Clapperboard, Upload as UploadIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type { Generation, MediaAsset, Upload } from "../../api/types";
import { dayKey, fmtDayLabel } from "../../lib/format";
import { sortedGenerations, useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { IconButton } from "../ui";
import { AssetCard, GenerationCard, RefCard } from "./MediaBinCards";

type BinItem =
  | { kind: "gen"; created: string; ts: number; gen: Generation }
  | { kind: "asset"; created: string; ts: number; asset: MediaAsset }
  | { kind: "ref"; created: string; ts: number; upload: Upload };

const COLLAPSE_KEY = "sm.bin.collapsedDays";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function itemTs(iso: string | undefined): number {
  const t = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

export function MediaBin() {
  const generations = useLibrary((s) => s.generations);
  const assets = useLibrary((s) => s.assets);
  const filter = useUI((s) => s.binFilter);
  const setFilter = useUI((s) => s.setBinFilter);
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [usedRefs, setUsedRefs] = useState<Upload[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .listUsedUploads()
      .then((list) => {
        if (!cancelled) setUsedRefs(list);
      })
      .catch(() => {
        if (!cancelled) setUsedRefs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [generations]); // refresh when library gens change

  const gens = sortedGenerations(generations).filter((g) =>
    filter === "all" ? true : filter === "video" ? g.status === "done" : filter === "draft" ? g.status === "draft_only" : false,
  );
  const importedAssets = Object.values(assets)
    .filter((a) => {
      if (!(a.source === "imported" || a.source === "exported")) return false;
      if (!(filter === "all" || filter === "imported")) return false;
      // «Все» — только видео/картинки; аудио смотри во «Импорт»
      if (filter === "all" && a.kind === "audio") return false;
      return true;
    })
    .sort((a, b) => b.id - a.id);

  // «Все» — только видео-рефы; картинки и аудио — во «Импорт»
  const refs =
    filter === "all"
      ? usedRefs.filter((u) => u.kind === "video")
      : filter === "imported"
        ? usedRefs
        : [];

  const groups = useMemo(() => {
    const items: BinItem[] = [];
    if (filter !== "imported") {
      for (const gen of gens) {
        items.push({ kind: "gen", created: gen.created, ts: itemTs(gen.created), gen });
      }
    }
    if (filter === "all" || filter === "imported") {
      for (const asset of importedAssets) {
        items.push({ kind: "asset", created: asset.created, ts: itemTs(asset.created), asset });
      }
      for (const upload of refs) {
        items.push({
          kind: "ref",
          created: upload.created ?? "",
          ts: itemTs(upload.created),
          upload,
        });
      }
    }
    const map = new Map<string, BinItem[]>();
    for (const it of items) {
      const k = dayKey(it.created || undefined);
      const list = map.get(k);
      if (list) list.push(it);
      else map.set(k, [it]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.ts - a.ts);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  }, [filter, gens, importedAssets, refs]);

  const toggleDay = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  };

  const doImport = async (files: File[]) => {
    setImporting(true);
    try {
      for (const f of files) useLibrary.getState().upsertAsset(await api.importAsset(f));
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось импортировать", "bad");
    } finally {
      setImporting(false);
    }
  };

  const empty = groups.every(([, items]) => items.length === 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <h2 className="mr-auto text-[11px] font-semibold uppercase tracking-wider text-faint">Медиатека</h2>
        <input ref={importInput} type="file" hidden multiple accept="video/*,image/*,audio/*" onChange={(e) => {
          doImport([...(e.target.files ?? [])]);
          e.target.value = "";
        }} />
        <IconButton label="Импортировать файлы" size="sm" onClick={() => importInput.current?.click()} disabled={importing}>
          <UploadIcon size={14} />
        </IconButton>
      </div>
      <div className="flex gap-1 px-3 pb-2">
        {([["all", "Все"], ["video", "Готовые"], ["draft", "Черновики"], ["imported", "Импорт"]] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            className={clsx("rounded-md px-2 py-0.5 text-xs", filter === id ? "bg-hover text-fg" : "text-muted hover:text-fg")}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            doImport([...e.dataTransfer.files]);
          }
        }}
      >
        {empty ? (
          <div className="mt-10 px-4 text-center text-xs leading-relaxed text-faint">
            <Clapperboard size={28} className="mx-auto mb-2 opacity-50" />
            {filter === "imported" ? (
              <>
                Здесь появятся референсы, которые вы уже использовали.
                <br />
                Добавьте рефы в панели генерации и создайте клип.
              </>
            ) : (
              <>
                Здесь появятся ваши видео.
                <br />
                Опишите сцену справа и нажмите «Создать».
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map(([key, items]) => {
              if (!items.length) return null;
              const open = !collapsed.has(key);
              return (
                <section key={key}>
                  <button
                    type="button"
                    onClick={() => toggleDay(key)}
                    className="sticky top-0 z-10 mb-1.5 flex w-full items-center gap-1 rounded-md bg-bg/95 px-1 py-1 text-left backdrop-blur-sm hover:bg-hover/60"
                  >
                    <ChevronDown
                      size={14}
                      className={clsx("shrink-0 text-faint transition-transform", !open && "-rotate-90")}
                    />
                    <span className="text-[11px] font-semibold text-fg">{fmtDayLabel(key)}</span>
                    <span className="ml-auto text-[10px] tabular-nums text-faint">{items.length}</span>
                  </button>
                  {open && (
                    <div className="grid grid-cols-2 gap-2">
                      {items.map((it) =>
                        it.kind === "gen" ? (
                          <GenerationCard key={`g-${it.gen.id}`} gen={it.gen} />
                        ) : it.kind === "asset" ? (
                          <AssetCard key={`a-${it.asset.id}`} asset={it.asset} />
                        ) : (
                          <RefCard
                            key={`r-${it.upload.id}`}
                            upload={it.upload}
                            onGone={() => setUsedRefs((prev) => prev.filter((u) => u.id !== it.upload.id))}
                          />
                        ),
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
