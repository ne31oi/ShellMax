import clsx from "clsx";
import { Clapperboard, PanelLeft, PanelRight, Settings, Wand2, X } from "lucide-react";
import { useEffect } from "react";
import { AssistantSetup } from "./components/assistant/AssistantSetup";
import { FaceRefineDialog } from "./components/face/FaceRefineDialog";
import { EnhanceDialog } from "./components/enhance/EnhanceDialog";
import { MaskEditDialog } from "./components/mask/MaskEditDialog";
import { RefModLibrary } from "./components/generate/RefModLibrary";
import { InterpolateDialog } from "./components/enhance/InterpolateDialog";
import { RefEditor } from "./components/generate/RefEditor";
import { AssistantWorkspace } from "./components/assistant/ClipView";
import { GeneratePanel } from "./components/generate/GeneratePanel";
import { EngineStatus } from "./components/layout/EngineStatus";
import { ProjectSwitcher } from "./components/layout/ProjectSwitcher";
import { RestartAllButton } from "./components/layout/RestartAllButton";
import { ShutdownAllButton } from "./components/layout/ShutdownAllButton";
import { Resizer, usePanelSize } from "./components/layout/Resizer";
import { Toasts } from "./components/layout/Toasts";
import { MediaBin } from "./components/library/MediaBin";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { TimelineStrip } from "./components/timeline/TimelineStrip";
import { PlanInspector } from "./components/timeline/PlanInspector";
import { IconButton, Kbd, Spinner, TipProvider } from "./components/ui";
import { Viewer } from "./components/viewer/Viewer";
import { api, setApiProjectId } from "./api/client";
import { useHotkeys } from "./lib/hotkeys";
import { connectLive } from "./lib/live";
import { ensurePlanFormSync, unbindPlanForm } from "./lib/planForm";
import { useAssistant } from "./store/assistant";
import { useForm, flushFormPersist } from "./store/form";
import { defaultProfile, useLibrary } from "./store/library";
import { type TimelineDoc, flushTimelinePersist, useTimeline } from "./store/timeline";
import { useUI } from "./store/ui";

