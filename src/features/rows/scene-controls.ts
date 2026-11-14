import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { SceneView } from "../../application/editing/scene-view.ts";
import type { FocusMemory } from "../../application/editing/focus-memory.ts";
import type { RowDrag } from "../../application/editing/row-drag.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { IdSource } from "../../core/document/ports.ts";
import { addSceneCommand, moveSceneCommand, removeSceneCommand, renameSceneCommand } from "../../application/commands/scenes.ts";
import { moveBeatCommand } from "../../application/commands/rows.ts";
import { sceneBeforeBeat, sceneFirstBeatId, sceneForBeat, sceneGroups, storedSceneName } from "../../core/document/scenes.ts";
import { cssAttr } from "../common/dom.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";
import { NOT_SHARED } from "../../application/session/shared-session.ts";
import { closeRowMenus } from "./row-menu.ts";
import { bindBufferedInput } from "../common/buffered-input.ts";
import type { BufferedInput, BufferedInputPorts } from "../common/buffered-input.ts";
import { headingFieldKey, unsettledHeading } from "../../application/editing/buffered-field-key.ts";
import { headingPos } from "../../core/flow/flow.ts";

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
  readonly sharedNames?: BufferedInputPorts;
}

export function mountSceneControls(window: Window, ports: SceneControlsPorts): {
  readonly hint: (id: string | null, text: string) => void;
  readonly reset: () => void;
  readonly dispose: () => void;
} {
  const doc = window.document, life = createViewLifetime(window);
  let dragging: string | null = null;
  let naming: {
    readonly sceneId: string | null;
    readonly beatId: string;
    readonly line: HTMLFormElement;
    readonly returnTo: HTMLElement | null;
    readonly settle: (focus: boolean) => void;
    readonly bound: BufferedInput | null;
  } | null = null;
  let pointerAway = false;
  const animations = new Map<HTMLElement, Animation>();
  function header(id: string): HTMLElement | null {
    const selector = '.section-header[data-section-id="' + cssAttr(id) + '"]';
    return doc.querySelector('#writer:not([hidden]) ' + selector) ?? doc.querySelector(selector);
  }
  function clearDrop(): void {
    doc.querySelectorAll(".section-drop-before,.section-drop-after").forEach(el => el.classList.remove("section-drop-before", "section-drop-after"));
  }
  function finishDrag(): void { dragging = null; clearDrop(); ports.stopScroll(); }
  function liveName(): boolean {
    if (!naming?.line.isConnected || !doc.getElementById("rows")?.contains(naming.line)) return false;
    const state = ports.document.current();
    if (!state) return false;
    if (naming.sceneId !== null) return sceneGroups(state).some(group => group.scene.id === naming?.sceneId)
      && !!header(naming.sceneId)?.contains(naming.line);
    if (!state.rows.some(row => row.id === naming?.beatId)) return false;
    const automatic = naming.line.closest(".section-header");
    return automatic ? automatic === header("") && state.rows[0]?.id === naming.beatId
      : naming.line.nextElementSibling?.getAttribute("data-id") === naming.beatId;
  }
  function animateName(line: HTMLElement, closing: boolean, removed: () => void = () => {}): void {
    const height = line.getBoundingClientRect().height;
    const margin = window.getComputedStyle(line).marginTop;
    animations.get(line)?.cancel();
    animations.delete(line);
    if (!line.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      if (closing) { line.remove(); removed(); }
      return;
    }
    const animation = line.animate([
      { height: closing ? height + "px" : "0px", marginTop: closing ? margin : "0px", opacity: closing ? 1 : 0 },
      { height: closing ? "0px" : height + "px", marginTop: closing ? "0px" : margin, opacity: closing ? 0 : 1 }
    ], { duration: 150, easing: "ease-in-out" });
    animations.set(line, animation);
    animation.onfinish = () => {
      animations.delete(line);
      if (closing) { line.remove(); removed(); }
    };
  }
  function cancelName(motion = false, restoreFocus = true): void {
    if (naming?.bound && !naming.bound.dispose()) return;
    const line = naming?.line, sceneId = naming?.bound ? naming.sceneId : null;
    const returnTo = sceneId !== null && sceneId !== undefined && !naming?.returnTo?.isConnected
      ? header(sceneId)?.querySelector<HTMLElement>(".section-name") : naming?.returnTo;
    naming = null;
    const restore = (): void => {
      if (restoreFocus && !naming && returnTo?.isConnected &&
        (doc.activeElement === doc.body || !!line?.contains(doc.activeElement))) returnTo.focus();
    };
    if (line) {
      line.inert = true;
      if (motion) animateName(line, true, restore);
      else { animations.get(line)?.cancel(); animations.delete(line); line.remove(); }
    }
    if (restoreFocus && returnTo?.isConnected && !motion) returnTo.focus();
  }
  function nameAt(parent: Element, sceneId: string | null, beatId: string, value: string, save: (name: string, focus: boolean) => void,
    shared?: BufferedInputPorts): void {
    if (!parent.isConnected) return;
    cancelName();
    if (naming) return;
    const returnTo = doc.activeElement as HTMLElement | null;
    const made = doc.createElement("form");
    made.className = "section-rename";
    const input = doc.createElement("input");
    input.type = "text"; input.value = value;
    // why: a shared name refuses its 201st character in the binding; native truncation would drop that input event
    if (!shared) input.maxLength = 200;
    input.setAttribute("aria-label", "Scene name");
    made.append(input);
    function settle(focus: boolean): void {
      if (naming?.line !== made) return;
      if (!liveName()) { cancelName(false, false); return; }
      if (bound) {
        if (!bound.finish()) return;
        cancelName(false, false);
        if (focus && sceneId !== null) header(sceneId)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
        return;
      }
      if (!input.value.trim()) { if (!focus) cancelName(true, false); return; }
      if (!ports.edits.allowed()) return;
      const name = input.value;
      cancelName(false, false);
      save(name, focus);
    }
    made.addEventListener("submit", event => {
      event.preventDefault();
      settle(true);
    });
    // why: Removing the focused line blurs before detaching it; only a real focus transfer may save here.
    input.addEventListener("blur", event => { if (!pointerAway && event.relatedTarget) settle(false); });
    made.addEventListener("keydown", event => {
      if (naming?.line !== made || event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelName(true); }
    });
    const heading = parent.matches(".section-header") ? parent.querySelector('[role="heading"]') : null;
    if (heading) heading.append(made); else parent.before(made);
    const place = (): void => {
      const at = sceneId !== null ? header(sceneId)?.querySelector('[role="heading"]') : null;
      if (at && !at.contains(made)) at.append(made);
    };
    const name = (): string | null => {
      const state = ports.document.current();
      return state && sceneId !== null ? storedSceneName(state, sceneId) : null;
    };
    const bound = shared && sceneId !== null ? bindBufferedInput({
      inputs: [input], key: headingFieldKey(sceneId), stored: name, unsettled: unsettledHeading, place, pasteLimit: 200,
      position: offset => headingPos(sceneId, offset), owns: pos => pos.kind === "heading" && pos.sceneId === sceneId
    }, shared) : null;
    naming = { sceneId, beatId, line: made, returnTo, settle, bound };
    animateName(made, false);
    input.focus(); input.select();
  }
  function rename(id: string, parent: Element): void {
    const state = ports.document.current();
    const scene = state && sceneGroups(state).find(group => group.scene.id === id)?.scene;
    if (!scene) return;
    const value = ports.sharedNames && state ? storedSceneName(state, id) ?? scene.name : scene.name;
    nameAt(parent, id, sceneFirstBeatId(scene), value, (name, focus) => {
      ports.edits.run(renameSceneCommand(id, name));
      if (focus) header(id)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
    }, ports.sharedNames);
  }
  function newScene(): boolean {
    if (!ports.sharedNames) return true;
    ports.sharedNames.report({ kind: "rejected", reason: NOT_SHARED });
    return false;
  }
  function reset(): void {
    cancelName();
    for (const [line, animation] of animations) { animation.cancel(); line.remove(); }
    animations.clear(); finishDrag();
    pointerAway = false;
  }
  const Observer = doc.defaultView?.MutationObserver;
  const rows = doc.getElementById("rows");
  if (Observer && rows) {
    const observer = new Observer(() => { if (naming && !liveName()) cancelName(false, false); });
    observer.observe(rows, { childList: true, subtree: true });
    life.release(() => observer.disconnect());
  }
  life.listen(doc, "pointerdown", event => {
    pointerAway = !!naming && !naming.line.contains(event.target);
  }, true);
  life.listen(doc, "pointercancel", () => { pointerAway = false; naming?.settle(false); });
  life.listen(window, "blur", () => { pointerAway = false; naming?.settle(false); });
  life.listen(doc, "click", event => {
    const target = event.target;
    const clickedHeader = target.closest<HTMLElement>(".section-header");
    const clickedId = clickedHeader?.getAttribute("data-section-id");
    const summary = target.closest<HTMLElement>(".section-more > summary");
    const openMenu = summary ? !summary.closest<HTMLDetailsElement>("details")?.open : false;
    pointerAway = false;
    if (naming && !naming.line.contains(target)) naming.settle(false);
    const liveHeader = clickedId !== undefined && clickedId !== null ? header(clickedId) : null;
    if (summary && clickedHeader !== liveHeader) {
      event.preventDefault();
      const menu = liveHeader?.querySelector<HTMLDetailsElement>(".section-more");
      if (menu) { menu.open = openMenu; menu.querySelector<HTMLElement>("summary")?.focus(); }
      return;
    }
    const beat = target.closest(".row[data-id]");
    if (beat) ports.focus.focusedRow(beat.getAttribute("data-id") ?? "");
    const add = target.closest('[data-action="add-section"]');
    const action = target.closest("[data-section-action]")?.getAttribute("data-section-action");
    const button = add ?? (action && liveHeader?.querySelector<HTMLElement>('[data-section-action="' + cssAttr(action) + '"]'));
    if (!button) {
      if (!target.closest(".section-more")) doc.querySelectorAll<HTMLDetailsElement>(".section-more[open]").forEach(menu => { menu.open = false; });
      return;
    }
    const state = ports.document.current();
    if (!state) return;
    const divider = liveHeader;
    const id = divider?.getAttribute("data-section-id");
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
      if (!newScene()) return;
      nameAt(beat ?? add.parentElement ?? add, null, row.id, "", (name, focus) => {
        const created = ports.ids.id("section");
        ports.edits.run(addSceneCommand(row.id, created, name));
        if (focus) header(created)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
      });
      return;
    }
    if (action === "name-automatic" && divider) {
      const automatic = ports.document.numbering().scenes.find(scene => scene.id === null);
      const first = automatic && state.rows[automatic.start];
      if (!first || !newScene()) return;
      nameAt(divider, null, first.id, "", (name, focus) => {
        const created = ports.ids.id("section");
        ports.edits.run(addSceneCommand(first.id, created, name));
        if (focus) header(created)?.querySelector<HTMLButtonElement>(".section-name")?.focus();
      });
      return;
    }
    if (!id || !divider) return;
    divider.querySelector<HTMLDetailsElement>("details")?.removeAttribute("open");
    if (action === "rename") {
      divider.querySelector<HTMLElement>(".section-name")?.focus();
      rename(id, divider);
    }
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
    reset,
    dispose() { life.dispose(); reset(); }
  };
}
