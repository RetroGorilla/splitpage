import type { ActionRegistry, ActionSource } from "../../src/application/actions.ts";
import type { PreferenceChanges, PreferenceNotice, Preferences } from "../../src/application/preferences/preferences.ts";
import type { SaveChange, SaveState } from "../../src/application/save/save-state.ts";
import type { Blocker, ScreenState } from "../../src/application/screen.ts";

export function fakeScreen(initial: Partial<ScreenState> = {}) {
  const state: Record<Blocker, boolean> = {
    loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false,
    ...initial
  };
  const screen = (): ScreenState => ({ ...state });
  return { state, screen };
}

export function fakeActions(registry?: ActionRegistry) {
  const calls: { id: string; source: ActionSource }[] = [];
  const actions: Pick<ActionRegistry, "invoke" | "view"> = {
    invoke: (id, source) => {
      calls.push({ id, source });
      return registry ? registry.invoke(id, source) : { kind: "ran", id };
    },
    view: (id, source) => registry?.view(id, source)
  };
  return { actions, calls };
}

export function fakePreferenceChanges() {
  const listeners = new Set<(change: PreferenceNotice) => void>();
  const changes: PreferenceChanges = {
    onChange: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
  return {
    changes,
    listenerCount: (): number => listeners.size,
    emit: (change: PreferenceNotice): void => { for (const listener of [...listeners]) listener(change); }
  };
}

export function fakePreferences(initialScale = 1) {
  const notices = fakePreferenceChanges();
  const writes: (string | null)[] = [];
  let value = initialScale;
  const preferences: Pick<Preferences, "scriptScale" | "setScriptScale" | "clearScriptScale"> = {
    scriptScale: () => value,
    setScriptScale: (scale) => {
      value = Math.round(scale * 100) / 100;
      const stored = String(value);
      writes.push(stored);
      notices.emit({ name: "scriptScale", value: stored, elsewhere: false });
    },
    clearScriptScale: () => {
      value = 1;
      writes.push(null);
      notices.emit({ name: "scriptScale", value: null, elsewhere: false });
    }
  };
  return {
    preferences, writes, ...notices,
    changeElsewhere: (scale: number, announced: string | null = String(scale)): void => {
      value = scale;
      notices.emit({ name: "scriptScale", value: announced, elsewhere: true });
    }
  };
}

export function fakeSaveState(initial: { unsaved?: boolean; busy?: boolean } = {}) {
  const listeners = new Set<(change: SaveChange) => void>();
  const asked: ("dueNow" | "resume")[] = [];
  const state = { unsaved: !!initial.unsaved, busy: !!initial.busy };
  const saves: SaveState = {
    unsaved: () => state.unsaved,
    busy: () => state.busy,
    onChange: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dueNow: () => { asked.push("dueNow"); },
    resume: () => { asked.push("resume"); }
  };
  return {
    saves, state, asked,
    listenerCount: (): number => listeners.size,
    emit: (change: SaveChange): void => { for (const listener of [...listeners]) listener(change); }
  };
}
