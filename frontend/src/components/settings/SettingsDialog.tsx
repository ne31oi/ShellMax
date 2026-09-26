import * as Tabs from "@radix-ui/react-tabs";
import clsx from "clsx";
import { Cpu, Palette, Settings2 } from "lucide-react";
import { useUI, type SettingsTab } from "../../store/ui";
import { Dialog } from "../ui";
import { EngineSettings } from "./EngineSettings";
import { StylesSettings } from "./StylesSettings";
import { SystemSettings } from "./SystemSettings";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "engine", label: "Движок", icon: <Cpu size={14} /> },
  { id: "styles", label: "Стили", icon: <Palette size={14} /> },
  { id: "system", label: "Система", icon: <Settings2 size={14} /> },
];

export function SettingsDialog() {
  const tab = useUI((s) => s.settings);
  const open = useUI((s) => s.openSettings);
  return (
    <Dialog open={tab !== null} onOpenChange={(o) => !o && open(null)} title="Настройки" wide>
      <Tabs.Root value={tab ?? "engine"} onValueChange={(v) => open(v as SettingsTab)} className="flex min-h-[60vh]">
        <Tabs.List className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-line p-2">
          {TABS.map((t) => (
            <Tabs.Trigger
              key={t.id}
              value={t.id}
              className={clsx(
                "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none",
                tab === t.id ? "bg-hover text-fg" : "text-muted hover:text-fg",
              )}
            >
              {t.icon}
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div className="min-w-0 flex-1">
          <Tabs.Content value="engine"><EngineSettings /></Tabs.Content>
          <Tabs.Content value="styles"><StylesSettings /></Tabs.Content>
          <Tabs.Content value="system"><SystemSettings /></Tabs.Content>
        </div>
      </Tabs.Root>
    </Dialog>
  );
}
