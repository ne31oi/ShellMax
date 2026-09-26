/** Tiny app-wide event bus for cross-panel commands (hotkeys, "insert tag into prompt"...). */
type Events = {
  generate: void;
  insertMention: string; // ref uid
  focusPrompt: void;
  viewerToggle: void;
  viewerStep: number; // frames
  viewerRate: number; // J/K/L shuttle: -1, 0, 1
  viewerFullscreen: void;
};

const target = new EventTarget();

export function emit<K extends keyof Events>(name: K, detail?: Events[K]) {
  target.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on<K extends keyof Events>(name: K, fn: (detail: Events[K]) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent).detail);
  target.addEventListener(name, handler);
  return () => target.removeEventListener(name, handler);
}
