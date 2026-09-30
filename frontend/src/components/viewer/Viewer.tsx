import { useEffect, useState } from "react";
import * as actions from "../../lib/actions";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { useTimeline, hasSequenceContent } from "../../store/timeline";
import { SequenceEmptyHint, SequencePlayer } from "../timeline/SequencePlayer";
import { ClipInfo } from "./ClipInfo";
import { CompareView } from "./CompareView";
import { ErrorView } from "./ErrorView";
import { DraftBanner, FaceTrackBanner, LiveView } from "./LiveProgress";
import { Player } from "./Player";
import { Welcome } from "./Welcome";
import { JobResultEmpty } from "./JobResultEmpty";
import { sourceComparison } from "./source-comparison";

export function Viewer() {
  const selectedGen = useUI((s) => s.selectedGen);
  const selectedAsset = useUI((s) => s.selectedAsset);
  const compareWith = useUI((s) => s.compareWith);
  const viewingSequence = useUI((s) => s.viewingSequence);
  const workspace = useUI((s) => s.workspace);
  const gen = useLibrary((s) => (selectedGen ? s.generations[selectedGen] : undefined));
  const other = useLibrary((s) => (compareWith ? s.generations[compareWith] : undefined));
  const assets = useLibrary((s) => s.assets);
  const preview = useLibrary((s) => (selectedGen ? s.previews[selectedGen] : undefined));
  const canPlaySequence = useTimeline((s) => hasSequenceContent(s.doc));
  const [resultOnly, setResultOnly] = useState(false);
  useEffect(() => setResultOnly(false), [selectedGen]);

  const showSequence =
    viewingSequence || (workspace === "edit" && !selectedGen && !selectedAsset && canPlaySequence);
  if (showSequence) {
    return (
      <div className="flex h-full flex-col">
        {canPlaySequence ? <SequencePlayer /> : <SequenceEmptyHint />}
      </div>
    );
  }

  if (!gen && !selectedAsset) return workspace === "edit" ? <SequenceEmptyHint /> : <Welcome />;

  if (selectedAsset && assets[selectedAsset]) {
    return (
      <div className="flex h-full flex-col">
        <Player key={selectedAsset} asset={assets[selectedAsset]} />
      </div>
    );
  }
  if (!gen) return <Welcome />;

  const draft = gen.draft_asset_id ? assets[gen.draft_asset_id] : undefined;
  const final = gen.output_asset_id ? assets[gen.output_asset_id] : undefined;
  const otherAsset = actions.outputAsset(other, assets);
  const comparison = sourceComparison(gen, assets);
  const sourceAsset = comparison?.asset;
  const showBeforeAfter = !!final && !!sourceAsset && !resultOnly && !otherAsset;

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        {showBeforeAfter ? (
          <CompareView
            key={`ba-${sourceAsset.id}-${final.id}`}
            a={sourceAsset}
            b={final}
            aStart={comparison?.start}
            durationLimit={comparison?.duration}
            labelA="До"
            labelB="После"
            onClose={() => setResultOnly(true)}
            closeLabel="Только результат"
          />
        ) : gen.kind === "face" && gen.status === "running" && draft ? (
          <Player asset={draft} badge="Трекинг" overlay={<FaceTrackBanner gen={gen} />} />
        ) : final && otherAsset ? (
          <CompareView
            key={`ab-${final.id}-${otherAsset.id}`}
            a={final}
            b={otherAsset}
            labelA={`#${gen.id}`}
            labelB={`#${other!.id}`}
          />
        ) : final || (draft && gen.status !== "running") ? (
          <Player key={final?.id ?? draft!.id} asset={(final ?? draft)!} badge={!final ? "Черновик" : undefined} />
        ) : gen.status === "running" && draft ? (
          <Player asset={draft} badge="Черновик" overlay={<DraftBanner gen={gen} />} />
        ) : gen.status === "running" || gen.status === "queued" ? (
          <LiveView gen={gen} preview={preview} />
        ) : gen.status === "error" ? (
          <ErrorView gen={gen} />
        ) : (
          <JobResultEmpty gen={gen} />
        )}
      </div>
      {gen.kind !== "refmod_create" && gen.kind !== "mask_track" && <ClipInfo
        gen={gen}
        comparing={showBeforeAfter}
        canToggleCompare={!!final && !!sourceAsset && !otherAsset}
        onToggleCompare={() => setResultOnly((v) => !v)}
      />}
    </div>
  );
}

export { Player } from "./Player";
