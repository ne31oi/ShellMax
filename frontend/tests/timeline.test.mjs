import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rolldown } from 'rolldown';

// Exercise actual command implementations; replace only persistence/UI boundaries.
const bundle = await rolldown({
  input: 'src/store/timeline.ts',
  platform: 'node',
  plugins: [{
    name: 'test-boundaries',
    resolveId(source) {
      if (['../api/client', '../lib/montageView', './ui'].includes(source)) return '\0' + source;
    },
    load(id) {
      if (id === '\0../api/client') return 'export const api = { saveTimeline: async () => ({}) };';
      if (id === '\0./ui') return 'export const useUI = { getState: () => ({ projectId: 1, setPanelOpen() {} }) };';
      if (id === '\0../lib/montageView') return 'export const loadMontageView = () => ({}); export const saveMontageView = () => {};';
    },
  }],
});
const generated = await bundle.generate({ format: 'esm' });
await bundle.close();
const { commands, emptyPlan, useTimeline } = await import('data:text/javascript;base64,' + Buffer.from(generated.output[0].code).toString('base64'));
const track = (id, plans) => ({ id, kind: 'plan', plans: plans.map(emptyPlan), clips: [] });
const timeline = (plans) => ({ tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'manual', assetId: 9, in: 1, out: 2 }], plans: [] }, ...plans] });

test('overlaps preserve source offsets; compilation and undo retain manual edit', () => {
  const doc = timeline([
    track('upper', [{ id: 'upper', start: 0, duration: 1, outputAssetId: 1 }]),
    track('lower', [{ id: 'lower', start: 0, duration: 2, sourceIn: 0.25, outputAssetId: 2 }]),
  ]);
  const command = commands.compilePlansToVideo(doc);
  const edited = command.apply(doc);
  assert.deepEqual(edited.tracks[0].clips.map(c => [c.assetId, c.in, c.out]), [[1, 0, 1], [2, 1.25, 2.25]]);
  assert.deepEqual(command.revert(edited), doc);
  useTimeline.getState().load(doc);
  useTimeline.getState().run(command);
  useTimeline.getState().undo();
  assert.deepEqual(useTimeline.getState().doc.tracks[0].clips, doc.tracks[0].clips);
  useTimeline.getState().redo();
  assert.deepEqual(useTimeline.getState().doc.tracks[0].clips, edited.tracks[0].clips);
});

test('missing middle or final material blocks assembly', () => {
  assert.throws(() => commands.compilePlansToVideo(timeline([track('p', [
    { id: 'a', start: 0, duration: 1, outputAssetId: 1 },
    { id: 'b', start: 2, duration: 1, outputAssetId: 2 },
  ])])), /пропуск/);
  assert.throws(() => commands.compilePlansToVideo(timeline([track('p', [
    { id: 'a', start: 0, duration: 1, outputAssetId: 1 },
    { id: 'b', start: 1, duration: 1 },
  ])])), /неготовые/);
});
