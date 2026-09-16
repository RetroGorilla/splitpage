/* ---------------------------------------------------------------------------
   Condensing header (BACKLOG: "File/production/gear/title should collapse
   into a toolbar on scroll").

   The header is sticky in CSS; this decides when it wears .is-condensed.

   The whole difficulty here is that condensing moves the very thing that
   triggers it. The header is in flow, so shedding its brand line and subtitle
   takes ~90px of page out from *above* the reader, and the browser gives the
   same ~90px back off the scroll offset — by anchoring (keeping what you are
   looking at still) and, once the page is no longer tall enough to hold the
   offset, by clamping. Condensing therefore drops scrollY by roughly a
   header's worth, and expanding raises it by the same.

   Two failures came out of that, reported together as the header's animations
   jittering at certain script lengths:

   1. The hysteresis gap was too narrow. Entering at 64px and leaving at 24px
      is 40px of gap against a ~90px kick, so condensing anywhere below ~114px
      put the offset under the leave threshold and the header expanded again,
      which handed the offset back and started the round over. On a long
      script that read as the page being yanked to the top the first time you
      scrolled past the header.
   2. On a script only a little taller than the window, the condensed page is
      not tall enough to hold *any* offset above the leave threshold. There is
      no scroll position that settles, so the two states beat against each
      other for as long as you keep scrolling.

   So: leave at 24px, and derive the enter threshold from how much the header
   actually sheds, far enough above the leave threshold that the post-condense
   offset still clears it — and refuse to condense at all unless the condensed
   page still has room for an offset that clears it. A script too short for
   that keeps the full header, which costs it nothing; it was never going to
   scroll far enough to want a toolbar.

   The kick is measured, not hard-coded: it moves with the theme, the font
   stack and how the header wraps at the current width. Two measurements are
   taken — the header's own margin box and the page height — and the larger
   wins, because neither is exact on its own (the header's bottom margin
   collapses with what follows, so the page can lose ~10px more than the box
   does). MARGIN then absorbs what is left over; it is why it is as wide as it
   is, and shrinking it will bring the jitter back.

   The page body scrolls (no inner scroll container), so window scroll is the
   signal. The listener is passive and coalesced into an animation frame:
   scroll fires far more often than the class needs to change.
--------------------------------------------------------------------------- */
(function setupCondensingTopbar() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;

  const LEAVE_AT = 24;
  /* Slack on every threshold, wide enough to cover the difference between the
     measured kick and the real one — see the note above. */
  const MARGIN = 24;

  let condensed = false;
  let queued = false;
  /* How much page the header takes with it when it condenses, and the scroll
     offset at which condensing is safe. Both are measured; -1 means "not yet". */
  let shrink = -1;
  let enterAt = Infinity;

  /* The header's own height plus the margins around it. */
  function outerHeight() {
    const box = getComputedStyle(topbar);
    return (
      topbar.getBoundingClientRect().height +
      (parseFloat(box.marginTop) || 0) +
      (parseFloat(box.marginBottom) || 0)
    );
  }

  function measure() {
    /* Suppress the transition across the measurement and force a layout on
       the way out, so the detour through the other state is over before
       transitions are live again — otherwise the header animates a change
       nobody asked for every time this runs. */
    const savedTransition = topbar.style.transition;
    topbar.style.transition = "none";
    const wasCondensed = topbar.classList.contains("is-condensed");

    topbar.classList.remove("is-condensed");
    const expandedBox = outerHeight();
    const expandedPage = document.documentElement.scrollHeight;
    topbar.classList.add("is-condensed");
    const condensedBox = outerHeight();
    const condensedPage = document.documentElement.scrollHeight;

    topbar.classList.toggle("is-condensed", wasCondensed);
    void topbar.offsetHeight;
    topbar.style.transition = savedTransition;

    shrink = Math.ceil(
      Math.max(0, expandedBox - condensedBox, expandedPage - condensedPage)
    );
    enterAt = LEAVE_AT + shrink + MARGIN;
  }

  function applyCondensedState() {
    queued = false;
    if (shrink < 0) measure();

    const y = window.scrollY || document.documentElement.scrollTop || 0;
    const maxScroll =
      document.documentElement.scrollHeight - window.innerHeight;
    /* Where the page could still be scrolled to with the header condensed. */
    const condensedMax = maxScroll - (condensed ? 0 : shrink);
    const hasRoom = condensedMax > LEAVE_AT + MARGIN;

    if (!condensed && hasRoom && y > enterAt) {
      condensed = true;
      topbar.classList.add("is-condensed");
    } else if (condensed && y < LEAVE_AT) {
      condensed = false;
      topbar.classList.remove("is-condensed");
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(applyCondensedState);
  }

  window.addEventListener("scroll", schedule, { passive: true });
  /* A resize re-wraps the header, so how much it sheds — and the threshold
     derived from it — has to be worked out again. */
  window.addEventListener(
    "resize",
    function onResize() {
      shrink = -1;
      schedule();
    },
    { passive: true }
  );
  /* Reloading part-way down a document restores the scroll offset, so settle
     the state once at boot rather than waiting for the first scroll. */
  applyCondensedState();
})();
