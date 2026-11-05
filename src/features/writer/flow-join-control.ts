import { posToDom } from "../common/cell-dom.ts";

export function createFlowJoinControl(root: HTMLElement, join: (rowId: string) => void) {
  const button = root.ownerDocument.createElement("button");
  button.type = "button";
  button.className = "wr-flow-join";
  button.textContent = "Join";
  button.title = "Join with the previous beat (Alt+Backspace)";
  button.hidden = true;
  root.parentElement?.appendChild(button);
  let rowId: string | null = null;

  function hide(): void {
    button.hidden = true;
    rowId = null;
  }

  function outside(event: Event): void {
    if (event.target !== button) hide();
  }

  function keepSelection(event: Event): void { event.preventDefault(); }

  function click(): void {
    const id = rowId;
    hide();
    if (id) join(id);
  }

  button.addEventListener("mousedown", keepSelection);
  button.addEventListener("click", click);
  root.ownerDocument.addEventListener("mousedown", outside, true);
  root.parentElement?.addEventListener("scroll", hide);

  return {
    openAtTick(event: MouseEvent): boolean {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
      const target = event.target;
      const beat = target instanceof Element ? target.closest<HTMLElement>(".wr-beat") : null;
      if (!beat || !root.contains(beat)) return false;
      const rect = beat.getClientRects()[0];
      const point = posToDom(beat, 0);
      const caret = root.ownerDocument.createRange();
      caret.setStart(point.node, point.offset);
      caret.collapse(true);
      const edge = caret.getBoundingClientRect();
      if (!rect || event.clientY < rect.top || event.clientY > rect.bottom || event.clientX < rect.left || event.clientX >= edge.left) return false;
      event.preventDefault();
      rowId = beat.dataset.id ?? null;
      button.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - 100)) + "px";
      button.style.top = rect.bottom + "px";
      button.hidden = false;
      return true;
    },
    hide,
    dispose(): void {
      button.removeEventListener("mousedown", keepSelection);
      button.removeEventListener("click", click);
      root.ownerDocument.removeEventListener("mousedown", outside, true);
      root.parentElement?.removeEventListener("scroll", hide);
      button.remove();
    }
  };
}
