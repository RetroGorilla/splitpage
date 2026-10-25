import type { TargetSection } from "../application/target-section.ts";

let handlers: TargetSection<Element> | null = null;

export function handTargetSectionTo(next: TargetSection<Element>): void {
  handlers = next;
}

export function targetSectionHtml(): string {
  return handlers ? handlers.html() : "";
}

export function wireTargetSection(wrap: Element, close: () => void): void {
  handlers?.wire(wrap, close);
}
