import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { SceneView } from "../../application/editing/scene-view.ts";
import type { FocusMemory } from "../../application/editing/focus-memory.ts";
import type { RowDrag } from "../../application/editing/row-drag.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { IdSource } from "../../core/document/ports.ts";
import { addSceneCommand, moveSceneCommand, removeSceneCommand, renameSceneCommand } from "../../application/commands/scenes.ts";
import { moveBeatCommand } from "../../application/commands/rows.ts";
import { sceneBeforeBeat, sceneFirstBeatId, sceneForBeat, sceneGroups } from "../../core/document/scenes.ts";
import { cssAttr } from "../common/dom.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";
import { closeRowMenus } from "./row-menu.ts";

export interface SceneControlsPorts {
  readonly document: Pick<DocumentReader, "current" | "numbering">;
  readonly edits: Pick<DocumentEdits, "allowed" | "run">;
  readonly scenes: SceneView;
  readonly focus: Pick<FocusMemory<Element>, "focusedRow">;
  readonly drag: Pick<RowDrag, "dragging" | "end">;
  readonly ids: Pick<IdSource, "id">;
  readonly notices: Pick<NoticePort, "show">;
  readonly scroll: (x: number, y: number) => void;
  readonly stopScroll: () => void;
}

export function mountSceneControls(window: Window, ports: SceneControlsPorts): {
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
    input.setAttribute("aria-label", "Scene name");
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
    const scene = state && sceneGroups(state).find(group => group.scene.id === id)?.scene;
    if (!scene) return;
    nameAt(parent, scene.name, name => {
      ports.edits.run(renameSceneCommand(id, name));
      header(id)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
    });
  }
  life.listen(doc, "click", event => {
    const target = event.target;
    const beat = target.closest(".row[data-id]");
    if (beat) ports.focus.focusedRow(beat.getAttribute("data-id") ?? "");
    const add = target.closest('[data-action="add-section"]');
    const button = add ?? target.closest("[data-section-action]");
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
      ports.scenes.toggle(id);
      header(id)?.querySelector<HTMLButtonElement>(".section-fold")?.focus();
      return;
    }
    if (!ports.edits.allowed()) return;
    if (add) {
      const row = state.rows.find(item => item.id === add.getAttribute("data-id"));
      if (!row) { ports.notices.show("Add a beat before creating a scene.", "warn"); return; }
      closeRowMenus();
      beat?.querySelector<HTMLElement>(".row-more")?.focus();
      const existing = sceneBeforeBeat(state, row.id);
      if (existing) { const parent = header(existing.id); if (parent) rename(existing.id, parent); return; }
      nameAt(beat ?? add.parentElement ?? add, "", name => {
        const created = ports.ids.id("section");
        ports.edits.run(addSceneCommand(row.id, created, name));
        header(created)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
      });
      return;
    }
    if (!id || !divider) return;
    divider.querySelector<HTMLDetailsElement>("details")?.removeAttribute("open");
    if (action === "rename") rename(id, divider);
    else if (action === "remove") ports.edits.run(removeSceneCommand(id));
    else if (action === "up" || action === "down") {
      const groups = sceneGroups(state), index = groups.findIndex(group => group.scene.id === id);
      const targetGroup = groups[index + (action === "up" ? -1 : 1)];
      if (targetGroup) ports.edits.run(moveSceneCommand(id, targetGroup.scene.id, action === "down"));
      header(id)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
    }
  });
  function dropTarget(event: DragEvent): { id: string; after: boolean; firstBeatId: string; header: Element } | null {
    const target = event.target as Element | null, state = ports.document.current();
    if (!state || !target?.closest) return null;
    const divider = target.closest(".section-header"), row = target.closest(".row[data-id]");
    if (divider?.getAttribute("data-section-id") === "") {
      const automatic = ports.document.numbering().scenes.find(scene => scene.id === null);
      const first = automatic && state.rows[automatic.start];
      return first && !dragging ? { id: "", firstBeatId: first.id, after: false, header: divider } : null;
    }
    const id = divider?.getAttribute("data-section-id") ?? (row && sceneForBeat(state, row.getAttribute("data-id") ?? "")?.id);
    const group = id && sceneGroups(state).find(item => item.scene.id === id);
    const shown = id && header(id);
    if (!group || !shown) return null;
    const bounds = (divider ?? row ?? shown).getBoundingClientRect();
    return { id: group.scene.id, firstBeatId: sceneFirstBeatId(group.scene), after: event.clientY > bounds.top + bounds.height / 2, header: shown };
  }
  life.listen(doc, "dragstart", event => {
    if (!(event.target instanceof Element)) return;
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
    const beatOverHeader = !!ports.drag.dragging() && !!event.target.closest(".section-header");
    if ((!dragging && !beatOverHeader) || !target || !ports.edits.allowed()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    clearDrop();
    target.header.classList.add(dragging && target.after ? "section-drop-after" : "section-drop-before");
    ports.scroll(drag.clientX, drag.clientY);
  }, true);
  life.listen(doc, "drop", event => {
    const target = dropTarget(event as unknown as DragEvent), beat = ports.drag.dragging();
    if ((!dragging && !(beat && event.target.closest(".section-header"))) || !target || !ports.edits.allowed()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (dragging) ports.edits.run(moveSceneCommand(dragging, target.id, target.after));
    else if (beat) ports.edits.run(moveBeatCommand(beat, target.firstBeatId, false, target.id));
    ports.drag.end(); finishDrag();
  }, true);
  life.listen(doc, "dragend", finishDrag, true);
  life.listen(doc, "keydown", event => {
    if (event.key !== "Escape") return;
    const menu = event.target.closest?.<HTMLDetailsElement>(".section-more[open]");
    if (!menu) return;
    event.preventDefault(); event.stopPropagation();
    menu.open = false;
    menu.querySelector<HTMLElement>("summary")?.focus();
  });
  return {
    hint(id, text) {
      const active = id ? header(id) : null;
      doc.querySelectorAll<HTMLElement>(".section-hint").forEach(el => {
        const shown = !!active && el.closest(".section-header") === active;
        el.hidden = !shown; el.textContent = shown ? text : "";
      });
      const live = doc.getElementById("section-hint-live");
      if (live) live.textContent = active ? text : "";
    },
    reset() { cancelName(); finishDrag(); },
    dispose() { life.dispose(); cancelName(); finishDrag(); }
  };
}
