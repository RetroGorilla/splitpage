import { sharedBufferedTarget } from "../../adapters/collab/buffer.ts";
import { readSharedOwnClock } from "../../adapters/collab/paint-base.ts";
import { createSharedNameCutWatch } from "../../adapters/collab/name-cut-watch.ts";
import { collabState } from "../../adapters/collab/state.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { TITLE_FIELD_KEY, headingFieldKey } from "../../application/editing/buffered-field-key.ts";
import { TITLE_MAX } from "../../core/document/file-title.ts";
import { normalizeScenes } from "../../core/document/scenes.ts";
import { SCENE_NAME_MAX } from "../../core/flow/flow.ts";
import { setCellSelection } from "../../features/common/cell-selection.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { render } from "../../features/rows/render.ts";
import { hideTagGhost, hideUntaggedPrompt } from "../../features/tags/production-tags.ts";
import { productionReaders } from "../document-ports.ts";
import { sharedBufferedInputHistory, sharedBufferedInputPorts } from "./buffered-input.ts";
import { mountSceneHeadersFeature, mountTitlesFeature } from "./editor.ts";
import { currentPlainTags } from "./plain-tags.ts";
import { edits } from "./ports/editing.ts";
import { notices } from "./ports/effects.ts";
import { mountSharedEmptyScript } from "./ports/empty-script.ts";
import { sharedBufferPorts } from "./ports/shared-buffer.ts";
import { sharedCommandReport } from "./ports/shared-command-notices.ts";
import { sharedSceneCreation } from "./ports/shared-scenes.ts";
import { sessionStamps } from "./session-owner.ts";
import { forceLeaveSharedSession } from "./shared-session.ts";
import type { SharedBindings, SharedSessionParts } from "./shared-session.ts";
import { currentWhoList } from "./who-list.ts";

export const SHARED_SPLIT_SURFACE_PENDING = "buffer-pending";
const SHARED_SPLIT_SURFACE_FAILED = "surface-mount-failed";

export const SHARED_SPLIT_SURFACE_NOTICES = Object.freeze({
  failed: "The shared session ended because its title and scene boxes could not be set up.",
  titleCut: "Your typing met someone else's and the title went past " + TITLE_MAX + " characters, so its end is cut off.",
  sceneCut: "Your typing met someone else's and this scene name went past " + SCENE_NAME_MAX + " characters, so its end is cut off."
});

function placeInSplit(rowId: string, offset: number): boolean {
  render();
  const cell = document.querySelector<HTMLElement>('#rows .cell-editable[data-id="' + cssAttr(rowId) + '"][data-field="audioText"]');
  if (!cell) return false;
  cell.focus(); setCellSelection(cell, offset);
  return true;
}

function closeSplitCompletions(): void {
  hideTagGhost();
  currentPlainTags()?.cancel();
  currentWhoList()?.cancel();
  hideUntaggedPrompt();
}

function watchCuts(parts: SharedSessionParts): () => void {
  const hidden = new Map<string, ReadonlySet<string>>(), since = readSharedOwnClock(parts.handle);
  const watch = createSharedNameCutWatch(parts.handle, () => [TITLE_FIELD_KEY,
    ...parts.session.read(doc => (normalizeScenes(doc?.sections) ?? []).map(scene => headingFieldKey(scene.id)))].map(key => sharedBufferedTarget(parts.handle, key)), since);
  function check(key: string, notice: string, units: readonly string[]): void {
    const now: ReadonlySet<string> = new Set(units);
    const before = hidden.get(key);
    if (now.size) hidden.set(key, now); else hidden.delete(key);
    if ([...now].some(unit => !before?.has(unit))) notices.show(notice, "warn");
  }
  try {
    watch.check();
    const stop = parts.session.subscribe(() => {
      for (const { address, units } of watch.check()) check(address.field === "title" ? TITLE_FIELD_KEY : headingFieldKey(address.owner),
        address.field === "title" ? SHARED_SPLIT_SURFACE_NOTICES.titleCut : SHARED_SPLIT_SURFACE_NOTICES.sceneCut, units);
    });
    return () => { stop(); watch.dispose(); };
  } catch (error) { watch.dispose(); throw error; }
}