export default function App() {
  const loaded = useLibrary((s) => s.loaded);
  const workspace = useUI((s) => s.workspace);
  const setWorkspace = useUI((s) => s.setWorkspace);
  const binOpen = useUI((s) => s.binOpen);
  const panelOpen = useUI((s) => s.panelOpen);
  const toggleBin = useUI((s) => s.toggleBin);
  const togglePanel = useUI((s) => s.togglePanel);
  const openSettings = useUI((s) => s.openSettings);
  const projectId = useUI((s) => s.projectId);
  const selectedPlanId = useTimeline((s) => s.selectedPlanId);
  const showPlanPanel = workspace === "edit" && !!selectedPlanId;

  const [binW, , adjustBinW] = usePanelSize("bin", 300, 220, 520);
  const [panelW, , adjustPanelW] = usePanelSize("gen", 400, 340, 620);
  const [timelineH, , adjustTimelineH] = usePanelSize("timeline.edit", 380, 140, 640);

  useHotkeys();

  useEffect(() => {
    ensurePlanFormSync();
  }, []);

  useEffect(() => {
    setApiProjectId(projectId);
  }, [projectId]);

  useEffect(() => {
    const stop = connectLive();
    useLibrary
      .getState()
      .load()
      .then(async () => {
        const meta = useLibrary.getState().meta!;
        await useForm.getState().hydrate(meta.defaults);
        // Pin a concrete engine profile id so restart does not silently fall back to Singularity.
        const profiles = useLibrary.getState().profiles;
        const cur = useForm.getState().profileId;
        const stillThere = cur != null && profiles.some((p) => p.id === cur);
        if (!stillThere) {
          const fallback = defaultProfile(profiles);
          if (fallback) useForm.getState().set({ profileId: fallback.id });
        }
        await flushFormPersist();
        await useForm.getState().seedRecentFromHistory();
      });
    void useAssistant.getState().refresh();
    const loadTimeline = () =>
      api
        .project(useUI.getState().projectId)
        .then((p) => useTimeline.getState().load(p.timeline as unknown as TimelineDoc))
        .catch(() => undefined);
    void loadTimeline();
    const flush = () => {
      flushTimelinePersist();
      void flushFormPersist();
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    return () => {
      stop();
      flush();
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Spinner /> Подключение к ShellMax…
      </div>
    );
  }

  return (
    <TipProvider>
      <div className="flex h-full flex-col">
        {/* top bar */}
        <header className="flex h-11 shrink-0 items-center gap-4 border-b border-line bg-panel px-3">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-accent-fg">
              <Clapperboard size={14} strokeWidth={2.5} />
            </div>
            <span className="text-[13px] font-semibold tracking-tight">ShellMax</span>
            <ProjectSwitcher />
          </div>
          <div className="flex rounded-lg bg-raised p-0.5">
            {(
              [
                ["generate", "Генерация"],
                ["edit", "Монтаж"],
                ["assistant", "Ассистент"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setWorkspace(id)}
                className={clsx(
                  "rounded-md px-3 py-1 text-xs transition-colors",
                  workspace === id ? "bg-hover text-fg shadow-sm" : "text-muted hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {workspace !== "assistant" && (
            <div className="flex items-center gap-0.5 rounded-lg bg-raised p-0.5">
              <IconButton
                label={binOpen ? "Скрыть медиатеку (B)" : "Показать медиатеку (B)"}
                size="sm"
                active={binOpen}
                onClick={toggleBin}
              >
                <PanelLeft size={14} />
              </IconButton>
              <IconButton
                label={panelOpen ? "Скрыть панель генерации (G)" : "Показать панель генерации (G)"}
                size="sm"
                active={panelOpen}
                onClick={togglePanel}
              >
                <PanelRight size={14} />
              </IconButton>
            </div>
          )}
          <span className="flex-1" />
          <EngineStatus />
          <RestartAllButton />
          <ShutdownAllButton />
          <IconButton label="Настройки" onClick={() => openSettings("engine")}>
            <Settings size={16} />
          </IconButton>
        </header>

        {/* body */}
        {workspace === "assistant" ? (
          <div className="min-h-0 flex-1">
            <AssistantWorkspace />
          </div>
        ) : (
        <div className="flex min-h-0 flex-1">
          <aside
            data-open={binOpen}
            style={{ width: binOpen ? binW : 0 }}
            className={clsx("sidebar-rail bg-panel", binOpen && "border-r border-line")}
            aria-hidden={!binOpen}
          >
            <div className="sidebar-rail-inner" style={{ width: binW }}>
              <MediaBin />
            </div>
          </aside>
          <div data-open={binOpen} className="sidebar-split" style={{ width: binOpen ? undefined : 0 }}>
            <Resizer axis="x" onDrag={adjustBinW} />
          </div>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <Viewer />
              {!binOpen && (
                <button
                  onClick={toggleBin}
                  className="sidebar-chip absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-line bg-panel/90 px-2 py-1.5 text-xs text-muted shadow-lg backdrop-blur hover:text-fg"
                >
                  <PanelLeft size={13} /> Медиатека <Kbd>B</Kbd>
                </button>
              )}
              {!panelOpen && (
                <button
                  onClick={togglePanel}
                  className="sidebar-chip absolute right-3 top-3 flex items-center gap-1.5 rounded-lg border border-line bg-panel/90 px-2.5 py-1.5 text-xs text-muted shadow-lg backdrop-blur hover:text-fg"
                >
                  <Wand2 size={13} /> {workspace === "edit" ? "План" : "Сгенерировать"} <Kbd>G</Kbd>
                </button>
              )}
            </div>
            {workspace === "edit" && (
              <>
                <Resizer axis="y" invert onDrag={adjustTimelineH} />
                <div style={{ height: timelineH }} className="shrink-0 bg-panel">
                  <TimelineStrip tall />
                </div>
              </>
            )}
          </main>

          <div data-open={panelOpen} className="sidebar-split" style={{ width: panelOpen ? undefined : 0 }}>
            <Resizer axis="x" invert onDrag={adjustPanelW} />
          </div>
          <aside
            data-open={panelOpen}
            style={{ width: panelOpen ? panelW : 0 }}
            className={clsx("sidebar-rail relative bg-panel", panelOpen && "border-l border-line")}
            aria-hidden={!panelOpen}
          >
            <div className="sidebar-rail-inner relative" style={{ width: panelW }}>
              <div className="absolute right-2 top-2 z-10">
                <IconButton
                  label="Скрыть панель (G)"
                  size="sm"
                  onClick={() => {
                    if (showPlanPanel) {
                      unbindPlanForm();
                      useTimeline.getState().selectPlan(null);
                    }
                    togglePanel();
                  }}
                >
                  <X size={14} />
                </IconButton>
              </div>
              {showPlanPanel ? <PlanInspector /> : <GeneratePanel />}
            </div>
          </aside>
        </div>
        )}
      </div>
      <SettingsDialog />
      <FaceRefineDialog />
      <EnhanceDialog />
      <MaskEditDialog />
      <RefModLibrary />
      <InterpolateDialog />
      <RefEditor />
      <AssistantSetup />
      <Toasts />
    </TipProvider>
  );
}
