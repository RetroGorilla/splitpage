// Strips keyed by covered ids so re-collapse is same strip
export function rowMotionKey(el) {
  if (!el || !el.classList) return null;
  if (el.classList.contains("row")) return "row:" + el.getAttribute("data-id");
  if (el.classList.contains("hidden-shot-strip")) return "strip:" + el.getAttribute("data-ids");
  return null;
}

// Beyond this render() behaves as before, no motion
var ROW_MOTION_MAX_ROWS = 200;
var ROW_MOTION_MAX_ENTER = 4;
var ROW_MOTION_MAX_EXIT = 12;

function rowMotionEnabled() {
  try {
    if (typeof Element === "undefined" || !Element.prototype.animate) return false;
    if (document.hidden) return false;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  } catch (e) { return false; }
  return true;
}

// Document space, not viewport; refocus scroll would look like moves
function measureRowMotion(rowsEl) {
  var out = { keys: [], rect: Object.create(null), node: Object.create(null) };
  var kids = rowsEl.children;
  var sx = window.scrollX || window.pageXOffset || 0;
  var sy = window.scrollY || window.pageYOffset || 0;
  for (var i = 0; i < kids.length; i++) {
    var el = kids[i];
    var key = rowMotionKey(el);
    if (!key || out.rect[key]) continue;
    var r = el.getBoundingClientRect();
    out.keys.push(key);
    out.rect[key] = { top: r.top + sy, left: r.left + sx, width: r.width, height: r.height };
    out.node[key] = el;
  }
  return out;
}

export function rowMotionMs(name, fallback) {
  try {
    var raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return fallback;
    var n = parseFloat(raw);
    if (!isFinite(n)) return fallback;
    return /ms$/.test(raw) ? n : n * 1000;
  } catch (e) { return fallback; }
}

// paint() runs exactly once; never skipped or deferred here
export function withRowMotion(rowsEl, paint) {
  if (!rowsEl || !rowMotionEnabled() || rowsEl.children.length > ROW_MOTION_MAX_ROWS) {
    paint();
    return;
  }

  var before;
  try { before = measureRowMotion(rowsEl); } catch (e) { paint(); return; }

  paint();

  try {
    if (rowsEl.children.length > ROW_MOTION_MAX_ROWS) return;
    var after = measureRowMotion(rowsEl);

    var moveMs = rowMotionMs("--dur-move", 180);
    var enterMs = rowMotionMs("--dur-enter", 180);
    var easeStandard = "cubic-bezier(0.2, 0, 0, 1)";
    var easeEnter = "cubic-bezier(0.05, 0.7, 0.1, 1)";

    var moved = [];
    var entered = [];
    var exited = [];
    var k, i;

    for (i = 0; i < after.keys.length; i++) {
      k = after.keys[i];
      if (before.rect[k]) {
        var dy = before.rect[k].top - after.rect[k].top;
        if (Math.abs(dy) >= 1) moved.push({ node: after.node[k], dy: dy });
      } else {
        entered.push(after.node[k]);
      }
    }
    for (i = 0; i < before.keys.length; i++) {
      k = before.keys[i];
      if (!after.rect[k]) exited.push(k);
    }

    if (!moved.length && !entered.length && !exited.length) return;

    // Replaced document is not a change; no animation
    var bulk = !before.keys.length || !after.keys.length ||
      entered.length > ROW_MOTION_MAX_ENTER || exited.length > ROW_MOTION_MAX_EXIT;

    for (i = 0; i < moved.length; i++) {
      moved[i].node.animate(
        [{ transform: "translateY(" + moved[i].dy + "px)" }, { transform: "translateY(0)" }],
        { duration: moveMs, easing: easeStandard }
      );
    }

    // No fade-out; the gap closing already shows deletions
    if (!bulk) {
      for (i = 0; i < entered.length; i++) {
        entered[i].animate(
          [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "translateY(0)" }],
          { duration: enterMs, easing: easeEnter }
        );
      }
    }
  } catch (e) {
  }
}

export function __init() {}
