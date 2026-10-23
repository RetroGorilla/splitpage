import type { ActionRegistry, ActionSource } from "../../src/application/actions.ts";
import type { PreferenceChanges, PreferenceNotice, Preferences } from "../../src/application/preferences/preferences.ts";
import type { Blocker, ScreenState } from "../../src/application/screen.ts";
import type { ReviewFacts } from "../../src/application/collaboration/review.ts";
import type { DocumentView, SessionListener } from "../../src/application/session/document-session.ts";
import type { DocumentReader } from "../../src/application/session/document-reader.ts";

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

function listenerSet<L>() {
  const listeners = new Set<L>();
  return {
    listeners,
    add: (listener: L): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
}

export function fakeDocument(initial: DocumentView | null = null) {
  let held = initial;
  const changes = listenerSet<SessionListener>();
  const replaced = listenerSet<() => void>();
  const refreshes = listenerSet<(jobs: ReadonlySet<string>) => void>();
  const document: DocumentReader = {
    current: () => held,
    read: (select) => select(held),
    onChange: changes.add,
    onReplaced: replaced.add,
    onRefresh: refreshes.add
  };
  return {
    document,
    replace: (doc: DocumentView | null): void => {
      held = doc;
      for (const listener of [...replaced.listeners]) listener();
    },
    refresh: (jobs: readonly string[]): void => {
      for (const listener of [...refreshes.listeners]) listener(new Set(jobs));
    },
    listenerCount: (): number => changes.listeners.size + replaced.listeners.size + refreshes.listeners.size
  };
}

export function fakeReview(initial = false) {
  let reviewing = initial;
  let refusals = 0;
  const review: ReviewFacts = {
    reviewing: () => reviewing,
    refuseInReview: () => {
      if (!reviewing) return false;
      refusals++;
      return true;
    }
  };
  return {
    review,
    setReviewing: (on: boolean): void => { reviewing = on; },
    refusals: (): number => refusals
  };
}
