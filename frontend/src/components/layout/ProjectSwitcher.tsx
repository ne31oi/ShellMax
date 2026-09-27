import { Check, ChevronDown, FolderPlus, Pencil } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { useLibrary } from "../../store/library";
import { emptyDoc, type TimelineDoc, useTimeline } from "../../store/timeline";
import { useUI } from "../../store/ui";
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui";

/** Header control: switch / create / rename projects. */
export function ProjectSwitcher() {
  const projectId = useUI((s) => s.projectId);
  const projects = useLibrary((s) => s.projects);
  const current = projects.find((p) => p.id === projectId) ?? projects[0];
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const switchTo = async (id: number) => {
    if (id === useUI.getState().projectId) return;
    useUI.getState().setProjectId(id);
    try {
      await useLibrary.getState().load();
      const p = await api.project(id);
      useTimeline.getState().load(p.timeline as unknown as TimelineDoc);
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось открыть проект", "bad");
    }
  };

  const create = async () => {
    const n = projects.length + 1;
    try {
      const p = await api.createProject(`Проект ${n}`);
      await useLibrary.getState().reloadProjects();
      await switchTo(p.id);
      useTimeline.getState().load(emptyDoc());
      useUI.getState().toast(`Создан «${p.name}»`, "ok");
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось создать проект", "bad");
    }
  };

  const commitRename = async () => {
    const name = nameDraft.trim();
    setRenaming(false);
    if (!name || !current || name === current.name) return;
    try {
      await api.renameProject(current.id, name);
      await useLibrary.getState().reloadProjects();
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось переименовать", "bad");
    }
  };

  if (renaming && current) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void commitRename();
        }}
      >
        <input
          autoFocus
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value.slice(0, 80))}
          onBlur={() => void commitRename()}
          className="h-7 w-40 rounded-md border border-accent/50 bg-raised px-2 text-xs outline-none"
        />
      </form>
    );
  }

  return (
    <Menu
      trigger={
        <Button size="sm" variant="ghost" className="max-w-[12rem] gap-1 font-normal">
          <span className="truncate">{current?.name ?? "Проект"}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </Button>
      }
    >
      <MenuLabel>Проект</MenuLabel>
      {projects.map((p) => (
        <MenuItem key={p.id} onSelect={() => void switchTo(p.id)}>
          <span className="w-4">{p.id === projectId ? <Check size={14} className="text-accent" /> : null}</span>
          <span className="truncate">{p.name}</span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        onSelect={() => {
          setNameDraft(current?.name ?? "");
          setRenaming(true);
        }}
        disabled={!current}
      >
        <Pencil size={13} /> Переименовать
      </MenuItem>
      <MenuItem onSelect={() => void create()}>
        <FolderPlus size={13} /> Новый проект
      </MenuItem>
    </Menu>
  );
}
