export interface ProductionPrepSnapshot {
  readonly scenes: ReadonlySet<string>;
  readonly beat: string | null;
  readonly notes: string | null;
  readonly shown: ReadonlyMap<string, number>;
  readonly offsets: ReadonlyMap<string, number>;
  readonly filmed: ReadonlySet<string>;
  readonly requirements: ReadonlySet<string>;
  readonly selecting: boolean;
  readonly initialReady: ReadonlySet<string>;
  readonly ready: ReadonlySet<string>;
}

export interface ProductionPrepState {
  readonly current: () => ProductionPrepSnapshot;
  readonly initialize: (epoch: number, scene: string | null, beat: string | null, position: number, ready?: readonly string[]) => void;
  readonly reveal: (scene: string, beat: string, position: number, notes: string) => void;
  readonly toggleScene: (scene: string) => void;
  readonly toggleBeat: (beat: string) => void;
  readonly toggleNotes: (context: string) => void;
  readonly renameNotes: (from: string, to: string) => void;
  readonly showMore: (scene: string) => void;
  readonly showEarlier: (scene: string) => void;
  readonly toggleFilmed: (scene: string) => void;
  readonly toggleRequirements: (scene: string) => void;
  readonly toggleSelecting: () => void;
  readonly toggleReady: (container: string) => void;
  readonly reset: () => void;
}

export function createProductionPrepState(): ProductionPrepState {
  let epoch: number | null = null;
  let scenes = new Set<string>();
  let beat: string | null = null;
  let notes: string | null = null;
  let shown = new Map<string, number>();
  let offsets = new Map<string, number>();
  let filmed = new Set<string>();
  let requirements = new Set<string>();
  let selecting = false;
  let initialReady = new Set<string>();
  let ready = new Set<string>();
  function toggle(set: Set<string>, key: string): void {
    if (set.has(key)) set.delete(key);
    else set.add(key);
  }
  function reset(): void {
    epoch = null;
    scenes = new Set();
    beat = null;
    notes = null;
    shown = new Map();
    offsets = new Map();
    filmed = new Set();
    requirements = new Set();
    selecting = false;
    initialReady = new Set();
    ready = new Set();
  }
  return Object.freeze({
    current: () => ({ scenes, beat, notes, shown, offsets, filmed, requirements, selecting, initialReady, ready }),
    initialize: (nextEpoch: number, scene: string | null, focusedBeat: string | null, position: number, readyKeys: readonly string[] = []) => {
      if (epoch === nextEpoch) return;
      reset();
      epoch = nextEpoch;
      initialReady = new Set(readyKeys);
      if (scene !== null) {
        scenes.add(scene);
        offsets.set(scene, Math.max(0, position - 5));
      }
      beat = focusedBeat;
    },
    reveal: (scene: string, id: string, position: number, context: string) => {
      scenes.add(scene);
      offsets.set(scene, Math.max(0, position - 5));
      shown.set(scene, 8);
      beat = id;
      notes = context;
      ready.add("beat:" + id);
    },
    toggleScene: (scene: string) => {
      toggle(scenes, scene);
    },
    toggleBeat: (id: string) => {
      beat = beat === id ? null : id;
      notes = null;
    },
    toggleNotes: (context: string) => {
      notes = notes === context ? null : context;
    },
    renameNotes: (from: string, to: string) => {
      if (notes === from) notes = to;
    },
    showMore: (scene: string) => {
      shown.set(scene, (shown.get(scene) ?? 8) + 8);
    },
    showEarlier: (scene: string) => {
      const offset = offsets.get(scene) ?? 0;
      const added = Math.min(8, offset);
      offsets.set(scene, offset - added);
      shown.set(scene, (shown.get(scene) ?? 8) + added);
    },
    toggleFilmed: (scene: string) => {
      toggle(filmed, scene);
    },
    toggleRequirements: (scene: string) => {
      toggle(requirements, scene);
    },
    toggleSelecting: () => {
      selecting = !selecting;
    },
    toggleReady: (container: string) => { toggle(ready, container); },
    reset,
  });
}
