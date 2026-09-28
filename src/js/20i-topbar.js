/* ---------------------------------------------------------------------------
   Condensing header (BACKLOG: "File/production/gear/title should collapse
   into a toolbar on scroll").

   The header is sticky in CSS; this decides when it wears .is-condensed and
   plays the change as one movement instead of a snap (#52).

   Since #169 (Direction B) the header's own row is already the toolbar that
   request asked for — the mark, File, the title, the clock and the buttons
   on one line — so condensing no longer touches it. What it sheds is the
   rundown strip's time ruler: once the script is passing underneath, the
   blocks and the playhead are what you look at, and the ruler's ticks go.
   Everything below still describes the mechanism exactly; where it says
   "the brand line", read the ruler, and the title no longer changes size.

   Two thresholds rather than one: a single threshold sits exactly on the
   boundary where condensing changes the header's own height, which moves the
   content under it, which can move the scroll position back across the
   threshold — a bar that flickers between states while the page is still.
   Entering at 64px and leaving at 24px keeps an ordinary scroll off that
   boundary. The gap alone was never enough, though: see setCondensed(),
   which puts the scroll offset back where the reader left it so the browser's
   own scroll anchoring cannot answer the question for us.

   The page body scrolls (no inner scroll container), so window scroll is the
   signal. The listener is passive and coalesced into an animation frame:
   scroll fires far more often than the class needs to change.

   ---- why the movement is FLIP and not a transition on the header itself ----

   Almost nothing the condensed state changes can be transitioned where it
   stands. The brand line goes to `display: none`, the title line and the
   toolbar go from two rows to one, and the title drops from 19px to 16px:
   three discrete changes, which is why
   the header used to re-draw between two frames while the two properties
   that did ease (padding-bottom, box-shadow) eased past it.

   So the layout still lands in a single frame, and the pixels are put back
   afterwards: measure where everything is, flip the class, measure again,
   and animate each part from where it was to where it now is with a
   transform. Same technique 04a-row-motion.js uses for scene rows, for the
   same two reasons. The work is on the compositor — this fires on
   essentially every scroll away from the top, above a document that can run
   to hundreds of scenes — and applyCondensedState() stays synchronous, so
   the class is correct the instant it is read rather than 180ms later.

   It also keeps the oscillation guard answerable. An eased height would have
   put the header's height in flux *over time*, and a threshold gap would
   have had to hold against a moving number; this way the height still
   changes exactly once, in the frame the class flips, which is what lets
   setCondensed() below measure the scroll offset on either side of it and
   put it back.

   Three things beyond the header move with it:

   - Everything below it. The height change shifts every sibling under the
     header by the same distance, and that shift — the script sliding under
     the reader mid-scroll — is the part the issue called roughest.
   - The title, which changes size as well as place, so its transform carries
     a scale. The glyphs are laid out once at their final size and the
     compositor does the rest; an eased font-size would re-shape text on
     every frame of every condense.
   - The brand line, which cannot fade from `display: none`. For the length
     of the movement .is-condensing takes it out of FLOW rather than out of
     the layout (app.css), so the header re-flows around it at once and it
     fades where it stood. Expanding is the other way about: it comes back in
     flow and is faded in.

   A scroll that reverses mid-movement measures the pixels as they are —
   getBoundingClientRect() reports the transformed box — and only then
   cancels what is still running, so the second movement starts from where
   the first had got to instead of layering a second transform over it.

   A viewer who asked for reduced motion, or a browser with no
   Element.animate, gets exactly the behaviour that shipped before any of
   this: the class flips and the header is simply in its other state.
--------------------------------------------------------------------------- */

