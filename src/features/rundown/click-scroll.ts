import type { DocumentReader } from "../../application/session/document-reader.ts";

export const RUNDOWN_CLICK_SCROLL_MS = 200;

export function animateRundownClick(row: Element, view: Window, document: Pick<DocumentReader, "current">): () => void {
  const identity = document.current();
  if (view.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    row.scrollIntoView({ block: "center" });
    return () => {};
  }
  const fromX = view.scrollX, fromY = view.scrollY;
  // why: Measuring the browser's jump preserves its scroll margins and clamping, without painting the jump.
  row.scrollIntoView({ block: "center", behavior: "instant" });
  const toX = view.scrollX, toY = view.scrollY;
  view.scrollTo({ left: fromX, top: fromY, behavior: "instant" });
  const started = view.performance.now();
  const interrupts = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown", "beforeinput"];
  let frame = 0;
  let active = true;
  function cancel(): void {
    if (!active) return;
    active = false;
    view.cancelAnimationFrame(frame);
    for (const event of interrupts) view.removeEventListener(event, cancel, true);
  }
  function tick(now: number): void {
    if (!active) return;
    if (document.current() !== identity || !row.isConnected) { cancel(); return; }
    const progress = Math.min(1, Math.max(0, (now - started) / RUNDOWN_CLICK_SCROLL_MS));
    const eased = 1 - (1 - progress) ** 3;
    if (progress === 1) {
      // why: Focus and layout can shift the target during the animation; finish at the browser's current jump destination.
      row.scrollIntoView({ block: "center", behavior: "instant" });
      cancel();
    } else {
      view.scrollTo({ left: fromX + (toX - fromX) * eased, top: fromY + (toY - fromY) * eased, behavior: "instant" });
      frame = view.requestAnimationFrame(tick);
    }
  }
  for (const event of interrupts) view.addEventListener(event, cancel, { capture: true, passive: true });
  frame = view.requestAnimationFrame(tick);
  return cancel;
}
