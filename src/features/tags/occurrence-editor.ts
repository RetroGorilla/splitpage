import { domToPos } from "../common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../common/cell-selection.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";

export function createTagOccurrenceEditor(choose: (cell: HTMLElement) => void, settle: () => void, prepare: () => void = () => {}) {
  const life = createViewLifetime(window);
  const button = document.createElement("button");
  button.type = "button";
  button.id = "tag-edit-action";
  button.className = "tag-suggest tag-edit-action";
  button.hidden = true;
  document.body.append(button);
  let selected: HTMLElement | null = null;
  let editing: { cell: HTMLElement; tag: HTMLElement } | null = null;

  function cellOf(tag: Element): HTMLElement | null {
    const cell = tag.closest<HTMLElement>("#rows .cell-editable, .wr-flow-visual-text");
    return cell?.getAttribute("contenteditable") === "true" ? cell : null;
  }

  function refresh(): void {
    if (editing && (!editing.cell.isConnected || !editing.tag.isConnected)) finish();
    const tag = editing?.tag ?? selected;
    if (!tag?.isConnected || !cellOf(tag) || !tag.getClientRects().length) {
      if (!button.hidden) button.hidden = true;
      return;
    }
    button.textContent = editing ? "Done" : "Edit tag";
    button.hidden = false;
    button.classList.add("is-visible");
    const rect = tag.getBoundingClientRect();
    button.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - button.offsetWidth - 8)) + "px";
    button.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - button.offsetHeight - 8)) + "px";
  }

  function finish(): boolean {
    if (!editing) return false;
    const current = editing;
    settle();
    editing = null;
    current.tag.removeAttribute("data-tag-editing");
    current.tag.setAttribute("contenteditable", "false");
    selected = null;
    button.hidden = true;
    return true;
  }

  function activate(): void {
    if (editing) { finish(); return; }
    const tag = selected;
    const cell = tag && cellOf(tag);
    if (!tag?.isConnected || !cell) return;
    prepare();
    editing = { cell, tag };
    tag.setAttribute("data-tag-editing", "");
    tag.setAttribute("contenteditable", "true");
    cell.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(tag);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    refresh();
  }

  life.listen(document, "mousedown", event => {
    if (event.target.closest("#tag-edit-action, .wr-flow-visual-tag")) { event.preventDefault(); return; }
    const tag = event.target.closest<HTMLElement>(".tag-anchor");
    if (tag && cellOf(tag)) {
      if (editing?.tag.contains(tag)) { event.stopPropagation(); return; }
      finish();
      selected = tag;
      event.preventDefault();
      const cell = cellOf(tag);
      cell?.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNode(tag);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      refresh();
      return;
    }
    if (!event.target.closest(".mini-toolbar, #tag-open-hint, #tag-ghost") &&
      !editing?.cell.contains(event.target)) { finish(); selected = null; refresh(); }
  }, true);
  life.listen(document, "click", event => {
    if (event.target.closest("#tag-edit-action")) { event.preventDefault(); activate(); }
    if (event.target.closest(".wr-flow-visual-tag")) {
      const cell = event.target.closest(".wr-flow-visual-box")?.querySelector<HTMLElement>(".wr-flow-visual-text");
      if (cell) choose(cell);
    }
  });
  life.listen(document, "selectionchange", () => {
    if (editing) { refresh(); return; }
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      const node = range.startContainer;
      const element = node.nodeType === 1 ? node as Element : node.parentElement;
      const child = node.childNodes[range.startOffset];
      const tag = child?.nodeType === 1 && (child as HTMLElement).matches(".tag-anchor") ? child as HTMLElement : element?.closest<HTMLElement>(".tag-anchor");
      selected = tag && cellOf(tag) ? tag : null;
    } else selected = null;
    refresh();
  });

  return {
    finish,
    refresh,
    beforeWrite(cell: Element): (() => void) | null {
      const saved = editing;
      if (!saved || saved.cell !== cell || !saved.tag.isConnected) return null;
      const from = domToPos(cell, saved.tag, 0);
      const cat = saved.tag.getAttribute("data-tag-cat"), name = saved.tag.getAttribute("data-tag-name");
      return () => {
        if (editing !== saved) return;
        const selection = cellSelection(cell);
        const tag = Array.from(cell.querySelectorAll<HTMLElement>(".tag-anchor")).find(candidate =>
          candidate.getAttribute("data-tag-cat") === cat && candidate.getAttribute("data-tag-name") === name &&
          domToPos(cell, candidate, 0) === from);
        if (!tag) { editing = null; selected = null; refresh(); return; }
        saved.tag = tag;
        tag.setAttribute("data-tag-editing", "");
        tag.setAttribute("contenteditable", "true");
        if (selection) setCellSelection(cell, selection.from, selection.to);
        refresh();
      };
    },
    dispose(): void {
      if (editing) {
        editing.tag.removeAttribute("data-tag-editing");
        editing.tag.setAttribute("contenteditable", "false");
      }
      editing = null;
      selected = null;
      life.dispose();
      button.remove();
    }
  };
}
