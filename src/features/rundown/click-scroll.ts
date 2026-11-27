import type { DocumentReader } from "../../application/session/document-reader.ts";

export const RUNDOWN_CLICK_SCROLL_MS = 200;

function hasMovingTransform(row: Element): boolean {
  for (let element: Element | null = row; element; element = element.parentElement) {
    const moving = element.getAnimations?.().some(animation => {
      if (!animation.pending && animation.playState !== "running") return false;
      const effect = animation.effect as KeyframeEffect | null;
      return effect && Number.isFinite(effect.getComputedTiming().endTime) &&
        effect.getKeyframes().some(frame => frame.transform !== undefined);
    });
    if (moving) return true;
  }
  return false;
}

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
  const interrupts = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown", "beforeinput"];
  let started: number | undefined;
  let settledFrames = 0;
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
    // why: A delayed first frame still needs to show the animation.
    started ??= now;
    const progress = Math.min(1, Math.max(0, (now - started) / RUNDOWN_CLICK_SCROLL_MS));
    const eased = 1 - (1 - progress) ** 3;
    if (progress === 1) {
      const left = view.scrollX, top = view.scrollY;
      row.scrollIntoView({ block: "center", behavior: "instant" });
      // why: The final scroll can queue a topbar layout change on the next frame.
      if (left !== view.scrollX || top !== view.scrollY || hasMovingTransform(row)) settledFrames = 0;
      else if (++settledFrames === 2) { cancel(); return; }
    } else {
      view.scrollTo({ left: fromX + (toX - fromX) * eased, top: fromY + (toY - fromY) * eased, behavior: "instant" });
    }
    frame = view.requestAnimationFrame(tick);
  }
  for (const event of interrupts) view.addEventListener(event, cancel, { capture: true, passive: true });
  frame = view.requestAnimationFrame(tick);
  return cancel;
}
