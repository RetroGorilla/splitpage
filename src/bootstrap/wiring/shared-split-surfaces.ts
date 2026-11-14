import { collabState } from "../../adapters/collab/state.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { setCellSelection } from "../../features/common/cell-selection.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { render } from "../../features/rows/render.ts";
import { productionReaders } from "../document-ports.ts";
import { sharedBufferedInputHistory, sharedBufferedInputPorts } from "./buffered-input.ts";
import { mountSceneHeadersFeature, mountTitlesFeature } from "./editor.ts";
import { edits } from "./ports/editing.ts";
import { notices } from "./ports/effects.ts";
import { mountSharedEmptyScript } from "./ports/empty-script.ts";
import { sharedBufferPorts } from "./ports/shared-buffer.ts";
import { sharedCommandReport } from "./ports/shared-command-notices.ts";
import { sharedSceneCreation } from "./ports/shared-scenes.ts";
import { sessionStamps } from "./session-owner.ts";
import type { SharedBindings, SharedSessionParts } from "./shared-session.ts";

export const SHARED_SPLIT_SURFACE_PENDING = "buffer-pending";

function placeInSplit(rowId: string, offset: number): boolean {
  render();
  const cell = document.querySelector<HTMLElement>('#rows .cell-editable[data-id="' + cssAttr(rowId) + '"][data-field="audioText"]');
  if (!cell) return false;
  cell.focus(); setCellSelection(cell, offset);
  return true;
}

export function sharedSplitSurfaces(split: SharedBindings, effects: Pick<BufferedFieldPorts, "missingBase" | "recovered" | "report">): SharedBindings {
  let entered: SharedSessionParts | null = null;
  let surfaces: { readonly title: ReturnType<typeof mountTitlesFeature>; readonly scenes: ReturnType<typeof mountSceneHeadersFeature>;
    readonly empty: ReturnType<typeof mountSharedEmptyScript> | null } | null = null;
  return {
    enter: parts => {
      split.enter(parts);
      if (entered === parts && surfaces) return;
      entered = parts;
      const author = (): { readonly id: string; readonly by: string } => {
        const next = parts.author.next();
        if (!next) throw new Error("The shared Split has no author");
        return next;
      };
      const text = sharedBufferPorts(parts.handle, parts.session, {
        ...effects, report: sharedCommandReport(notices, effects.report), author, readers: productionReaders, stamps: sessionStamps
      });
      const names = sharedBufferedInputPorts(text, sharedBufferedInputHistory(parts.handle, parts.session, parts.undo));
      const title = mountTitlesFeature(names), scenes = mountSceneHeadersFeature(names, sharedSceneCreation(parts.handle, parts.session, author));
      surfaces = { title, scenes, empty: null };
      const host = document.getElementById("rows");
      const empty = host ? mountSharedEmptyScript({ handle: parts.handle, session: parts.session, author: parts.author,
        writer: () => String(collabState(parts.handle).doc.clientID), stamps: sessionStamps }, { host, edits, notices, report: effects.report, place: placeInSplit }) : null;
      surfaces = { title, scenes, empty };
    },
    settle: () => {
      if (surfaces && !(surfaces.title.finish() && surfaces.scenes.finish() && (surfaces.empty?.finish() ?? true))) return SHARED_SPLIT_SURFACE_PENDING;
      return split.settle();
    },
    leave: () => {
      const held = surfaces;
      if (held?.empty && !held.empty.dispose()) throw new Error(SHARED_SPLIT_SURFACE_PENDING);
      surfaces = null; entered = null;
      const errors: unknown[] = [];
      if (held) for (const restore of [() => { mountTitlesFeature(); }, () => { mountSceneHeadersFeature(); }]) {
        try { restore(); } catch (error) { errors.push(error); }
      }
      try { split.leave(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Could not restore the standalone Split surfaces");
    }
  };
}
