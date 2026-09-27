import clsx from "clsx";
import { AudioLines, History } from "lucide-react";
import { useEffect, useState } from "react";
import { api, urls } from "../../api/client";
import type { Upload } from "../../api/types";
import { addUploadsAsRefs } from "../../lib/actions";
import { KIND_LABEL } from "../../lib/refs";
import { dedupeRecentRefs, recentFamilyInUse, useForm, type RecentRefKind } from "../../store/form";
import { useUI } from "../../store/ui";
import { Popover } from "../ui";

const KINDS: RecentRefKind[] = ["image", "video", "audio"];

/** Pick from the last 10 uploads per kind (sticky MRU). Always visible in the refs zone. */
export function RecentRefsPicker({ compact }: { compact?: boolean }) {
  const recent = useForm((s) => s.recentRefs);
  const refs = useForm((s) => s.refs);
  const hydrated = useForm((s) => s.hydrated);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<RecentRefKind>("image");

  // Collapse sticky duplicates (edits / re-uploads) and seed from history if empty
  useEffect(() => {
    if (!hydrated) return;
    const cur = useForm.getState().recentRefs;
    const cleaned = dedupeRecentRefs(cur);
    const changed = KINDS.some((k) => cleaned[k].length !== cur[k].length);
    if (changed) useForm.getState().set({ recentRefs: cleaned });
    if (KINDS.every((k) => cleaned[k].length === 0)) void useForm.getState().seedRecentFromHistory();
  }, [hydrated]);

  const list = recent[tab];
  const total = KINDS.reduce((n, k) => n + recent[k].length, 0);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      const first = KINDS.find((k) => recent[k].length > 0);
      if (first) setTab(first);
    }
  };

  const pick = async (upload: Upload) => {
    if (recentFamilyInUse(refs, upload)) {
      useUI.getState().toast("Уже в референсах", "info");
      return;
    }
    setBusy(upload.id);
    try {
      const fresh = await api.uploadInfo(upload.id).catch(() => null);
      if (!fresh) {
        useForm.getState().set({
          recentRefs: {
            ...useForm.getState().recentRefs,
            [upload.kind]: useForm.getState().recentRefs[upload.kind as RecentRefKind].filter((u) => u.id !== upload.id),
          },
        });
        useUI.getState().toast("Файл больше недоступен", "info");
        return;
      }
      addUploadsAsRefs([fresh]);
      setOpen(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      side="bottom"
      className="w-[280px] p-2"
      trigger={
        <button
          type="button"
          title="Недавние референсы"
          aria-label="Недавние референсы"
          className={clsx(
            "inline-flex items-center justify-center rounded-lg border border-dashed border-line-strong text-muted transition-colors hover:border-accent/60 hover:text-fg",
            compact ? "h-[76px] w-[52px]" : "h-8 gap-1.5 px-2.5 text-[12px]",
          )}
        >
          <History size={compact ? 18 : 14} />
          {!compact && <span>Недавние</span>}
          {!compact && total > 0 && (
            <span className="tabular-nums text-faint">{total}</span>
          )}
        </button>
      }
    >
      <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Недавние</p>
      <div className="mb-2 flex gap-0.5 rounded-lg bg-raised p-0.5">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={clsx(
              "flex-1 rounded-md px-1.5 py-1 text-[11px] transition-colors",
              tab === k ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg",
            )}
          >
            {KIND_LABEL[k]}
            {recent[k].length > 0 && (
              <span className="ml-1 tabular-nums text-faint">{recent[k].length}</span>
            )}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="px-1 py-4 text-center text-[12px] text-faint">
          {total === 0 ? "Пока нет — добавьте референс или сгенерируйте клип" : "В этой категории пока пусто"}
        </p>
      ) : (
        <div className="grid max-h-56 grid-cols-4 gap-1.5 overflow-y-auto">
          {list.map((u) => {
            const used = recentFamilyInUse(refs, u);
            return (
              <button
                key={u.id}
                type="button"
                disabled={!!busy || used}
                title={used ? "Уже добавлен" : u.orig_name}
                onClick={() => void pick(u)}
                className={clsx(
                  "relative aspect-square overflow-hidden rounded-lg bg-raised ring-1 ring-line transition-colors",
                  used ? "opacity-40" : "hover:ring-accent/60",
                  busy === u.id && "opacity-60",
                )}
              >
                {u.kind === "audio" ? (
                  <div className="flex h-full items-center justify-center text-audio">
                    <AudioLines size={18} />
                  </div>
                ) : (
                  <img src={urls.uploadThumb(u.id)} alt="" className="h-full w-full object-cover" draggable={false} />
                )}
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-2 px-1 text-[10px] leading-snug text-faint">До 10 на каждый тип</p>
    </Popover>
  );
}
