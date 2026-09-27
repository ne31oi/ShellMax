import type { EngineState, Generation, MediaAsset } from "../api/types";
import { api } from "../api/client";
import { useAssistant } from "../store/assistant";
import { useLibrary } from "../store/library";
import { commands, findClip, useTimeline } from "../store/timeline";
import { useUI } from "../store/ui";
import { notifyDone } from "./notify";

type LiveEvent =
  | { type: "generation"; generation: Generation }
  | { type: "generation_deleted"; id: number }
  | { type: "asset"; asset: MediaAsset }
  | { type: "asset_deleted"; id: number }
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
      maybeReplaceTimelineClip(prev, ev.generation);
      // Only sync plan row when status changes — not on every progress tick.
      if (!prev || prev.status !== ev.generation.status) {
        maybeRefreshPlanTimeline(ev.generation);
      }
      break;
    }
    case "generation_deleted":
      lib.removeGeneration(ev.id);
      break;
    case "asset":
      lib.upsertAsset(ev.asset);
      break;
    case "asset_deleted":
      lib.removeAsset(ev.id);
      break;
    case "preview": {
      if (localStorage.getItem("sm.nightMode") === "1") break;
      lib.setPreview(ev.generation_id, ev.data);
      break;
    }
    case "engine":
      lib.setEngine(ev.engine);
      break;
    case "assistant_download":
      void useAssistant.getState().refresh();
      break;
  }
}

/** If the user started face/enhance/interpolate from a timeline clip, swap that clip when the job finishes. */
function maybeReplaceTimelineClip(prev: Generation | undefined, gen: Generation) {
  if (gen.status !== "done" || !gen.output_asset_id) return;
  if (prev && prev.status === "done") return;
  const pending = useUI.getState().timelineReplace;
  if (!pending) return;
  if (gen.source_asset_id !== pending.expectSourceAssetId) return;
  const hit = findClip(useTimeline.getState().doc, pending.clipId);
  if (!hit) {
    useUI.getState().setTimelineReplace(null);
    return;
  }
  useTimeline.getState().run(commands.replaceClipAsset(useTimeline.getState().doc, pending.clipId, gen.output_asset_id));
  useUI.getState().setTimelineReplace(null);
  useUI.getState().toast("Клип на таймлайне обновлён", "ok");
  useUI.getState().setViewingSequence(true);
}

/** Storyboard plan jobs write status into Project.timeline on the server — pull it. */
function maybeRefreshPlanTimeline(gen: Generation) {
  const planId = (gen.info as { plan_id?: string } | null)?.plan_id;
  if (!planId) return;
  if (!["done", "draft_only", "error", "running", "queued"].includes(gen.status)) return;
  const projectId = useUI.getState().projectId;
  void api.project(projectId).then((p) => {
    const selected = useTimeline.getState().selectedPlanId;
    useTimeline.getState().load(p.timeline as never);
    if (selected) useTimeline.getState().selectPlan(selected);
  }).catch(() => undefined);
}
