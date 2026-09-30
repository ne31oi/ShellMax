import { Power } from "lucide-react";
import { useShutdownAll } from "../../lib/restart";
import { IconButton } from "../ui";

/** Header control: full ShellMax shutdown (API + engine + assistant, no relaunch). */
export function ShutdownAllButton() {
  const { shuttingDown, shutdownAll, overlay } = useShutdownAll();
  return (
    <>
      <IconButton label="Выключить всё" disabled={shuttingDown} onClick={shutdownAll}>
        <Power size={16} />
      </IconButton>
      {overlay}
    </>
  );
}
