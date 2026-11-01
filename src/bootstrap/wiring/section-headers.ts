import { createSectionBoundaryRemoval } from "../../application/editing/section-boundary.ts";
import { removeSectionCommand } from "../../application/commands/sections.ts";
import { sectionGroups } from "../../core/document/sections.ts";
import { mountSectionBoundary } from "../../features/editing/section-boundary.ts";
import { mountSectionControls } from "../../features/rows/section-controls.ts";
import { documentReader } from "./ports/document.ts";
import { edits } from "./ports/editing.ts";
import { notices } from "./ports/effects.ts";
import { ids } from "./ports/identity.ts";
import { focusMemory, rowDrag, sectionView } from "./editor-owners.ts";
import { stopDragScroll, updateDragScroll } from "./rows.ts";
import { undoOwner } from "./undo.ts";

export function mountSectionHeaders(): { dispose: () => void } {
  const controls = mountSectionControls(window, {
    document: documentReader, edits, sections: sectionView(), focus: focusMemory(),
    drag: rowDrag(), ids, notices, scroll: updateDragScroll, stopScroll: stopDragScroll
  });
  const boundary = createSectionBoundaryRemoval({
    timers: {
      now: () => Date.now(),
      start: (run, ms) => window.setTimeout(run, ms),
      stop: timer => window.clearTimeout(timer as number)
    },
    hint: controls.hint,
    remove: (id, key) => {
      if (key.startsWith("Alt+")) { undoOwner().breakCoalescing(); return; }
      const doc = documentReader.current();
      const group = doc && sectionGroups(doc).find(item => item.section.id === id);
      const previous = doc && group && doc.rows[group.start - 1];
      if (doc && previous) sectionView().reveal(doc, previous.id);
      undoOwner().breakCoalescing();
      edits.run(removeSectionCommand(id));
    }
  });
  let input: ReturnType<typeof mountSectionBoundary> | null = null;
  function syncInput(): void {
    boundary.cancel();
    const sections = documentReader.current()?.sections;
    if (Array.isArray(sections) && sections.length) {
      input ??= mountSectionBoundary(window, { document: documentReader, boundary, allowed: edits.allowed });
    } else { input?.dispose(); input = null; }
  }
  syncInput();
  const offChange = documentReader.onChange(syncInput);
  const offReplaced = documentReader.onReplaced(() => { syncInput(); controls.reset(); });
  return { dispose() { offChange(); offReplaced(); input?.dispose(); boundary.dispose(); controls.dispose(); } };
}
