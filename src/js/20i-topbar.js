/* ---------------------------------------------------------------------------
   Condensing header (BACKLOG: "File/production/gear/title should collapse
   into a toolbar on scroll").

   The header is sticky in CSS; this decides when it wears .is-condensed.

   Two thresholds rather than one: a single threshold sits exactly on the
   boundary where condensing changes the header's own height, which moves the
   content under it, which can move the scroll position back across the
   threshold — a bar that flickers between states while the page is still.
   Entering at 64px and leaving at 24px is wider than any height the header
   gains or loses, so the state cannot oscillate.

   The page body scrolls (no inner scroll container), so window scroll is the
   signal. The listener is passive and coalesced into an animation frame:
   scroll fires far more often than the class needs to change.
--------------------------------------------------------------------------- */
(function setupCondensingTopbar() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;

  const ENTER_AT = 64;
  const LEAVE_AT = 24;
  let condensed = false;
  let queued = false;

  function applyCondensedState() {
    queued = false;
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    if (!condensed && y > ENTER_AT) {
      condensed = true;
      topbar.classList.add("is-condensed");
    } else if (condensed && y < LEAVE_AT) {
      condensed = false;
      topbar.classList.remove("is-condensed");
    }
  }

  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(applyCondensedState);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  /* Reloading part-way down a document restores the scroll offset, so settle
     the state once at boot rather than waiting for the first scroll. */
  applyCondensedState();
})();
