  /* ================= scene row motion (FLIP) =================

     render() (05-render.js) rebuilds #rows by assigning innerHTML. Every
     scene is thrown away and written again from state, which is what makes
     it simple and what makes every structural change teleport: reorder a
     scene, press Alt+Up, drop a drag, delete a row, collapse a run of shot
     scenes — the document rearranges between two frames with nothing to say
     which thing went where. Alt+Up is the worst of them. You press a key
     and have to go find your own scene again.

     This is FLIP — First, Last, Invert, Play. Measure where every scene is,
     let render() do exactly what it already does, measure again, and for
     anything that ended up somewhere else, put it back where it was with a
     transform and animate that transform away. The browser does the paint;
     the layout is already final before the first frame of animation runs.

     Why not the View Transitions API, which is built for precisely this:
     startViewTransition() takes a callback and runs it ASYNCHRONOUSLY, so
     the DOM would no longer be correct by the time render() returned.
     Roughly 120 assertions in the test suites are written as "click this,
     now read the DOM" with nothing in between, and every one of them would
     start failing for reasons that have nothing to do with what they test.
     FLIP keeps the DOM update synchronous — only the paint is deferred —
     so render() stays a function that has finished when it returns.

     Everything here is best-effort. Any browser without Element.animate, or
     any viewer who asked for reduced motion, gets exactly the behaviour
     that shipped before this file existed. */

  /* Both kinds of child #rows can hold: a scene, and the strip that stands
     in for a collapsed run of shot scenes (01b-hide-shot.js). A strip is
     keyed by the ids it covers, so the same run collapsing and re-collapsing
     is recognised as the same strip rather than as one leaving and another
     arriving. */
  function rowMotionKey(el) {
    if (!el || !el.classList) return null;
    if (el.classList.contains("row")) return "row:" + el.getAttribute("data-id");
    if (el.classList.contains("hidden-shot-strip")) return "strip:" + el.getAttribute("data-ids");
    return null;
  }

  /* A document is one import away from being hundreds of scenes long, and
     measuring every one of them twice per render is not worth it for motion
     nobody asked for. Past this, render() behaves exactly as it always did. */
  var ROW_MOTION_MAX_ROWS = 200;
  /* An insert is one or two scenes. Anything more is an import, a file
     opened, or a version restored — a new document, not a change to this
     one, and fading a hundred rows in one at a time reads as a page still
     loading. */
  var ROW_MOTION_MAX_ENTER = 4;
  /* A collapsed run of shot scenes is the case that needs the largest
     number here: twelve scenes folding into one strip is a real edit. */
  var ROW_MOTION_MAX_EXIT = 12;

  function rowMotionEnabled() {
    try {
      if (typeof Element === "undefined" || !Element.prototype.animate) return false;
      /* A render that lands in a hidden tab has no frames to animate in, and
         would leave transforms sitting on rows until the tab came back. */
      if (document.hidden) return false;
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    } catch (e) { return false; }
    return true;
  }

  /* Positions are measured in DOCUMENT space (viewport rect plus scroll), not
     viewport space. render() refocuses whichever cell had the caret, and
     focusing a cell can scroll the page — measured in viewport space that
     scroll would look like every scene in the document having moved, and the
     whole script would slide on a render that changed nothing. */
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

  function rowMotionMs(name, fallback) {
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (!raw) return fallback;
      var n = parseFloat(raw);
      if (!isFinite(n)) return fallback;
      return /ms$/.test(raw) ? n : n * 1000;
    } catch (e) { return fallback; }
  }

  /* The single entry point. paint() is render()'s own innerHTML work, called
     exactly once and exactly when it would have been called anyway — this
     function never defers it, never skips it, and never calls it twice. If
     anything here throws, paint() has already run and the document is
     correct; only the animation is lost. */
  function withRowMotion(rowsEl, paint) {
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
          /* Sub-pixel drift from a reflow is not a move anyone made. */
          if (Math.abs(dy) >= 1) moved.push({ node: after.node[k], dy: dy });
        } else {
          entered.push(after.node[k]);
        }
      }
      /* Counted, not animated — see the note below. A large number of
         departures is how a wholesale document replacement is recognised. */
      for (i = 0; i < before.keys.length; i++) {
        k = before.keys[i];
        if (!after.rect[k]) exited.push(k);
      }

      if (!moved.length && !entered.length && !exited.length) return;

      /* A first paint, or a document replaced wholesale, is not a change to
         watch — it is a different script. Fading in every scene of an
         imported file looks like a page that has not finished loading. */
      var bulk = !before.keys.length || !after.keys.length ||
        entered.length > ROW_MOTION_MAX_ENTER || exited.length > ROW_MOTION_MAX_EXIT;

      for (i = 0; i < moved.length; i++) {
        moved[i].node.animate(
          [{ transform: "translateY(" + moved[i].dy + "px)" }, { transform: "translateY(0)" }],
          { duration: moveMs, easing: easeStandard }
        );
      }

      /* Nothing is animated OUT. A deleted scene, and a run of shot scenes
         folding into a strip, are both announced by the move instead: every
         scene below closes the gap, which is the thing that actually tells
         you what happened.

         There was a fade-out here, done the obvious way — clone the departing
         row into a layer and fade the clone. It is removed on purpose, and
         should not be added back in that form. A clone is a second copy of
         real interface sitting in the document for the length of its fade,
         where every selector in the app and every assertion in tests/ can
         reach it. Stripping the ids off it is not enough: a clone keeps its
         CLASSES, and those are selector hooks too. `.row` and
         `.hidden-shot-strip` are both queried unscoped in this codebase, so
         for ~120ms after a delete `document.querySelectorAll('.row').length`
         would have counted one row that no longer exists, and an expanded
         run of shot scenes would still have answered with a
         `.hidden-shot-strip`. The gap closing says enough. */
      if (!bulk) {
        for (i = 0; i < entered.length; i++) {
          entered[i].animate(
            [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "translateY(0)" }],
            { duration: enterMs, easing: easeEnter }
          );
        }
      }
    } catch (e) {
      /* The document is already correct — paint() ran above. Losing the
         animation is the whole cost of anything going wrong in here. */
    }
  }
