import { RefreshCw } from "lucide-react";
import { useRestartAll } from "../../lib/restart";
import { IconButton } from "../ui";

/** Header control: full ShellMax restart (API + engine + assistant). */
export function RestartAllButton() {
  const { restarting, restartAll, overlay } = useRestartAll();
  return (
    <>
      <IconButton label="Перезапустить всё" disabled={restarting} onClick={restartAll}>
        <RefreshCw size={16} className={restarting ? "animate-spin" : undefined} />
      </IconButton>
      {overlay}
    </>
  );
}
