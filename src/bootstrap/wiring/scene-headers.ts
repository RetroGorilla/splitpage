import { createSceneBoundaryRemoval } from "../../application/editing/scene-boundary.ts";
import { removeSceneCommand } from "../../application/commands/scenes.ts";
import { sceneGroups, soleBeatSceneMovedBy } from "../../core/document/scenes.ts";
import { mountSceneBoundary } from "../../features/editing/scene-boundary.ts";
import { mountSceneControls } from "../../features/rows/scene-controls.ts";
import { createViewLifetime } from "../../features/common/view-lifetime.ts";
import type { BufferedInputPorts } from "../../features/common/buffered-input.ts";
import type { SharedSceneCreation } from "../../application/commands/shared-scenes.ts";
import { documentReader } from "./ports/document.ts";
import { edits } from "./ports/editing.ts";
import { notices } from "./ports/effects.ts";
import { sharedStructureCommands } from "./ports/shared-commands.ts";
import { ids } from "./ports/identity.ts";
import { focusMemory, rowDrag, sceneView } from "./editor-owners.ts";
import { stopDragScroll, updateDragScroll } from "./rows.ts";
import { breakUndoGroup } from "./undo.ts";

export function mountSceneHeaders(sharedNames?: BufferedInputPorts, sharedScenes?: SharedSceneCreation): {
  confirmMove: (rowId: string, dir: -1 | 1) => boolean; finish: () => boolean; dispose: () => void;
} {
  const life = createViewLifetime(window), made: (() => void)[] = [() => { life.dispose(); }];
  try { return mountedSceneHeaders(life, made, sharedNames, sharedScenes); } catch (error) {
    for (const undo of made.reverse()) undo();
    throw error;
  }
}

function mountedSceneHeaders(life: ReturnType<typeof createViewLifetime>, made: (() => void)[], sharedNames?: BufferedInputPorts,
  sharedScenes?: SharedSceneCreation): ReturnType<typeof mountSceneHeaders> {
  const controls = mountSceneControls(window, {
    document: documentReader, edits, scenes: sceneView(), focus: focusMemory(),
    drag: rowDrag(), ids, notices, scroll: updateDragScroll, stopScroll: stopDragScroll, structure: sharedStructureCommands,
    ...sharedNames ? { sharedNames } : {}, ...sharedScenes ? { sharedScenes } : {}
  }, life);
  made.push(controls.reset);
  const boundary = createSceneBoundaryRemoval({
    timers: {
      now: () => Date.now(),
      start: (run, ms) => window.setTimeout(run, ms),
      stop: timer => window.clearTimeout(timer as number)
    },
    hint: controls.hint,
    remove: (id, key) => {
      if (key.startsWith("Alt+")) { breakUndoGroup(); return; }
      const doc = documentReader.current();
      const group = doc && sceneGroups(doc).find(item => item.scene.id === id);
      const previous = doc && group && doc.rows[group.start - 1];
      if (doc && previous) sceneView().reveal(doc, previous.id);
      breakUndoGroup();
      edits.run(removeSceneCommand(id));
    }
  });
  made.push(boundary.dispose);
  let input: ReturnType<typeof mountSceneBoundary> | null = null, inputLife: ReturnType<typeof createViewLifetime> | null = null;
  function syncInput(): void {
    boundary.cancel();
    const scenes = documentReader.current()?.sections;
    if (Array.isArray(scenes) && scenes.length) {
      if (!input) { inputLife = createViewLifetime(window); input = mountSceneBoundary(window, { document: documentReader, boundary, allowed: edits.allowed }, inputLife); }
    } else { input?.dispose(); input = null; }
  }
  made.push(() => { input?.dispose(); inputLife?.dispose(); input = null; });
  syncInput();
  const offChange = documentReader.onChange(syncInput);
  made.push(offChange);
  const offReplaced = documentReader.onReplaced(() => { syncInput(); controls.reset(); });
  function confirmMove(rowId: string, dir: -1 | 1): boolean {
    const doc = documentReader.current();
    const scene = doc && edits.allowed() ? soleBeatSceneMovedBy(doc, rowId, dir) : undefined;
    if (!scene) { boundary.cancel(); return false; }
    return !boundary.press(scene.id, dir < 0 ? "Alt+ArrowUp" : "Alt+ArrowDown");
  }
  return { confirmMove, finish: controls.finish, dispose() { offChange(); offReplaced(); input?.dispose(); boundary.dispose(); controls.dispose(); } };
}
