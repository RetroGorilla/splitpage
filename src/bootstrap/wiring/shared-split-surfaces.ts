import { sharedBufferedTarget } from "../../adapters/collab/buffer.ts";
import { readSharedOwnHiddenName } from "../../adapters/collab/paint-base.ts";
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
import type { SharedBindings, SharedSessionParts } from "./shared-session.ts";
import { currentWhoList } from "./who-list.ts";

export const SHARED_SPLIT_SURFACE_PENDING = "buffer-pending";
export const SHARED_SPLIT_SURFACE_FAILED = "surface-mount-failed";

export const SHARED_SPLIT_SURFACE_NOTICES = Object.freeze({
  failed: "The shared session ended because its title and scene boxes could not be set up.",
  titleCut: "Your typing met someone else's and the title went past " + TITLE_MAX + " characters, so its end is cut off.",
  sceneCut: "Your typing met someone else's and this scene name went past " + SCENE_NAME_MAX + " characters, so its end is cut off."
});

export interface SharedSplitSurfaceEnding {
  readonly leave: (reason: string) => void;
}

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
  const told = new Set<string>();
  function check(key: string, notice: string): void {
    const hidden = readSharedOwnHiddenName(parts.handle, sharedBufferedTarget(parts.handle, key));
    if (!hidden || told.has(key + "\n" + hidden)) return;
    told.add(key + "\n" + hidden);
    notices.show(notice, "warn");
  }
  return parts.session.subscribe(change => {
    const { whole, docFields } = change.changes;
    if (whole || docFields.includes("title")) check(TITLE_FIELD_KEY, SHARED_SPLIT_SURFACE_NOTICES.titleCut);
    if (!whole && !docFields.includes("sections")) return;
    for (const scene of parts.session.read(doc => normalizeScenes(doc?.sections)) ?? []) check(headingFieldKey(scene.id), SHARED_SPLIT_SURFACE_NOTICES.sceneCut);
  });
}

export function sharedSplitSurfaces(split: SharedBindings, effects: Pick<BufferedFieldPorts, "missingBase" | "recovered" | "report">,
  ending: SharedSplitSurfaceEnding): SharedBindings {
  let entered: SharedSessionParts | null = null, waiting: (() => void) | null = null;
  let surfaces: { readonly title: ReturnType<typeof mountTitlesFeature>; readonly scenes: ReturnType<typeof mountSceneHeadersFeature>;
    readonly empty: ReturnType<typeof mountSharedEmptyScript> | null; readonly cuts: () => void } | null = null;
  function failed(parts: SharedSessionParts): void {
    // why: the mount runs inside the switch or a session delivery, so the leave waits until that has returned
    queueMicrotask(() => {
      if (entered !== parts) return;
      notices.show(SHARED_SPLIT_SURFACE_NOTICES.failed, "warn");
      ending.leave(SHARED_SPLIT_SURFACE_FAILED);
    });
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
        ...effects, report: sharedCommandReport(notices, effects.report), author, readers: productionReaders, stamps: sessionStamps
      });
      const names = sharedBufferedInputPorts(text, sharedBufferedInputHistory(parts.handle, parts.session, parts.undo));
      made.push(() => { mountTitlesFeature(); });
      const title = mountTitlesFeature(names);
      made.push(() => { mountSceneHeadersFeature(); });
      const scenes = mountSceneHeadersFeature(names, sharedSceneCreation(parts.handle, parts.session, author));
      const host = document.getElementById("rows");
      const empty = host ? mountSharedEmptyScript({ handle: parts.handle, session: parts.session, author: parts.author,
        writer: () => String(collabState(parts.handle).doc.clientID), stamps: sessionStamps }, { host, edits, notices, report: effects.report, place: placeInSplit }) : null;
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
      if (surfaces && !(surfaces.title.finish() && surfaces.scenes.finish() && (surfaces.empty?.finish() ?? true))) return SHARED_SPLIT_SURFACE_PENDING;
      return split.settle();
    },
    leave: () => {
      const held = surfaces;
      if (held?.empty && !held.empty.dispose()) throw new Error(SHARED_SPLIT_SURFACE_PENDING);
      waiting?.(); waiting = null;
      surfaces = null; entered = null;
      const errors: unknown[] = [];
      if (held) for (const restore of [held.cuts, () => { mountTitlesFeature(); }, () => { mountSceneHeadersFeature(); }]) {
        try { restore(); } catch (error) { errors.push(error); }
      }
      try { split.leave(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Could not restore the standalone Split surfaces");
    }
  };
}
