import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { SectionView } from "../../application/editing/section-view.ts";
import type { FocusMemory } from "../../application/editing/focus-memory.ts";
import type { RowDrag } from "../../application/editing/row-drag.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { IdSource } from "../../core/document/ports.ts";
import { addSectionCommand, moveSectionCommand, removeSectionCommand, renameSectionCommand } from "../../application/commands/sections.ts";
import { moveSceneCommand } from "../../application/commands/rows.ts";
import { sectionBeforeScene, sectionForScene, sectionGroups } from "../../core/document/sections.ts";
import { cssAttr } from "../common/dom.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";

export interface SectionControlsPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly edits: Pick<DocumentEdits, "allowed" | "run">;
  readonly sections: SectionView;
  readonly focus: Pick<FocusMemory<Element>, "lastRow" | "focusedRow">;
  readonly drag: Pick<RowDrag, "dragging" | "end">;
  readonly ids: Pick<IdSource, "id">;
  readonly notices: Pick<NoticePort, "show">;
  readonly scroll: (x: number, y: number) => void;
  readonly stopScroll: () => void;
}

export function mountSectionControls(window: Window, ports: SectionControlsPorts): {
  readonly hint: (id: string | null, text: string) => void;
  readonly reset: () => void;
  readonly dispose: () => void;
} {
  const doc = window.document, life = createViewLifetime(window);
  let dragging: string | null = null;
  let form: HTMLFormElement | null = null;
  let renameReturn: HTMLElement | null = null;
  function header(id: string): HTMLElement | null {
    const selector = '.section-header[data-section-id="' + cssAttr(id) + '"]';
    return doc.querySelector('#writer:not([hidden]) ' + selector) ?? doc.querySelector(selector);
  }
  function clearDrop(): void {
    doc.querySelectorAll(".section-drop-before,.section-drop-after").forEach(el => el.classList.remove("section-drop-before", "section-drop-after"));
  }
  function finishDrag(): void { dragging = null; clearDrop(); ports.stopScroll(); }
  function cancelName(): void {
    form?.remove(); form = null;
    if (renameReturn?.isConnected) renameReturn.focus();
    renameReturn = null;
  }
  function nameAt(parent: Element, value: string, save: (name: string) => void): void {
    cancelName();
    renameReturn = doc.activeElement as HTMLElement | null;
    const made = doc.createElement("form");
    made.className = "section-rename";
    const input = doc.createElement("input");
    input.type = "text"; input.maxLength = 200; input.required = true; input.value = value;
    input.setAttribute("aria-label", "Section name");
    const submit = doc.createElement("button"), cancel = doc.createElement("button");
    submit.type = "submit"; submit.textContent = "Save";
    cancel.type = "button"; cancel.textContent = "Cancel";
    made.append(input, submit, cancel);
    made.addEventListener("submit", event => {
      event.preventDefault();
      if (!input.value.trim() || !ports.edits.allowed()) return;
      const name = input.value;
      cancelName();
      save(name);
    });
    cancel.addEventListener("click", cancelName);
    made.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelName(); }
    });
    parent.appendChild(made);
    form = made;
    input.focus(); input.select();
  }
  function rename(id: string, parent: Element): void {
    const state = ports.document.current();
    const section = state && sectionGroups(state).find(group => group.section.id === id)?.section;
    if (!section) return;
    nameAt(parent, section.name, name => {
      ports.edits.run(renameSectionCommand(id, name));
      header(id)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
    });
  }
  life.listen(doc, "click", event => {
    const target = event.target;
    const scene = target.closest(".row[data-id]");
    if (scene) ports.focus.focusedRow(scene.getAttribute("data-id") ?? "");
    const add = target.closest('[data-section-action="add"]');
    const button = target.closest("[data-section-action]");
    if (!button) {
      if (!target.closest(".section-more")) doc.querySelectorAll<HTMLDetailsElement>(".section-more[open]").forEach(menu => { menu.open = false; });
      return;
    }
    const state = ports.document.current();
    if (!state) return;
    const divider = button.closest<HTMLElement>(".section-header");
    const id = divider?.getAttribute("data-section-id");
    const action = button.getAttribute("data-section-action");
    if (action === "fold" && id) {
      ports.sections.toggle(id);
      header(id)?.querySelector<HTMLButtonElement>(".section-fold")?.focus();
      return;
    }
    if (!ports.edits.allowed()) return;
    if (add) {
      const row = state.rows.find(item => item.id === ports.focus.lastRow()) ?? state.rows[0];
      if (!row) { ports.notices.show("Add a scene before creating a section.", "warn"); return; }
      const existing = sectionBeforeScene(state, row.id);
      if (existing) { const parent = header(existing.id); if (parent) rename(existing.id, parent); return; }
      nameAt(add.parentElement ?? add, "", name => {
        const created = ports.ids.id("section");
        ports.edits.run(addSectionCommand(row.id, created, name));
        header(created)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
      });
      return;
    }
    if (!id || !divider) return;
    divider.querySelector<HTMLDetailsElement>("details")?.removeAttribute("open");
    if (action === "rename") rename(id, divider);
    else if (action === "remove") ports.edits.run(removeSectionCommand(id));
    else if (action === "up" || action === "down") {
      const groups = sectionGroups(state), index = groups.findIndex(group => group.section.id === id);
      const targetGroup = groups[index + (action === "up" ? -1 : 1)];
      if (targetGroup) ports.edits.run(moveSectionCommand(id, targetGroup.section.id, action === "down"));
      header(id)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
    }
  });
  function dropTarget(event: DragEvent): { id: string; after: boolean; firstSceneId: string; header: Element } | null {
    const target = event.target as Element | null, state = ports.document.current();
    if (!state || !Array.isArray(state.sections) || !state.sections.length || !target?.closest) return null;
    const divider = target.closest(".section-header"), row = target.closest(".row[data-id]");
    const id = divider?.getAttribute("data-section-id") ?? (row && sectionForScene(state, row.getAttribute("data-id") ?? "")?.id);
    const group = id && sectionGroups(state).find(item => item.section.id === id);
    const shown = id && header(id);
    if (!group || !shown) return null;
    const bounds = (divider ?? row ?? shown).getBoundingClientRect();
    return { id: group.section.id, firstSceneId: group.section.firstSceneId, after: event.clientY > bounds.top + bounds.height / 2, header: shown };
  }
  life.listen(doc, "dragstart", event => {
    const grip = event.target.closest(".section-grip");
    if (!grip) return;
    if (!ports.edits.allowed()) { event.preventDefault(); return; }
    dragging = grip.closest(".section-header")?.getAttribute("data-section-id") ?? null;
    const drag = event as unknown as DragEvent;
    if (drag.dataTransfer && dragging) {
      drag.dataTransfer.effectAllowed = "move";
      drag.dataTransfer.setData("application/x-splitpage-section", dragging);
    }
    event.stopImmediatePropagation();
  }, true);
  life.listen(doc, "dragover", event => {
    const drag = event as unknown as DragEvent;
    const target = dropTarget(drag);
    const sceneOverHeader = !!ports.drag.dragging() && !!event.target.closest(".section-header");
    if ((!dragging && !sceneOverHeader) || !target || !ports.edits.allowed()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    clearDrop();
    target.header.classList.add(dragging && target.after ? "section-drop-after" : "section-drop-before");
    ports.scroll(drag.clientX, drag.clientY);
  }, true);
  life.listen(doc, "drop", event => {
    const target = dropTarget(event as unknown as DragEvent), scene = ports.drag.dragging();
    if ((!dragging && !(scene && event.target.closest(".section-header"))) || !target || !ports.edits.allowed()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (dragging) ports.edits.run(moveSectionCommand(dragging, target.id, target.after));
    else if (scene) ports.edits.run(moveSceneCommand(scene, target.firstSceneId, false, target.id));
    ports.drag.end(); finishDrag();
  }, true);
  life.listen(doc, "dragend", finishDrag, true);
  return {
    hint(id, text) {
      doc.querySelectorAll<HTMLElement>(".section-hint").forEach(el => {
        const shown = !!id && el.closest(".section-header")?.getAttribute("data-section-id") === id;
        el.hidden = !shown; el.textContent = shown ? text : "";
      });
    },
    reset() { cancelName(); finishDrag(); },
    dispose() { life.dispose(); cancelName(); finishDrag(); }
  };
}
