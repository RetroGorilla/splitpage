/* ---------------------------------------------------------------------------
   Condensing header (BACKLOG: "File/production/gear/title should collapse
   into a toolbar on scroll").

   The header is sticky in CSS; this decides when it wears .is-condensed and
   plays the change as one movement instead of a snap (#52).

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
   stands. The brand line and the subtitle go to `display: none`, the row
   holding the title and the chips turns from a block into a flex row, and
   the title drops from 28px to 17px: three discrete changes, which is why
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
   - The brand line and the subtitle, which cannot fade from `display: none`.
     For the length of the movement .is-condensing takes them out of FLOW
     rather than out of the layout (app.css), so the header re-flows around
     them at once and they fade where they stood. Expanding is the other way
     about: they come back in flow and are faded in.

   A scroll that reverses mid-movement measures the pixels as they are —
   getBoundingClientRect() reports the transformed box — and only then
   cancels what is still running, so the second movement starts from where
   the first had got to instead of layering a second transform over it.

   A viewer who asked for reduced motion, or a browser with no
   Element.animate, gets exactly the behaviour that shipped before any of
   this: the class flips and the header is simply in its other state.
--------------------------------------------------------------------------- */
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

  /* Every part the two states put in a different place: the brand row, the
     title, the subtitle and the chips one by one, the toolbar as a whole
     (its buttons never move relative to each other), and then each sibling
     below the header, which all travel the same distance the header's own
     height changed by. */
  function headerParts() {
    const out = [];
    const kids = topbar.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].classList.contains("toolbar")) { out.push(kids[i]); continue; }
      const inner = kids[i].children;
      for (let j = 0; j < inner.length; j++) out.push(inner[j]);
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
      /* Arrived from display:none — the brand line and the subtitle on the
         way back up. Nowhere to travel from, so they simply appear. */
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
         keyframe pair saying "1 to 1" would hold the two rows the header is
         shedding at full opacity for the whole 180ms and the CSS fade they
         exist for would never be seen. The after-measurement is taken in the
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
