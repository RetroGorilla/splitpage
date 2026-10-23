export function caretTextOffset(el: Element): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return 0;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length;
}

export function placeCaretAtTextOffset(el: Element, offset: number): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let node: Node | null;
  let seen = 0, target: Node | null = null, targetOffset = 0;
  while ((node = walker.nextNode())) {
    const len = (node.nodeValue as string).length;
    if (seen + len >= offset) { target = node; targetOffset = offset - seen; break; }
    seen += len;
  }
  const range = document.createRange();
  const parent = target ? target.parentNode as Element | null : null;
  const atomic = parent && parent.closest ? parent.closest(".tag-anchor") : null;
  if (target && atomic) {
    if (targetOffset <= 0 && target === atomic.firstChild) {
      range.setStartBefore(atomic);
    } else {
      range.setStartAfter(atomic);
    }
  } else if (target) {
    range.setStart(target, Math.min(targetOffset, (target.nodeValue as string).length));
  } else {
    range.selectNodeContents(el);
  }
  range.collapse(true);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
}