import { rowMotionMs } from "./04a-row-motion.js";

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* ---- the toolbar's labels (PR #233) ----
     Where the row runs short, the panel toggles', Collab's and Write's
     labels close up to their icons, and a closed one opens back out over
     its neighbours on hover or focus — all of it in app.css ("the
     toolbar's labels"), at the widths it always was. Three things the CSS
     cannot do itself:

     - Know how wide a label is. A width animation needs a number at both
       ends, and the negative margin that keeps the neighbours still while
       a label opens over them has to be exactly that number, so each
       button carries --label-w: its label's text, measured with a Range
       (the laid-out text, fractions of a pixel and all, whether the label
       is open or clipped to nothing). Measured once now and again when the
       web fonts arrive — the words never change.
     - Say where the pill should end. Opened to the label's width alone it
       stops wherever that falls — across the middle of a neighbour's icon,
       leaving a sliver of it and its count hanging off the end. So as a
       button opens, --label-x is the few px more that carry it to the
       nearest edge of a panel toggle beyond (no further than the panels'
       slot: never over Search, Collab, Write or Present). Worked out from
       the buttons' closed boxes — the margin box, which an open neighbour
       does not change — at the moment it opens.
     - Tell a mouse from a finger. A touch has no hover, and a tap would
       otherwise leave the pill it opened sitting there; so the pointer
       opens a label (.is-label-open) only when it is not a touch. */
  (function setupToolbarLabels() {
    const buttons = document.querySelectorAll(".toolbar .panel-toggle, .toolbar .btn-mode");
    if (!buttons.length) return;
    function measure() {
      buttons.forEach(function (btn) {
        const label = btn.querySelector(".btn-label");
        if (!label) return;
        const range = document.createRange();
        range.selectNodeContents(label);
        const w = range.getBoundingClientRect().width;
        if (w > 0) btn.style.setProperty("--label-w", w + "px");
      });
    }
    /* A button's closed box: its margin box, which is what an open label's
       negative margin keeps constant. */
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
        /* the far edge of a toggle beyond, if the label reaches past its
           6px of padding into its icon (a label that only grazes the
           padding is left where it ends) */
        const gap = growsRight ? b.right - (own.right + reach) : (own.left - reach) - b.left;
        const into = growsRight ? (own.right + reach) - b.left > 5 : b.right - (own.left - reach) > 5;
        if ((growsRight ? b.left >= own.right - 0.5 : b.right <= own.left + 0.5) && into && gap >= -0.5 && gap < best) best = gap;
      });
      if (best !== Infinity) extra = Math.max(0, best);
      btn.style.setProperty("--label-x", extra + "px");
    }
    measure();
    try { document.fonts.ready.then(measure); } catch (e) {}
    /* A window that changes width by a lot at once — snapped to half the
       screen, restored, a phone turned — skips the labels' animation
       (.is-width-jump, app.css). The labels are what the row makes room
       with, so while one is still closing on a row that has just lost
       hundreds of px, the title, the facts and Search would sit on top of
       each other for its whole length. A drag, a few px a frame, crosses
       the width with the room to spare that the animation needs. */
    /* Watched with a ResizeObserver on the row rather than the window's
       resize event: its callback runs after layout and before paint, so
       the class lands (and cancels a transition that has just started) in
       the frame the width changed, whenever the event would have come. */
    const toolbar = document.querySelector(".toolbar");
    const row = document.querySelector(".topbar-row");
    let lastWidth = -1;
    let jumpFrame = 0;
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
      new ResizeObserver(function (entries) {
        widthNow(entries[entries.length - 1].contentRect.width);
      }).observe(row);
    } else {
      window.addEventListener("resize", function () { widthNow(window.innerWidth); });
    }
    buttons.forEach(function (btn) {
      if (btn.id === "btn-write") return;
      btn.addEventListener("pointerenter", function (e) {
        if (e.pointerType === "touch") return;
        settleReach(btn);
        btn.classList.add("is-label-open");
      });
      btn.addEventListener("focus", function () { settleReach(btn); });
      btn.addEventListener("pointerleave", function () {
        btn.classList.remove("is-label-open");
      });
    });
  })();

  /* The title gives way first when the row is short (#183) and ends in
     "…"; pointing at it shows the whole of it. Read at the moment it is
     pointed at, so no path that sets the title has to remember this. */
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
    /* Everything still in flight, so a reversal can cancel it. Two
       Element.animate()s on one property both keep running and the later one
       wins the pixels; the loser would go on ticking underneath. */
    let playing = [];
    let sheddingTimer = 0;

    /* Same test 04a-row-motion.js makes of itself, and for the same reason: a
       movement that cannot be seen (a hidden tab) would leave transforms
       sitting on the header until the tab came back. */
    function motionOK() {
      try {
        if (typeof Element === "undefined" || !Element.prototype.animate) return false;
        if (document.hidden) return false;
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
      } catch (e) { return false; }
      return true;
    }

    /* Every part the two states put in a different place: the rundown's
       ruler (the part being shed) and its track of blocks, which rises into
       the ruler's place (#169), and then each sibling below the header,
       which all travel the same distance the header's own height changed
       by. The header's row never moves. */
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

    /* Viewport space, not document space. 04a-row-motion.js measures in
       document space because render() can scroll the page between its two
       measurements; both of these happen in one frame with the scroll offset
       already settled, and what is wanted here is the on-screen delta. */
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
      /* 04a-row-motion.js's reader for the motion tokens — same shared scope,
         and there is no second way to spell "--dur-move in milliseconds". */
      const moveMs = rowMotionMs("--dur-move", 180);
      const enterMs = rowMotionMs("--dur-enter", 180);
      const easeStandard = "cubic-bezier(0.2, 0, 0, 1)";
      const easeEnter = "cubic-bezier(0.05, 0.7, 0.1, 1)";

      for (let i = 0; i < parts.length; i++) {
        const el = parts[i];
        const b = before[i];
        const a = after[i];
        /* Gone: the CSS fade in .is-condensing is seeing it out. */
        if (!a.width && !a.height) continue;
        /* Arrived from display:none — the brand line on the way back up. Nowhere to travel from, so they simply appear. */
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
        /* Opacity is named here only when it actually differs, and that is not
           tidiness. A web animation outranks a transition in the cascade, so a
           keyframe pair saying "1 to 1" would hold the brand line the header is
           shedding at full opacity for the whole 180ms and the CSS fade it
           exists for would never be seen. The after-measurement is taken in the
           frame the class landed, before that transition has moved, so "the
           same" is exactly what it reads. What it does catch is the reversal:
           a row caught half-faded has a real difference to travel back. */
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

    /* Stops what is running without touching the classes — the caller is about
       to set those itself, and doing it here would move the layout between the
       two measurements. */
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
      /* Added in the same style change as .is-condensed so the header re-flows
         once, and dropped when the fade it exists for is over. */
      topbar.classList.toggle("is-condensing", next && !!animate);

      /* ---- the other half of the oscillation guard ----

         The header is at the top of the document, so changing its height
         changes the height of everything above whatever the browser is using
         as its scroll anchor, and Chromium answers by moving the scroll
         offset to hold that content still. Which means condensing at 70px
         took the offset to 0, where the leave threshold immediately expanded
         the header, which put the offset back at 70, which condensed it: a
         header that flips back and forth on a page nobody is touching. The
         two thresholds could never have stopped it — the anchoring adjustment
         is the full height the header just gave up, roughly twice the 40px
         between them, so it lands on the far side however the two are set.

         Putting the offset back where the reader left it takes the adjustment
         out of the decision: the class becomes a function of a scroll
         position this file no longer changes, and the same position cannot
         argue for both states. What the adjustment was hiding — the document
         closing the gap the header gave up — is the movement FLIP is here to
         play, so it is now seen rather than swallowed.

         A document barely taller than the window cannot hold the old offset:
         the restore clamps, and one settling flip may follow. That is
         bounded, unlike the loop above, because nothing after it moves the
         offset again. */
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
      requestAnimationFrame(function () { applyCondensedState(true); });
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    /* Reloading part-way down a document restores the scroll offset, so settle
       the state once at boot rather than waiting for the first scroll — and
       without animating, since nothing moved: that is where the header was
       when the page appeared. */
    applyCondensedState(false);
  })();
}
