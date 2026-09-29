import { rowMotionMs } from "./04a-row-motion.js";

export function __init() {
  const titleInput = document.getElementById("doc-title");
  if (titleInput) {
    titleInput.addEventListener("mouseenter", function () {
      titleInput.title = titleInput.value || "";
    });
  }

  (function setupCondensingTopbar() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;

    const ENTER_AT = 64;
    const LEAVE_AT = 24;
    let condensed = false;
    let queued = false;
    // Overlapping Element.animate() on one property both keep running
    let playing = [];
    let sheddingTimer = 0;

    // Hidden tab: unseen motion would leave stuck transforms
    function motionOK() {
      try {
        if (typeof Element === "undefined" || !Element.prototype.animate) return false;
        if (document.hidden) return false;
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
      } catch (e) { return false; }
      return true;
    }

    function headerParts() {
      const out = [];
      const strip = topbar.querySelector(".rundown");
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

    // Viewport space, unlike 04a-row-motion.js's document space
    function measure(parts) {
      return parts.map(function (el) {
        const r = el.getBoundingClientRect();
        let opacity = 1;
        try { opacity = parseFloat(getComputedStyle(el).opacity); } catch (e) {}
        return { top: r.top, left: r.left, width: r.width, height: r.height,
                 opacity: isFinite(opacity) ? opacity : 1 };
      });
    }

    function play(parts, before) {
      const after = measure(parts);
      const moveMs = rowMotionMs("--dur-move", 180);
      const enterMs = rowMotionMs("--dur-enter", 180);
      const easeStandard = "cubic-bezier(0.2, 0, 0, 1)";
      const easeEnter = "cubic-bezier(0.05, 0.7, 0.1, 1)";

      for (let i = 0; i < parts.length; i++) {
        const el = parts[i];
        const b = before[i];
        const a = after[i];
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
        // Animation outranks transition; 1-to-1 keyframes would block fade
        const fades = Math.abs(b.opacity - a.opacity) >= 0.01;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.01 && !fades) continue;
        const from = {
          transformOrigin: "left top",
          transform: "translate(" + dx + "px, " + dy + "px) scale(" + scale + ")"
        };
        const to = { transformOrigin: "left top", transform: "none" };
        if (fades) { from.opacity = b.opacity; to.opacity = a.opacity; }
        playing.push(el.animate([from, to], { duration: moveMs, easing: easeStandard }));
      }
    }

    function stopPlaying() {
      for (let i = 0; i < playing.length; i++) {
        try { playing[i].cancel(); } catch (e) {}
      }
      playing = [];
      if (sheddingTimer) { clearTimeout(sheddingTimer); sheddingTimer = 0; }
    }

    function setCondensed(next, animate) {
      const parts = animate ? headerParts() : null;
      const before = animate ? measure(parts) : null;
      const yBefore = scrollTop();
      stopPlaying();

      condensed = next;
      topbar.classList.toggle("is-condensed", next);
      topbar.classList.toggle("is-condensing", next && !!animate);

      topbar.getBoundingClientRect();
      // Chromium scroll anchoring flips condensed state endlessly; restore offset
      if (scrollTop() !== yBefore) window.scrollTo(window.scrollX || 0, yBefore);

      if (!animate) return;

      play(parts, before);
      if (next) {
        sheddingTimer = setTimeout(function () {
          sheddingTimer = 0;
          topbar.classList.remove("is-condensing");
        }, rowMotionMs("--dur-move", 180));
      }
    }

    function scrollTop() {
      return window.scrollY || document.documentElement.scrollTop || 0;
    }

    function applyCondensedState(animate) {
      queued = false;
      const y = scrollTop();
      if (!condensed && y > ENTER_AT) setCondensed(true, animate && motionOK());
      else if (condensed && y < LEAVE_AT) setCondensed(false, animate && motionOK());
    }

    function onScroll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { applyCondensedState(true); });
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    // Reload restores scroll; settle once without animating
    applyCondensedState(false);
  })();
}
