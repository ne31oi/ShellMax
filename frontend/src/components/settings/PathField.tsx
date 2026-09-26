import clsx from "clsx";
import { ArrowUp, File, Folder, FolderOpen, HardDrive } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { FsListing, ScannedModel } from "../../api/types";
import { fileName, fmtSize, stripQuotes } from "../../lib/format";
import { Button, Dialog, IconButton, Spinner, Tip } from "../ui";

export type ModelCategory = "unet" | "text_encoder" | "vae" | "lora" | "upscaler";

let scanCache: Promise<Record<string, ScannedModel[]>> | null = null;
const scanned = () => (scanCache ??= api.scanModels().catch(() => ({}) as Record<string, ScannedModel[]>));

/** Absolute path input: paste (quotes stripped), autocomplete from the models folder, or browse. */
export function PathField({
  value,
  onChange,
  category,
  compact,
  placeholder = "Вставьте путь или выберите файл",
}: {
  value: string;
  onChange: (v: string) => void;
  category: ModelCategory;
  compact?: boolean;
  placeholder?: string;
}) {
  const [status, setStatus] = useState<{ exists: boolean; size: number | null } | null>(null);
  const [focus, setFocus] = useState(false);
  const [options, setOptions] = useState<ScannedModel[]>([]);
  const [browse, setBrowse] = useState(false);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!value) return setStatus(null);
    const t = setTimeout(() => api.fsCheck(value).then(setStatus).catch(() => setStatus(null)), 250);
    return () => clearTimeout(t);
  }, [value]);

  useEffect(() => {
    scanned().then((s) => setOptions(s[category] ?? []));
  }, [category]);

  const query = value.toLowerCase();
  const matches = focus
    ? options.filter((o) => !query || o.path.toLowerCase().includes(query) || o.rel.toLowerCase().includes(fileName(query))).slice(0, 8)
    : [];
  const showList = focus && matches.length > 0 && !(matches.length === 1 && matches[0].path === value);

  return (
    <div className="relative">
      <div className={clsx("flex items-center gap-1.5 rounded-lg border bg-raised pr-1 focus-within:border-accent/60", status && !status.exists ? "border-bad/50" : "border-line")}>
        <Tip text={!value ? "Путь не указан" : status == null ? "Проверяю…" : status.exists ? `Файл найден · ${fmtSize(status.size)}` : "Файл не найден"}>
          <span
            className={clsx(
              "ml-2.5 h-2 w-2 shrink-0 rounded-full",
              !value ? "bg-line-strong" : status == null ? "bg-muted" : status.exists ? "bg-ok" : "bg-bad",
            )}
          />
        </Tip>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            e.preventDefault();
            onChange(stripQuotes(e.clipboardData.getData("text")));
          }}
          onBlur={() => {
            setTimeout(() => setFocus(false), 150);
            if (value !== stripQuotes(value)) onChange(stripQuotes(value));
          }}
          onFocus={() => {
            setFocus(true);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (!showList) return;
            if (e.key === "ArrowDown") setCursor((c) => (c + 1) % matches.length);
            else if (e.key === "ArrowUp") setCursor((c) => (c - 1 + matches.length) % matches.length);
            else if (e.key === "Enter") {
              onChange(matches[cursor].path);
              setFocus(false);
            } else return;
            e.preventDefault();
          }}
          placeholder={placeholder}
          spellCheck={false}
          className={clsx("min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:font-sans placeholder:text-faint", compact ? "h-7 text-[11px]" : "h-8 text-xs")}
        />
        {status?.exists && !compact && <span className="shrink-0 text-[11px] text-faint">{fmtSize(status.size)}</span>}
        <IconButton label="Выбрать файл" size="sm" onClick={() => setBrowse(true)}>
          <FolderOpen size={13} />
        </IconButton>
      </div>
      {showList && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-2xl">
          {matches.map((m, i) => (
            <button
              key={m.path}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(m.path);
                setFocus(false);
              }}
              className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left", i === cursor ? "bg-hover" : "hover:bg-hover")}
            >
              <File size={12} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate text-xs">{m.rel}</span>
              <span className="text-[10px] text-faint">{fmtSize(m.size)}</span>
            </button>
          ))}
        </div>
      )}
      <FileBrowser open={browse} onOpenChange={setBrowse} start={value} onPick={(p) => onChange(p)} />
    </div>
  );
}

export function FileBrowser({ open, onOpenChange, start, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; start: string; onPick: (path: string) => void }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [typed, setTyped] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const startRef = useRef(start);
  startRef.current = start;

  const go = async (path: string) => {
    setLoading(true);
    setError("");
    try {
      const l = await api.fsList(path);
      setListing(l);
      setTyped(l.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось открыть папку");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) go(startRef.current ? startRef.current.replace(/[\\/][^\\/]*$/, "") : "");
  }, [open]);

  const sep = listing?.path.includes("/") ? "/" : "\\";
  const join = (name: string) => (listing!.path ? listing!.path.replace(/[\\/]$/, "") + sep + name : name);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Выбор файла модели">
      <div className="flex items-center gap-1.5 border-b border-line px-4 py-2">
        <IconButton label="Вверх" size="sm" disabled={!listing?.path} onClick={() => go(listing?.parent ?? "")}>
          <ArrowUp size={14} />
        </IconButton>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(stripQuotes(typed))}
          placeholder="Компьютер"
          className="h-7 flex-1 rounded-md border border-line bg-raised px-2 font-mono text-xs outline-none focus:border-accent/60"
        />
        {loading && <Spinner />}
      </div>
      <div className="h-[50vh] overflow-y-auto p-2">
        {error && <p className="p-2 text-xs text-bad">{error}</p>}
        {listing?.dirs.map((d) => (
          <button key={d} onClick={() => go(join(d))} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover">
            {listing.path ? <Folder size={14} className="text-muted" /> : <HardDrive size={14} className="text-muted" />}
            {d}
          </button>
        ))}
        {listing?.files.map((f) => (
          <button
            key={f.name}
            onClick={() => {
              onPick(join(f.name));
              onOpenChange(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent/15"
          >
            <File size={14} className="text-accent" />
            <span className="flex-1 truncate">{f.name}</span>
            <span className="text-[11px] text-faint">{fmtSize(f.size)}</span>
          </button>
        ))}
        {listing && listing.path && !listing.dirs.length && !listing.files.length && (
          <p className="p-3 text-xs text-faint">Здесь нет папок и файлов моделей (.safetensors и др.)</p>
        )}
      </div>
      <div className="flex justify-end border-t border-line px-4 py-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Отмена</Button>
      </div>
    </Dialog>
  );
}
