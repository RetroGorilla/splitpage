export const RUNDOWN_CLICK_SCROLL_MS = 200;

export function animateRundownClick(row: Element, view: Window): () => void {
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
  let expectedX = view.scrollX, expectedY = view.scrollY;
  function cancel(): void {
    if (!active) return;
    active = false;
    view.cancelAnimationFrame(frame);
    for (const event of interrupts) view.removeEventListener(event, cancel, true);
    view.removeEventListener("scroll", scrolled, true);
  }
  function moved(): boolean {
    return view.scrollX !== expectedX || view.scrollY !== expectedY;
  }
  function scrolled(): void {
    if (moved()) cancel();
  }
  function tick(now: number): void {
    if (!active) return;
    if (!row.isConnected || moved()) { cancel(); return; }
    const progress = Math.min(1, Math.max(0, (now - started) / RUNDOWN_CLICK_SCROLL_MS));
    const eased = 1 - (1 - progress) ** 3;
    view.scrollTo({ left: fromX + (toX - fromX) * eased, top: fromY + (toY - fromY) * eased, behavior: "instant" });
    expectedX = view.scrollX;
    expectedY = view.scrollY;
    if (progress === 1) cancel();
    else frame = view.requestAnimationFrame(tick);
  }
  for (const event of interrupts) view.addEventListener(event, cancel, { capture: true, passive: true });
  view.addEventListener("scroll", scrolled, { capture: true, passive: true });
  frame = view.requestAnimationFrame(tick);
  return cancel;
}
