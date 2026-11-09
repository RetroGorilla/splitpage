export interface PlainTagKeyTarget {
  readonly close: () => void;
  readonly cancel: () => void;
  readonly emptyAtCaret: () => boolean;
  readonly cancelOnBackspace: () => boolean;
  readonly dismissSuggestion: () => boolean;
}

export function plainTagKeydown(event: KeyboardEvent, tag: PlainTagKeyTarget, beforeCancel: () => void): boolean {
  if (event.key === "Tab") { event.preventDefault(); tag.close(); return true; }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (tag.dismissSuggestion()) return true;
    beforeCancel();
    tag.cancel();
    return true;
  }
  if (event.key === "Backspace" && tag.emptyAtCaret() && tag.cancelOnBackspace()) {
    event.preventDefault();
    return true;
  }
  return false;
}

export function acceptGhostOnTab(event: KeyboardEvent, ownsGhost: boolean, accept: () => boolean): boolean {
  if (event.key !== "Tab" || !ownsGhost || !accept()) return false;
  event.preventDefault();
  return true;
}

export function dismissesTagGhost(key: string): boolean {
  return ["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key);
}
