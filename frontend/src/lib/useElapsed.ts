import { useEffect, useState } from "react";

/** Live wall-clock seconds since `started` (ISO), ticking once per second. */
export function useElapsed(started: string | null | undefined): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [started]);
  if (!started) return null;
  return Math.max(0, (now - new Date(started).getTime()) / 1000);
}
