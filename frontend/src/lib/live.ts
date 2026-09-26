import type { EngineState, Generation, MediaAsset } from "../api/types";
import { useAssistant } from "../store/assistant";
import { useLibrary } from "../store/library";
import { notifyDone } from "./notify";

type LiveEvent =
  | { type: "generation"; generation: Generation }
  | { type: "generation_deleted"; id: number }
  | { type: "asset"; asset: MediaAsset }
  | { type: "preview"; generation_id: number; data: string }
  | { type: "engine"; engine: EngineState }
  | { type: "assistant_download" };

/** Keeps a websocket to the backend open forever; reconnects with backoff. */
export function connectLive(): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws.onopen = () => {
      retry = 500;
      // catch up on anything missed while disconnected
      useLibrary.getState().load().catch(() => undefined);
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data) as LiveEvent);
    ws.onclose = () => {
      if (closed) return;
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 8000);
    };
  };
  open();
  const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 20000);
  return () => {
    closed = true;
    clearInterval(ping);
    ws?.close();
  };
}

function handle(ev: LiveEvent) {
  const lib = useLibrary.getState();
  switch (ev.type) {
    case "generation": {
      const prev = lib.generations[ev.generation.id];
      lib.upsertGeneration(ev.generation);
      if (prev && prev.status !== ev.generation.status) notifyDone(ev.generation);
      break;
    }
    case "generation_deleted":
      lib.removeGeneration(ev.id);
      break;
    case "asset":
      lib.upsertAsset(ev.asset);
      break;
    case "preview":
      lib.setPreview(ev.generation_id, ev.data);
      break;
    case "engine":
      lib.setEngine(ev.engine);
      break;
    case "assistant_download":
      void useAssistant.getState().refresh();
      break;
  }
}
