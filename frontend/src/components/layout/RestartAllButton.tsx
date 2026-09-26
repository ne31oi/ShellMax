import { Power } from "lucide-react";
import { useRestartAll } from "../../lib/restart";
import { IconButton } from "../ui";

/** Header control: full ShellMax restart (API + engine + assistant). */
export function RestartAllButton() {
  const { restarting, restartAll, overlay } = useRestartAll();
  return (
    <>
      <IconButton label="Перезапустить всё" disabled={restarting} onClick={restartAll}>
        <Power size={16} />
      </IconButton>
      {overlay}
    </>
  );
}