export function sharedSplitSurfaces(split: SharedBindings & { readonly abandonable?: () => number },
  effects: Pick<BufferedFieldPorts, "missingBase" | "recovered" | "report">): SharedBindings & { readonly abandonable: () => number } {
  let entered: SharedSessionParts | null = null, waiting: (() => void) | null = null, failing: (() => void) | null = null;
  let surfaces: { readonly title: ReturnType<typeof mountTitlesFeature>; readonly scenes: ReturnType<typeof mountSceneHeadersFeature>;
    readonly empty: ReturnType<typeof mountSharedEmptyScript> | null; readonly cuts: () => void } | null = null;
  const abandons = new Set<(final: boolean) => void>();
  const abandonment = (abandon: (final: boolean) => void): (() => void) => { abandons.add(abandon); return () => { abandons.delete(abandon); }; };
  function abandonAll(final: boolean): void {
    const errors: unknown[] = [];
    for (const abandon of [...abandons]) { try { abandon(final); } catch (error) { errors.push(error); } }
    if (errors.length) throw errors[0];
  }
  function releaseFailure(): void {
    const release = failing; failing = null;
    release?.();
  }
  function finishSurfaces(): boolean {
    return !surfaces || surfaces.title.finish() && surfaces.scenes.finish() && (surfaces.empty?.finish() ?? true);
  }
  function failed(parts: SharedSessionParts): void {
    const release = parts.session.hold(SHARED_SPLIT_SURFACE_FAILED);
    failing = release;
    // why: the switch holds its lock until the entry or delivery that mounted returns, so the leave is the next task
    window.setTimeout(() => {
      release();
      if (failing === release) failing = null;
      if (entered !== parts) return;
      notices.show(SHARED_SPLIT_SURFACE_NOTICES.failed, "warn");
      forceLeaveSharedSession();
    }, 0);
  }
  function mount(parts: SharedSessionParts): void {
    const made: (() => void)[] = [];
    try {
      const author = (): { readonly id: string; readonly by: string } => {
        const next = parts.author.next();
        if (!next) throw new Error("The shared Split has no author");
        return next;
      };
      const text = sharedBufferPorts(parts.handle, parts.session, {
        ...effects, report: sharedCommandReport(notices, effects.report), author, readers: productionReaders, stamps: sessionStamps, abandonment
      });
      const names = sharedBufferedInputPorts(text, sharedBufferedInputHistory(parts.handle, parts.session, parts.undo));
      made.push(() => { mountTitlesFeature(); });
      const title = mountTitlesFeature(names);
      made.push(() => { mountSceneHeadersFeature(); });
      const scenes = mountSceneHeadersFeature(names, { ...sharedSceneCreation(parts.handle, parts.session, author), abandonment });
      const host = document.getElementById("rows");
      const empty = host ? mountSharedEmptyScript({ handle: parts.handle, session: parts.session, author: parts.author,
        writer: () => String(collabState(parts.handle).doc.clientID), stamps: sessionStamps },
      { host, edits, notices, report: effects.report, place: placeInSplit, abandonment }) : null;
      if (empty) made.push(() => { empty.dispose(); });
      const cuts = watchCuts(parts);
      surfaces = { title, scenes, empty, cuts };
    } catch (error) {
      surfaces = null;
      const errors: unknown[] = [error];
      for (const undo of made.reverse()) {
        try { undo(); } catch (unwound) { errors.push(unwound); }
      }
      failed(parts);
      throw errors.length === 1 ? error : new AggregateError(errors, "Could not set up the shared Split surfaces");
    }
  }
  return {
    enter: parts => {
      closeSplitCompletions();
      split.enter(parts);
      if (entered === parts && (surfaces || waiting)) return;
      entered = parts;
      if (parts.session.revision() !== 0) { mount(parts); return; }
      // why: the switch binds before it hydrates, and the name boxes read their stored text as they bind
      const stop = parts.session.subscribe(() => {
        stop(); waiting = null;
        if (entered === parts && !surfaces) mount(parts);
      });
      waiting = stop;
    },
    settle: () => {
      // why: a leave in the failed-mount gap would settle under the failure hold, so every exit lifts it before landing
      releaseFailure();
      if (!finishSurfaces()) return SHARED_SPLIT_SURFACE_PENDING;
      return split.settle();
    },
    abandon: () => {
      const errors: unknown[] = [];
      for (const step of [() => { abandonAll(false); }, () => { split.abandon?.(); }]) {
        try { step(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
    },
    drop: () => {
      const errors: unknown[] = [];
      releaseFailure();
      for (const step of [() => { abandonAll(true); }, () => { split.drop?.(); }]) {
        try { step(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
    },
    abandonable: () => abandons.size + (split.abandonable?.() ?? 0),
    leave: () => {
      if (!finishSurfaces()) throw new Error(SHARED_SPLIT_SURFACE_PENDING);
      const mounted = surfaces;
      if (mounted?.empty && !mounted.empty.dispose()) throw new Error(SHARED_SPLIT_SURFACE_PENDING);
      waiting?.(); waiting = null;
      releaseFailure();
      surfaces = null; entered = null;
      const errors: unknown[] = [];
      try { closeSplitCompletions(); } catch (error) { errors.push(error); }
      if (mounted) for (const restore of [mounted.cuts, () => { mountTitlesFeature(); }, () => { mountSceneHeadersFeature(); }]) {
        try { restore(); } catch (error) { errors.push(error); }
      }
      try { split.leave(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Could not restore the standalone Split surfaces");
    }
  };
}
