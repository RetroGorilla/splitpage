import { cssDurationMs } from "../common/css-duration.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";

interface PartMeasurement {
  top: number;
  left: number;
  width: number;
  height: number;
  opacity: number;
}

export function mountTopbar({ window }: { window: Window }) {
  const document = window.document;
  const life = createViewLifetime(window);
  const { listen } = life;
  (function setupToolbarLabels() {
    const buttons = document.querySelectorAll<HTMLElement>(".toolbar .panel-toggle, .toolbar .btn-mode");
    if (!buttons.length) return;
    function measure() {
      if (!life.active()) return;
      buttons.forEach(function (btn) {
        const label = btn.querySelector(".btn-label");
        if (!label) return;
        const range = document.createRange();
        range.selectNodeContents(label);
        const w = range.getBoundingClientRect().width;
        if (w > 0) btn.style.setProperty("--label-w", w + "px");
      });
    }
    function closedBox(el: Element) {
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      return { left: r.left - (parseFloat(cs.marginLeft) || 0),
               right: r.right + (parseFloat(cs.marginRight) || 0) };
    }
    function settleReach(btn: HTMLElement) {
      const label = btn.querySelector(".btn-label");
      if (!label) return;
      const growsRight = btn.id === "btn-production" || btn.id === "btn-gear";
      const own = closedBox(btn);
      const text = parseFloat(btn.style.getPropertyValue("--label-w")) || 0;
      const reach = text + (btn.classList.contains("btn-mode") ? 6 : 5);
      let extra = 0;
      let best = Infinity;
      document.querySelectorAll(".toolbar .panel-toggle").forEach(function (other) {
        if (other === btn) return;
        const b = closedBox(other);
        const gap = growsRight ? b.right - (own.right + reach) : (own.left - reach) - b.left;
        const into = growsRight ? (own.right + reach) - b.left > 5 : b.right - (own.left - reach) > 5;
        if ((growsRight ? b.left >= own.right - 0.5 : b.right <= own.left + 0.5) && into && gap >= -0.5 && gap < best) best = gap;
      });
      if (best !== Infinity) extra = Math.max(0, best);
      btn.style.setProperty("--label-x", extra + "px");
    }
    measure();
    try { document.fonts.ready.then(measure); } catch (e) {}
    const toolbar = document.querySelector(".toolbar");
    const row = document.querySelector(".topbar-row");
    let lastWidth = -1;
    let jumpFrame = 0;
    life.release(function () {
      if (jumpFrame) window.cancelAnimationFrame(jumpFrame);
      if (toolbar) toolbar.classList.remove("is-width-jump");
      buttons.forEach(function (btn) { btn.classList.remove("is-label-open"); });
    });
    function widthNow(w: number) {
      const jump = lastWidth >= 0 && Math.abs(w - lastWidth) > 24;
      lastWidth = w;
      if (!jump || !toolbar) return;
      toolbar.classList.add("is-width-jump");
      if (jumpFrame) window.cancelAnimationFrame(jumpFrame);
      jumpFrame = window.requestAnimationFrame(function () {
        jumpFrame = window.requestAnimationFrame(function () {
          jumpFrame = 0;
          toolbar.classList.remove("is-width-jump");
        });
      });
    }
    if (row && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(function (entries) {
        if (!life.active()) return;
        const entry = entries[entries.length - 1];
        if (entry) widthNow(entry.contentRect.width);
      });
      observer.observe(row);
      life.release(function () { observer.disconnect(); });
    } else {
      listen(window, "resize", function () { widthNow(window.innerWidth); });
    }
    buttons.forEach(function (btn) {
      if (btn.id === "btn-write") return;
      listen(btn, "pointerenter", function (e) {
        if ("pointerType" in e && e.pointerType === "touch") return;
        settleReach(btn);
        btn.classList.add("is-label-open");
      });
      listen(btn, "focus", function () { settleReach(btn); });
      listen(btn, "pointerleave", function () {
        btn.classList.remove("is-label-open");
      });
    });
  })();

  const titleInput = document.querySelector<HTMLInputElement>("#doc-title");
  if (titleInput) {
    listen(titleInput, "mouseenter", function () {
      titleInput.title = titleInput.value || "";
    });
  }

  (function setupCondensingTopbar() {
    const topbarElement = document.querySelector<HTMLElement>(".topbar");
    if (!topbarElement) return;
    const topbar: HTMLElement = topbarElement;

    const ENTER_AT = 64;
    const LEAVE_AT = 24;
    let condensed = false;
    let queued = false;
    let playing: Animation[] = [];
    let sheddingTimer = 0;
    let scrollFrame = 0;
    life.release(function () {
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      stopPlaying();
      topbar.classList.remove("is-condensed", "is-condensing");
    });

    function motionOK() {
      try {
        if (typeof Element === "undefined" || !Element.prototype.animate) return false;
        if (document.hidden) return false;
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
      } catch (e) { return false; }
      return true;
    }

    function headerParts() {
      const out: Element[] = [];
      const strip = topbar.querySelector<HTMLElement>(".rundown");
      if (strip && !strip.hidden) {
        const ruler = strip.querySelector(".rundown-ruler");
        const track = strip.querySelector(".rundown-track");
        if (ruler) out.push(ruler);
        if (track) out.push(track);
      }
      let sib = topbar.nextElementSibling;
      while (sib) { out.push(sib); sib = sib.nextElementSibling; }
      return out;
    }

    function measure(parts: Element[]): PartMeasurement[] {
      return parts.map(function (el) {
        const r = el.getBoundingClientRect();
        let opacity = 1;
        try { opacity = parseFloat(window.getComputedStyle(el).opacity); } catch (e) {}
        return { top: r.top, left: r.left, width: r.width, height: r.height,
                 opacity: isFinite(opacity) ? opacity : 1 };
      });
    }

    function play(parts: Element[], before: PartMeasurement[]) {
      const after = measure(parts);
      const moveMs = cssDurationMs(window, "--dur-move", 180);
      const enterMs = cssDurationMs(window, "--dur-enter", 180);
      const easeStandard = "cubic-bezier(0.2, 0, 0, 1)";
      const easeEnter = "cubic-bezier(0.05, 0.7, 0.1, 1)";

      for (let i = 0; i < parts.length; i++) {
        const el = parts[i];
        const b = before[i];
        const a = after[i];
        if (!el || !a || !b) continue;
        if (!a.width && !a.height) continue;
        if (!b.width && !b.height) {
          playing.push(el.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: enterMs, easing: easeEnter }
          ));
          continue;
        }
        const dx = b.left - a.left;
        const dy = b.top - a.top;
        const scale = (el.id === "doc-title" && a.height) ? b.height / a.height : 1;
        const fades = Math.abs(b.opacity - a.opacity) >= 0.01;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.01 && !fades) continue;
        const from: Keyframe = {
          transformOrigin: "left top",
          transform: "translate(" + dx + "px, " + dy + "px) scale(" + scale + ")"
        };
        const to: Keyframe = { transformOrigin: "left top", transform: "none" };
        if (fades) { from.opacity = b.opacity; to.opacity = a.opacity; }
        playing.push(el.animate([from, to], { duration: moveMs, easing: easeStandard }));
      }
    }

    function stopPlaying() {
      for (const animation of playing) {
        try { animation.cancel(); } catch (e) {}
      }
      playing = [];
      if (sheddingTimer) { window.clearTimeout(sheddingTimer); sheddingTimer = 0; }
    }

    function setCondensed(next: boolean, animate: boolean) {
      const parts = animate ? headerParts() : null;
      const before = parts ? measure(parts) : null;
      const yBefore = scrollTop();
      stopPlaying();

      condensed = next;
      topbar.classList.toggle("is-condensed", next);
      topbar.classList.toggle("is-condensing", next && !!animate);

      topbar.getBoundingClientRect();
      if (scrollTop() !== yBefore) window.scrollTo(window.scrollX || 0, yBefore);

      if (!parts || !before) return;

      play(parts, before);
      if (next) {
        sheddingTimer = window.setTimeout(function () {
          sheddingTimer = 0;
          topbar.classList.remove("is-condensing");
        }, cssDurationMs(window, "--dur-move", 180));
      }
    }

    function scrollTop() {
      return window.scrollY || document.documentElement.scrollTop || 0;
    }

    function applyCondensedState(animate: boolean) {
      queued = false;
      const y = scrollTop();
      if (!condensed && y > ENTER_AT) setCondensed(true, animate && motionOK());
      else if (condensed && y < LEAVE_AT) setCondensed(false, animate && motionOK());
    }

    function onScroll() {
      if (queued) return;
      queued = true;
      scrollFrame = window.requestAnimationFrame(function () {
        scrollFrame = 0;
        if (life.active()) applyCondensedState(true);
      });
    }

    listen(window, "scroll", onScroll, { passive: true });
    applyCondensedState(false);
  })();
  return { dispose: life.dispose };
}
