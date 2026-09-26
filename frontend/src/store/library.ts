import { create } from "zustand";
import { api } from "../api/client";
import type { EngineState, Generation, MediaAsset, Meta, ProfileRow, Style } from "../api/types";

interface LibraryState {
  meta: Meta | null;
  engine: EngineState | null;
  generations: Record<number, Generation>;
  assets: Record<number, MediaAsset>;
  previews: Record<number, string>; // generation id -> latest latent preview (data URL)
  profiles: ProfileRow[];
  styles: Style[];
  loaded: boolean;

  load: () => Promise<void>;
  reloadProfiles: () => Promise<void>;
  reloadStyles: () => Promise<void>;
  upsertGeneration: (g: Generation) => void;
  removeGeneration: (id: number) => void;
  upsertAsset: (a: MediaAsset) => void;
  setPreview: (genId: number, data: string) => void;
  setEngine: (e: EngineState) => void;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  meta: null,
  engine: null,
  generations: {},
  assets: {},
  previews: {},
  profiles: [],
  styles: [],
  loaded: false,

  load: async () => {
    const [meta, engine, gens, assets, profiles, styles] = await Promise.all([
      api.meta(),
      api.engine(),
      api.generations(),
      api.assets(),
      api.profiles(),
      api.styles(),
    ]);
    const prev = get().generations;
    set({
      meta,
      engine,
      // REST has no live step info; keep what the websocket already told us
      generations: Object.fromEntries(gens.map((g) => [g.id, g.status === "running" ? { ...g, step: prev[g.id]?.step } : g])),
      assets: Object.fromEntries(assets.map((a) => [a.id, a])),
      profiles,
      styles,
      loaded: true,
    });
  },
  reloadProfiles: async () => set({ profiles: await api.profiles() }),
  reloadStyles: async () => set({ styles: await api.styles() }),

  upsertGeneration: (g) =>
    set((s) => {
      const previews = { ...s.previews };
      if (g.status !== "running") delete previews[g.id];
      return { generations: { ...s.generations, [g.id]: g }, previews };
    }),
  removeGeneration: (id) =>
    set((s) => {
      const generations = { ...s.generations };
      delete generations[id];
      return { generations };
    }),
  upsertAsset: (a) => set((s) => ({ assets: { ...s.assets, [a.id]: a } })),
  setPreview: (genId, data) => {
    if (get().generations[genId]?.status === "running") set((s) => ({ previews: { ...s.previews, [genId]: data } }));
  },
  setEngine: (engine) => set({ engine }),
}));

export const sortedGenerations = (gens: Record<number, Generation>) =>
  Object.values(gens).sort((a, b) => b.id - a.id);

export const defaultProfile = (profiles: ProfileRow[]) => profiles.find((p) => p.is_default) ?? profiles[0];
