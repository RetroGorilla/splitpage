import { posToDom } from "../common/cell-dom.ts";

export interface FlowBeatMenuActions {
  readonly canJoin: (rowId: string) => { readonly back: boolean; readonly next: boolean };
  readonly joinBack: (rowId: string) => void;
  readonly joinNext: (rowId: string) => void;
  readonly addVisual: (rowId: string) => void;
}

export function createFlowBeatMenu(root: HTMLElement, actions: FlowBeatMenuActions) {
  const doc = root.ownerDocument;
  const menu = doc.createElement("div");
  menu.className = "wr-flow-beat-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Beat");
  menu.hidden = true;
  let rowId: string | null = null;

  function item(action: string, label: string, title: string, run: (id: string) => void): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.action = action;
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", () => {
      const id = rowId;
      hide();
      if (id) run(id);
    });
    menu.append(button);
    return button;
  }

  const back = item("back", "Join Back", "Join with the previous beat (Alt+Backspace)", actions.joinBack);
  const next = item("next", "Join Next", "Join with the next beat", actions.joinNext);
  item("visual", "Add Visual", "Edit this beat's visual", actions.addVisual);
  root.parentElement?.appendChild(menu);

  function hide(): void {
    menu.hidden = true;
    rowId = null;
  }

  function outside(event: Event): void {
    if (!(event.target instanceof Node) || !menu.contains(event.target)) hide();
  }

  function keepSelection(event: Event): void { event.preventDefault(); }

  // why: Escape would otherwise close the whole writer behind the menu
  function escape(event: KeyboardEvent): void {
    if (menu.hidden || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    hide();
  }

  menu.addEventListener("mousedown", keepSelection);
  doc.addEventListener("mousedown", outside, true);
  doc.addEventListener("keydown", escape, true);
  root.parentElement?.addEventListener("scroll", hide);

  return {
    openAtTick(event: MouseEvent): boolean {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
      const target = event.target;
      const beat = target instanceof Element ? target.closest<HTMLElement>(".wr-beat") : null;
      if (!beat || !root.contains(beat)) return false;
      const rect = beat.getClientRects()[0];
      const point = posToDom(beat, 0);
      const caret = doc.createRange();
      caret.setStart(point.node, point.offset);
      caret.collapse(true);
      const edge = caret.getBoundingClientRect();
      if (!rect || event.clientY < rect.top || event.clientY > rect.bottom || event.clientX < rect.left || event.clientX >= edge.left) return false;
      event.preventDefault();
      rowId = beat.dataset.id ?? null;
      const can = actions.canJoin(rowId ?? "");
      back.disabled = !can.back;
      next.disabled = !can.next;
      menu.hidden = false;
      menu.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - menu.offsetWidth)) + "px";
      const below = rect.bottom + menu.offsetHeight <= window.innerHeight;
      menu.style.top = Math.max(0, below ? rect.bottom : rect.top - menu.offsetHeight) + "px";
      return true;
    },
    hide,
    dispose(): void {
      menu.removeEventListener("mousedown", keepSelection);
      doc.removeEventListener("mousedown", outside, true);
      doc.removeEventListener("keydown", escape, true);
      root.parentElement?.removeEventListener("scroll", hide);
      menu.remove();
    }
  };
}
