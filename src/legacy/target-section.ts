export interface TargetSectionHandlers {
  readonly html: () => string;
  readonly wire: (wrap: Element, close: () => void) => void;
}

let handlers: TargetSectionHandlers | null = null;

export function handTargetSectionTo(next: TargetSectionHandlers): void {
  handlers = next;
}

export function targetSectionHtml(): string {
  return handlers ? handlers.html() : "";
}

export function wireTargetSection(wrap: Element, close: () => void): void {
  handlers?.wire(wrap, close);
}
