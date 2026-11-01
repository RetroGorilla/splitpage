import { cssDurationMs } from "../common/css-duration.ts";

export function rowMotionKey(el: Partial<Element> | null | undefined) {
  if (!el || !el.classList) return null;
  if (el.classList.contains("row")) return "row:" + (el as Element).getAttribute("data-id");
  if (el.classList.contains("section-header")) return "section:" + (el as Element).getAttribute("data-section-id");
  if (el.classList.contains("hidden-shot-strip")) return "strip:" + (el as Element).getAttribute("data-ids");
  return null;
}

interface RowMotionRect { top: number; left: number; width: number; height: number }
interface RowMotionMeasurement {
 keys: string[];
 rect: Record<string, RowMotionRect>;
 node: Record<string, Element>;
}
interface RowMotionMove { node: Element; dy: number }

const ROW_MOTION_MAX_ROWS = 200;
const ROW_MOTION_MAX_ENTER = 4;
const ROW_MOTION_MAX_EXIT = 12;

function rowMotionEnabled() {
  try {
    if (typeof Element === "undefined" || !Element.prototype.animate) return false;
    if (document.hidden) return false;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  } catch (e) { return false; }
  return true;
}

function measureRowMotion(rowsEl: Element) {
  const out: RowMotionMeasurement = { keys: [], rect: Object.create(null), node: Object.create(null) };
  const kids = rowsEl.children;
  const sx = window.scrollX || window.pageXOffset || 0;
  const sy = window.scrollY || window.pageYOffset || 0;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i] as Element;
    const key = rowMotionKey(el);
    if (!key || out.rect[key]) continue;
    const r = el.getBoundingClientRect();
    out.keys.push(key);
    out.rect[key] = { top: r.top + sy, left: r.left + sx, width: r.width, height: r.height };
    out.node[key] = el;
  }
  return out;
}

export function withRowMotion(rowsEl: Element | null, paint: () => void) {
  if (!rowsEl || !rowMotionEnabled() || rowsEl.children.length > ROW_MOTION_MAX_ROWS) {
    paint();
    return;
  }

  let before;
  try { before = measureRowMotion(rowsEl); } catch (e) { paint(); return; }

  paint();

  try {
    if (rowsEl.children.length > ROW_MOTION_MAX_ROWS) return;
    const after = measureRowMotion(rowsEl);

    const moveMs = cssDurationMs(window, "--dur-move", 180);
    const enterMs = cssDurationMs(window, "--dur-enter", 180);
    const easeStandard = "cubic-bezier(0.2, 0, 0, 1)";
    const easeEnter = "cubic-bezier(0.05, 0.7, 0.1, 1)";

    const moved: RowMotionMove[] = [];
    const entered: Element[] = [];
    const exited: string[] = [];
    let k: string, i: number;

    for (i = 0; i < after.keys.length; i++) {
      k = after.keys[i] as string;
      if (before.rect[k]) {
        const dy = (before.rect[k] as RowMotionRect).top - (after.rect[k] as RowMotionRect).top;
        if (Math.abs(dy) >= 1) moved.push({ node: after.node[k] as Element, dy: dy });
      } else {
        entered.push(after.node[k] as Element);
      }
    }
    for (i = 0; i < before.keys.length; i++) {
      k = before.keys[i] as string;
      if (!after.rect[k]) exited.push(k);
    }

    if (!moved.length && !entered.length && !exited.length) return;

    const bulk = !before.keys.length || !after.keys.length ||
      entered.length > ROW_MOTION_MAX_ENTER || exited.length > ROW_MOTION_MAX_EXIT;

    for (i = 0; i < moved.length; i++) {
      (moved[i] as RowMotionMove).node.animate(
        [{ transform: "translateY(" + (moved[i] as RowMotionMove).dy + "px)" }, { transform: "translateY(0)" }],
        { duration: moveMs, easing: easeStandard }
      );
    }

    if (!bulk) {
      for (i = 0; i < entered.length; i++) {
        (entered[i] as Element).animate(
          [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "translateY(0)" }],
          { duration: enterMs, easing: easeEnter }
        );
      }
    }
  } catch (e) {
  }
}
