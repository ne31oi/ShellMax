import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import { Check, ChevronDown, Dices, Lock, RotateCcw, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { generate } from "../../lib/actions";
import { on } from "../../lib/bus";
import { api } from "../../api/client";
import type { Estimate } from "../../api/types";
import { estimateBasis, fmtEstimate } from "../../lib/format";
import { useForm, flushFormPersist } from "../../store/form";
import { defaultProfile, sortedGenerations, useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Menu, MenuItem, MenuLabel, MenuSeparator, SectionTitle, Spinner, Tip } from "../ui";
import { DurationChip, FormatChip, LookChip, QualityChip, StyleChip, useEstimates } from "./Chips";
import { PromptEditor } from "./PromptEditor";
import { RefsZone } from "./RefsZone";

export function GeneratePanel() {
  const estimates = useEstimates();
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-4 pt-4">
        <section>
          <SectionTitle>Референсы</SectionTitle>
          <RefsZone />
        </section>
        <section>
          <SectionTitle>Что происходит в видео</SectionTitle>
          <PromptEditor />
        </section>
        <section className="flex flex-wrap gap-1.5">
          <FormatChip />
          <DurationChip />
          <QualityChip estimates={estimates} />
          <LookChip />
          <StyleChip />
        </section>
      </div>
      <GenerateBar estimates={estimates} />
    </div>
  );
}

function GenerateBar({ estimates }: { estimates: Record<string, Estimate | undefined> }) {
  const { quality, variants, seedLocked, seed, profileId, set } = useForm();
  const engine = useLibrary((s) => s.engine);
  const profiles = useLibrary((s) => s.profiles);
  const generations = useLibrary((s) => s.generations);
  const openSettings = useUI((s) => s.openSettings);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await generate();
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => on("generate", run));

  const queued = Object.values(generations).filter((g) => g.status === "queued" || g.status === "running").length;
  const notInstalled = engine?.state === "not_installed";
  const activeProfile = profiles.find((p) => p.id === profileId) ?? defaultProfile(profiles);
  const problems = activeProfile?.problems.length ?? 0;
  const est = estimates[quality];

  const toggleSeed = () => {
    if (seedLocked) return set({ seedLocked: false });
    // lock onto the most recent generation's seed
    const last = sortedGenerations(generations)[0];
    set({ seedLocked: true, seed: seed ?? last?.seed ?? Math.floor(Math.random() * 2 ** 40) });
  };

  return (
    <div className="border-t border-line bg-panel px-4 py-3">
      {notInstalled ? (
        <button onClick={() => openSettings("system")} className="w-full rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-left text-[13px] text-warn">
          Движок не установлен. Запустите <code className="font-mono">scripts\install_comfy.ps1</code> — подробнее…
        </button>
      ) : problems > 0 ? (
        <button onClick={() => openSettings("engine")} className="mb-2 w-full rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-left text-xs text-bad">
          Не найдено файлов моделей: {problems}. Открыть настройки движка →
        </button>
      ) : null}

      {!notInstalled && (
        <div className="flex items-stretch gap-2">
          <div className="flex flex-1 overflow-hidden rounded-xl">
            <button
              onClick={run}
              disabled={busy}
              title={est ? estimateBasis(est) : undefined}
              className="flex h-11 flex-1 items-center justify-center gap-2 bg-accent font-semibold text-accent-fg transition-colors hover:bg-accent-strong disabled:opacity-60"
            >
              {busy ? <Spinner /> : <Wand2 size={16} />}
              {variants > 1 ? `Создать ×${variants}` : "Создать"}
              {est && isFinite(est.seconds) && <span className="text-[12px] font-normal opacity-70">{fmtEstimate(est.seconds * variants)}</span>}
            </button>
            <Menu
              trigger={
                <button className="flex w-9 items-center justify-center border-l border-black/15 bg-accent text-accent-fg hover:bg-accent-strong" aria-label="Параметры запуска">
                  <ChevronDown size={16} />
                </button>
              }
            >
              <MenuLabel>Варианты (разные сиды)</MenuLabel>
              <div className="flex gap-1 px-2 pb-1.5">
                {[1, 2, 4].map((n) => (
                  <DropdownMenu.Item
                    key={n}
                    onSelect={() => set({ variants: n })}
                    className={clsx(
                      "flex-1 cursor-pointer rounded-lg py-1.5 text-center text-[13px] outline-none data-[highlighted]:bg-hover",
                      variants === n ? "bg-accent/15 text-accent" : "text-fg",
                    )}
                  >
                    {n}
                  </DropdownMenu.Item>
                ))}
              </div>
              {profiles.length > 1 && (
                <>
                  <MenuSeparator />
                  <MenuLabel>Профиль движка</MenuLabel>
                  {profiles.map((p) => (
                    <MenuItem
                      key={p.id}
                      onSelect={() => {
                        set({ profileId: p.id });
                        void flushFormPersist();
                        // Also mark as server default: sticky alone was lost across restarts.
                        if (!p.is_default) {
                          void api.updateProfile(p.id, p.data, true).then(() => useLibrary.getState().reloadProfiles());
                        }
                      }}
                    >
                      <span className="w-4">{activeProfile?.id === p.id && <Check size={13} className="text-accent" />}</span>
                      {p.name}
                    </MenuItem>
                  ))}
                </>
              )}
              <MenuSeparator />
              <MenuItem
                onSelect={() => {
                  const d = useLibrary.getState().meta?.defaults;
                  if (d) set({ aspect: d.aspect, duration: d.duration, quality: d.quality, look: d.look ?? "cinema", camera: d.camera ?? "auto", light: d.light ?? "auto", styles: [], variants: 1, seedLocked: false });
                }}
              >
                <RotateCcw size={13} /> Сбросить к значениям воркфлоу
              </MenuItem>
            </Menu>
          </div>
          <Tip text={seedLocked ? `Сид зафиксирован: ${seed} — повторит тот же результат` : "Случайный сид — каждый раз новый результат"}>
            <button
              onClick={toggleSeed}
              className={clsx(
                "flex w-11 items-center justify-center rounded-xl border transition-colors",
                seedLocked ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-raised text-muted hover:text-fg",
              )}
              aria-label="Сид"
            >
              {seedLocked ? <Lock size={16} /> : <Dices size={17} />}
            </button>
          </Tip>
        </div>
      )}
      {queued > 0 && !notInstalled && (
        <p className="mt-1.5 text-center text-[11px] text-faint">
          В работе: {queued}. Можно ставить следующую — она встанет в очередь
        </p>
      )}
    </div>
  );
}
