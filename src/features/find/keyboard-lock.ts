interface FindKeyboardCapture {
  readonly lock: (keys: string[]) => Promise<void>;
  readonly unlock: () => void;
}

export function captureFindEscape(win: Window): () => void {
  let held: FindKeyboardCapture | null = null;
  let request = 0;
  function release() {
    request++;
    const keyboard = held;
    held = null;
    try { keyboard?.unlock(); } catch {}
  }
  function fullscreenChanged() {
    if (!win.document.fullscreenElement) { release(); return; }
    if (held) return;
    const keyboard = (win.navigator as Navigator & { readonly keyboard?: FindKeyboardCapture }).keyboard;
    if (typeof keyboard?.lock !== "function" || typeof keyboard.unlock !== "function") return;
    const current = ++request;
    held = keyboard;
    try {
      void keyboard.lock(["Escape"]).catch(() => { if (request === current) held = null; });
    } catch { if (request === current) held = null; }
  }
  win.document.addEventListener("fullscreenchange", fullscreenChanged);
  fullscreenChanged();
  return () => {
    win.document.removeEventListener("fullscreenchange", fullscreenChanged);
    release();
  };
}
