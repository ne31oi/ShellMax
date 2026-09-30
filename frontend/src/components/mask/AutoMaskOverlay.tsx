import type { AutoMaskLayer } from "../../api/types";
import { useLibrary } from "../../store/library";

/** The engine stores source-frame numbers, including a trimmed clip's offset. */
export function AutoMaskOverlay({ layer, time }: { layer: AutoMaskLayer; time: number }) {
  const job = useLibrary((s) => s.generations[layer.track_generation_id]);
  const sprite = job?.info?.mask?.sprite;
  if (!layer.visible || !sprite) return null;
  const index = Math.floor((Math.round(time * 24) - sprite.start) / sprite.step);
  if (index < 0 || index >= sprite.count) return null;
  const x = index % sprite.cols * sprite.tw, y = Math.floor(index / sprite.cols) * sprite.th;
  return <svg x={0} y={0} width={1} height={1} viewBox={`0 0 ${sprite.tw} ${sprite.th}`} preserveAspectRatio="none" className="pointer-events-none">
    <image href={`/api/mask-track/${layer.track_generation_id}/sprite`} x={-x} y={-y} width={sprite.cols * sprite.tw} height={Math.ceil(sprite.count / sprite.cols) * sprite.th} opacity={0.45} />
  </svg>;
}
