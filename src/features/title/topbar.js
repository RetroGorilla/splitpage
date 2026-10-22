export function mountTopbar({ window }) {
  const document = window.document;
  const releases = [];
  let disposed = false;
  function listen(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    releases.push(function () { target.removeEventListener(name, handler, options); });
  }
  function rowMotionMs(name, fallback) {
    try {
      const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (!raw) return fallback;
      const n = parseFloat(raw);
      if (!isFinite(n)) return fallback;
      return /ms$/.test(raw) ? n : n * 1000;
    } catch (e) { return fallback; }
  }
  (function setupToolbarLabels() {
    const buttons = document.querySelectorAll(".toolbar .panel-toggle, .toolbar .btn-mode");
    if (!buttons.length) return;
    function measure() {
      if (disposed) return;
      buttons.forEach(function (btn) {
        const label = btn.querySelector(".btn-label");
        if (!label) return;
        const range = document.createRange();
        range.selectNodeContents(label);
        const w = range.getBoundingClientRect().width;
        if (w > 0) btn.style.setProperty("--label-w", w + "px");
      });
    }
    function closedBox(el) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { left: r.left - (parseFloat(cs.marginLeft) || 0),
               right: r.right + (parseFloat(cs.marginRight) || 0) };
    }
    function settleReach(btn) {
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
    releases.push(function () {
      if (jumpFrame) cancelAnimationFrame(jumpFrame);
      if (toolbar) toolbar.classList.remove("is-width-jump");
      buttons.forEach(function (btn) { btn.classList.remove("is-label-open"); });
    });
    function widthNow(w) {
      const jump = lastWidth >= 0 && Math.abs(w - lastWidth) > 24;
      lastWidth = w;
      if (!jump || !toolbar) return;
      toolbar.classList.add("is-width-jump");
      if (jumpFrame) cancelAnimationFrame(jumpFrame);
      jumpFrame = requestAnimationFrame(function () {
        jumpFrame = requestAnimationFrame(function () {
          jumpFrame = 0;
          toolbar.classList.remove("is-width-jump");
        });
      });
    }
    if (row && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(function (entries) {
        if (disposed) return;
        widthNow(entries[entries.length - 1].contentRect.width);
      });
      observer.observe(row);
      releases.push(function () { observer.disconnect(); });
    } else {
      listen(window, "resize", function () { widthNow(window.innerWidth); });
    }
    buttons.forEach(function (btn) {
      if (btn.id === "btn-write") return;
      listen(btn, "pointerenter", function (e) {
        if (e.pointerType === "touch") return;
        settleReach(btn);
        btn.classList.add("is-label-open");
      });
      listen(btn, "focus", function () { settleReach(btn); });
      listen(btn, "pointerleave", function () {
        btn.classList.remove("is-label-open");
      });
    });
  })();

  const titleInput = document.getElementById("doc-title");
  if (titleInput) {
    listen(titleInput, "mouseenter", function () {
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
    let playing = [];
    let sheddingTimer = 0;
    let scrollFrame = 0;
    releases.push(function () {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
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
      scrollFrame = requestAnimationFrame(function () {
        scrollFrame = 0;
        if (!disposed) applyCondensedState(true);
      });
    }

    listen(window, "scroll", onScroll, { passive: true });
    applyCondensedState(false);
  })();
  return {
    dispose: function () {
      if (disposed) return;
      disposed = true;
      while (releases.length) releases.pop()();
    }
  };
}
