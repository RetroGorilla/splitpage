export function mountScriptPlace(window: Window) {
  const document = window.document;
  const performance = window.performance;
  const requestAnimationFrame = (run: FrameRequestCallback) => window.requestAnimationFrame(run);
  let disposed = false;
  let placeHold: { el: Element; y: number; frac: number; until: number; frames: number } | null = null;
  let placeFrame = 0;

  function scriptTopY() {
    const bar = document.querySelector(".topbar");
    const y = bar ? bar.getBoundingClientRect().bottom : 0;
    return Math.max(0, y) + 1;
  }

  function holdScriptPlace() {
    if (placeHold) { placeHold.until = performance.now() + 1000; return; }
    if (window.scrollY <= 0) return;
    let y = scriptTopY();
    const rows = document.querySelectorAll("#rows > .row");
    let el = null;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i] as Element).getBoundingClientRect().bottom > y) { el = rows[i] as Element; break; }
    }
    if (!el) return;
    let rect = el.getBoundingClientRect();
    const next = el.nextElementSibling;
    if (rect.top < y && next && next.classList.contains("row")) {
      const nextTop = next.getBoundingClientRect().top;
      if (nextTop < y + (window.innerHeight - y) / 3) { el = next; y = nextTop; rect = next.getBoundingClientRect(); }
    }
    placeHold = {
      el: el, y: y,
      frac: rect.height ? (y - rect.top) / rect.height : 0,
      until: performance.now() + 1000,
      frames: 0
    };
    if (!placeFrame) placeFrame = requestAnimationFrame(stepScriptPlace);
  }

  function stepScriptPlace() {
    placeFrame = 0;
    const h = placeHold;
    if (!h || !h.el.isConnected) { placeHold = null; return; }
    const rect = h.el.getBoundingClientRect();
    const dy = rect.top + h.frac * rect.height - h.y;
    if (Math.abs(dy) >= 0.5) window.scrollBy(0, dy);
    h.frames++;
    const root = document.getElementById("root");
    const row = document.querySelector(".topbar-row");
    const moving = (root && root.getAnimations().length) || (row && row.getAnimations().length);
    if (moving) h.frames = Math.min(h.frames, 1);
    if ((h.frames > 3 && !moving) || performance.now() > h.until) { placeHold = null; return; }
    placeFrame = requestAnimationFrame(stepScriptPlace);
  }

  function letGoOfScriptPlace() { placeHold = null; }

  function sidePanelOpening(open: boolean) {
    const html = document.documentElement;
    if (open) html.style.setProperty("--page-gutter", Math.max(0, window.innerWidth - html.clientWidth) + "px");
    holdScriptPlace();
  }


  window.addEventListener("wheel", letGoOfScriptPlace, { passive: true });
  window.addEventListener("touchmove", letGoOfScriptPlace, { passive: true });
  window.addEventListener("keydown", letGoOfScriptPlace, true);
  return { holdScriptPlace, sidePanelOpening, dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("wheel", letGoOfScriptPlace);
    window.removeEventListener("touchmove", letGoOfScriptPlace);
    window.removeEventListener("keydown", letGoOfScriptPlace, true);
    letGoOfScriptPlace();
    if (placeFrame) window.cancelAnimationFrame(placeFrame);
    placeFrame = 0;
  } };
}
