import type { ReactNode } from "react";
import { urls } from "../../api/client";
import type { Estimate, Generation, MediaAsset } from "../../api/types";
import { reportJobError } from "../../lib/errors";
import { estimateBasis, fmtEstimate, fmtSeconds } from "../../lib/format";
import { Button, ErrorMessage, Spinner } from "../ui";

/** Shared loading / error shell while defaults fetch. */
export function JobLoading({ error, tall }: { error: string; tall?: boolean }) {
  return (
    <div className={`flex items-center justify-center gap-2 text-muted ${tall ? "h-60" : "h-48"}`}>
      {error ? <ErrorMessage text={error} /> : <><Spinner /> Готовлю клип…</>}
    </div>
  );
}

/** Source clip card shared by enhance / interpolate / face dialogs. */
export function AssetPreviewCard({
  asset,
  frames,
  durationSec,
  extra,
}: {
  asset: MediaAsset;
  frames: number;
  durationSec: number;
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-raised/40 p-2.5">
      {asset.thumb && (
        <img src={urls.assetThumb(asset.id)} alt="" className="h-12 w-20 rounded object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]">{asset.name}</p>
        <p className="text-[11px] text-faint tabular-nums">
          {frames} кадров · {fmtSeconds(durationSec)}
          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
          {extra}
        </p>
      </div>
    </div>
  );
}

export function JobFooter({
  onCancel,
  onSubmit,
  busy,
  estimate,
  label,
  icon,
}: {
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
  estimate: Estimate | null;
  label: string;
  icon: ReactNode;
}) {
  return (
    <div className="flex justify-end gap-2 border-t border-line pt-4">
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Отмена
      </Button>
      <Button variant="primary" size="lg" onClick={onSubmit} disabled={busy} title={estimateBasis(estimate)}>
        {busy ? <Spinner /> : icon} {label}
      </Button>
    </div>
  );
}

export function ModelEstimateLine({
  modelLabel,
  estimate,
}: {
  modelLabel: string;
  estimate: Estimate | null;
}) {
  return (
    <p className="text-[11px] text-faint">
      Модель: {modelLabel}
      {estimate ? (
        <>
          {" · "}
          <span title={estimateBasis(estimate)}>{fmtEstimate(estimate.seconds)}</span>
        </>
      ) : null}
    </p>
  );
}

/** Run a post-job create: upsert generation, select it, close; surface errors via reportJobError. */
export async function runAssetJob(
  create: () => Promise<Generation>,
  opts: {
    upsert: (g: Generation) => void;
    select: (id: number) => void;
    onDone: () => void;
    setBusy: (v: boolean) => void;
    setError: (v: string) => void;
  },
): Promise<void> {
  opts.setBusy(true);
  opts.setError("");
  try {
    const g = await create();
    opts.upsert(g);
    opts.select(g.id);
    opts.onDone();
  } catch (e) {
    reportJobError(e, opts.setError);
  } finally {
    opts.setBusy(false);
  }
}

export { reportJobError };
