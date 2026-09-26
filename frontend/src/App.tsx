import clsx from "clsx";
import { Clapperboard, Settings, Wand2, X } from "lucide-react";
import { useEffect } from "react";
import { AssistantSetup } from "./components/assistant/AssistantSetup";
import { FaceRefineDialog } from "./components/face/FaceRefineDialog";
import { RefEditor } from "./components/generate/RefEditor";
import { ChatView } from "./components/assistant/ChatView";
import { GeneratePanel } from "./components/generate/GeneratePanel";
import { EngineStatus } from "./components/layout/EngineStatus";
import { Resizer, usePanelSize } from "./components/layout/Resizer";
import { Toasts } from "./components/layout/Toasts";
import { MediaBin } from "./components/library/MediaBin";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { TimelineStrip } from "./components/timeline/TimelineStrip";
import { IconButton, Kbd, Spinner, TipProvider } from "./components/ui";
import { Viewer } from "./components/viewer/Viewer";
import { useHotkeys } from "./lib/hotkeys";
import { connectLive } from "./lib/live";
import { useAssistant } from "./store/assistant";
import { useForm } from "./store/form";
import { useLibrary } from "./store/library";
import { useTimeline } from "./store/timeline";
import { useUI } from "./store/ui";

export default function App() {
  const loaded = useLibrary((s) => s.loaded);
  const workspace = useUI((s) => s.workspace);
  const setWorkspace = useUI((s) => s.setWorkspace);
  const genDrawer = useUI((s) => s.genDrawer);
  const toggleGenDrawer = useUI((s) => s.toggleGenDrawer);
  const openSettings = useUI((s) => s.openSettings);

  const [binW, setBinW] = usePanelSize("bin", 300, 220, 520);
  const [panelW, setPanelW] = usePanelSize("gen", 400, 340, 620);
  const [timelineH, setTimelineH] = usePanelSize(`timeline.${workspace}`, workspace === "edit" ? 300 : 120, 90, 520);

  useHotkeys();

  useEffect(() => {
    const stop = connectLive();
    useLibrary
      .getState()
      .load()
      .then(() => {
        const meta = useLibrary.getState().meta!;
        useForm.getState().hydrate(meta.defaults);
      });
    void useAssistant.getState().refresh();
    fetch("/api/projects/1")
      .then((r) => r.json())
      .then((p) => useTimeline.getState().load(p.timeline))
      .catch(() => undefined);
    return stop;
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Spinner /> Подключение к ShellMax…
      </div>
    );
  }

  const showPanel = workspace === "generate";

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
          <span className="flex-1" />
          <EngineStatus />
          <IconButton label="Настройки" onClick={() => openSettings("engine")}>
            <Settings size={16} />
          </IconButton>
        </header>

        {/* body */}
        {workspace === "assistant" ? (
          <div className="min-h-0 flex-1">
            <ChatView />
          </div>
        ) : (
        <div className="flex min-h-0 flex-1">
          <aside style={{ width: binW }} className="shrink-0 bg-panel">
            <MediaBin />
          </aside>
          <Resizer axis="x" onDrag={(d) => setBinW(binW + d)} />

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <Viewer />
              {workspace === "edit" && !genDrawer && (
                <button
                  onClick={toggleGenDrawer}
                  className="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg border border-line bg-panel/90 px-2.5 py-1.5 text-xs text-muted shadow-lg backdrop-blur hover:text-fg"
                >
                  <Wand2 size={13} /> Сгенерировать <Kbd>G</Kbd>
                </button>
              )}
            </div>
            <Resizer axis="y" invert onDrag={(d) => setTimelineH(timelineH + d)} />
            <div style={{ height: timelineH }} className="shrink-0 bg-panel">
              <TimelineStrip tall={workspace === "edit"} />
            </div>
          </main>

          {(showPanel || genDrawer) && (
            <>
              <Resizer axis="x" invert onDrag={(d) => setPanelW(panelW + d)} />
              <aside style={{ width: panelW }} className="relative shrink-0 bg-panel">
                {workspace === "edit" && (
                  <div className="absolute right-2 top-2 z-10">
                    <IconButton label="Скрыть панель (G)" size="sm" onClick={toggleGenDrawer}>
                      <X size={14} />
                    </IconButton>
                  </div>
                )}
                <GeneratePanel />
              </aside>
            </>
          )}
        </div>
        )}
      </div>
      <SettingsDialog />
      <FaceRefineDialog />
      <RefEditor />
      <AssistantSetup />
      <Toasts />
    </TipProvider>
  );
}
