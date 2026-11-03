import { sceneForBeat } from "../../core/document/scenes.ts";
import type { SceneDocument } from "../../core/document/scenes.ts";

export interface SceneView {
  readonly folded: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  readonly reveal: (doc: SceneDocument, rowId: string) => void;
  readonly reset: () => void;
  readonly subscribe: (changed: () => void) => () => void;
}

export function createSceneView(): SceneView {
  const folded = new Set<string>();
  const listeners = new Set<() => void>();
  function changed(): void { for (const listener of listeners) listener(); }
  return {
    folded: id => folded.has(id),
    toggle(id) { if (folded.has(id)) folded.delete(id); else folded.add(id); changed(); },
    reveal(doc, rowId) {
      if (!folded.size) return;
      const scene = sceneForBeat(doc, rowId);
      if (scene && folded.delete(scene.id)) changed();
    },
    reset() { if (!folded.size) return; folded.clear(); changed(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}
