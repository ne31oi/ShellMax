/** Tiny Web Audio cue for J/L-cut timeline demos — only after a user gesture. */
export function playJlCutCue(kind: "jcut" | "lcut"): void {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const now = ctx.currentTime;

  const beep = (t: number, freq: number, dur: number, gain = 0.08) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  };

  if (kind === "jcut") {
    // Sound leads picture
    beep(now, 440, 0.18);
    beep(now + 0.35, 520, 0.12, 0.05);
  } else {
    // Picture leads, sound follows
    beep(now + 0.45, 390, 0.22);
    beep(now + 0.7, 330, 0.15, 0.05);
  }

  window.setTimeout(() => void ctx.close(), 1500);
}
