import { createSceneBoundaryRemoval } from "../../application/editing/scene-boundary.ts";
import { removeSceneCommand } from "../../application/commands/scenes.ts";
import { sceneGroups, soleBeatSceneMovedBy } from "../../core/document/scenes.ts";
import { mountSceneBoundary } from "../../features/editing/scene-boundary.ts";
import { mountSceneControls } from "../../features/rows/scene-controls.ts";
import type { BufferedInputPorts } from "../../features/common/buffered-input.ts";
import { documentReader } from "./ports/document.ts";
import { edits } from "./ports/editing.ts";
import { notices } from "./ports/effects.ts";
import { ids } from "./ports/identity.ts";
import { focusMemory, rowDrag, sceneView } from "./editor-owners.ts";
import { stopDragScroll, updateDragScroll } from "./rows.ts";
import { undoOwner } from "./undo.ts";

export function mountSceneHeaders(sharedNames?: BufferedInputPorts): { confirmMove: (rowId: string, dir: -1 | 1) => boolean; dispose: () => void } {
  const controls = mountSceneControls(window, {
    document: documentReader, edits, scenes: sceneView(), focus: focusMemory(),
    drag: rowDrag(), ids, notices, scroll: updateDragScroll, stopScroll: stopDragScroll, ...sharedNames ? { sharedNames } : {}
  });
  const boundary = createSceneBoundaryRemoval({
    timers: {
      now: () => Date.now(),
      start: (run, ms) => window.setTimeout(run, ms),
      stop: timer => window.clearTimeout(timer as number)
    },
    hint: controls.hint,
    remove: (id, key) => {
      if (key.startsWith("Alt+")) { undoOwner().breakCoalescing(); return; }
      const doc = documentReader.current();
      const group = doc && sceneGroups(doc).find(item => item.scene.id === id);
      const previous = doc && group && doc.rows[group.start - 1];
      if (doc && previous) sceneView().reveal(doc, previous.id);
      undoOwner().breakCoalescing();
      edits.run(removeSceneCommand(id));
    }
  });
  let input: ReturnType<typeof mountSceneBoundary> | null = null;
  function syncInput(): void {
    boundary.cancel();
    const scenes = documentReader.current()?.sections;
    if (Array.isArray(scenes) && scenes.length) {
      input ??= mountSceneBoundary(window, { document: documentReader, boundary, allowed: edits.allowed });
    } else { input?.dispose(); input = null; }
  }
  syncInput();
  const offChange = documentReader.onChange(syncInput);
  const offReplaced = documentReader.onReplaced(() => { syncInput(); controls.reset(); });
  function confirmMove(rowId: string, dir: -1 | 1): boolean {
    const doc = documentReader.current();
    const scene = doc && edits.allowed() ? soleBeatSceneMovedBy(doc, rowId, dir) : undefined;
    if (!scene) { boundary.cancel(); return false; }
    return !boundary.press(scene.id, dir < 0 ? "Alt+ArrowUp" : "Alt+ArrowDown");
  }
  return { confirmMove, dispose() { offChange(); offReplaced(); input?.dispose(); boundary.dispose(); controls.dispose(); } };
}
