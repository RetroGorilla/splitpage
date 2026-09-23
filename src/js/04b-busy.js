/* ================= "something is happening" =================

   Before this file the app had no way at all to say it was working.
   Publishing a script, opening the list of documents on a server, pulling
   a Google Doc in, building a .docx or rendering a PDF of a long script —
   every one of them ran with the interface completely still, and on a slow
   network or a hundred-scene script that stillness is indistinguishable
   from a freeze. There is no spinner, skeleton or progress element
   anywhere in app.css; this adds exactly one, used by everything.

   Two rules make it polish rather than noise:

   1. Nothing appears for a fast operation. beginBusy() starts a timer, and
      an operation that finishes inside BUSY_SHOW_DELAY_MS paints nothing
      at all. A progress bar that flashes up for 30ms is worse than no
      progress bar — it reads as a glitch. Most exports on most scripts
      never show this.

   2. It is a counter, not a flag. Two overlapping operations (a share link
      publishes and then saves) raise the bar once and drop it once, rather
      than the first one to finish clearing it while the second is still
      going.

   The bar is created on demand rather than written into page.html: an
   element that does not exist cannot be a hidden element that takes up
   space, which is the regression 01-core.txt watches for. */

var BUSY_SHOW_DELAY_MS = 250;
var busyCount = 0;
var busyTimer = null;
var busyBarEl = null;

function busyBar() {
  if (busyBarEl && busyBarEl.isConnected) return busyBarEl;
  busyBarEl = document.createElement("div");
  busyBarEl.className = "busy-bar";
  /* role=status rather than progressbar: there is no determinate value to
     report, and a screen reader should hear the label once rather than be
     handed a meter that never moves. */
  busyBarEl.setAttribute("role", "status");
  busyBarEl.setAttribute("aria-live", "polite");
  busyBarEl.innerHTML = '<div class="busy-bar-sweep"></div><span class="busy-bar-label"></span>';
  document.body.appendChild(busyBarEl);
  return busyBarEl;
}

function showBusyBar(label) {
  var el = busyBar();
  var text = el.querySelector(".busy-bar-label");
  if (text) text.textContent = label || "Working…";
  el.classList.add("is-on");
}

function hideBusyBar() {
  if (busyBarEl) busyBarEl.classList.remove("is-on");
}

/* Returns a token to pass back to endBusy(). Callers should not count
   their own operations — the token is the only handle, so a caller cannot
   accidentally clear someone else's. */
export function beginBusy(label) {
  busyCount++;
  if (busyCount === 1) {
    clearTimeout(busyTimer);
    busyTimer = setTimeout(function () {
      busyTimer = null;
      if (busyCount > 0) showBusyBar(label);
    }, BUSY_SHOW_DELAY_MS);
  } else if (busyBarEl && busyBarEl.classList.contains("is-on") && label) {
    /* already on screen and a second operation has a better name for what
       is happening — say the newer one */
    showBusyBar(label);
  }
  return { done: false };
}

export function endBusy(token) {
  if (!token || token.done) return;
  token.done = true;
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount === 0) {
    clearTimeout(busyTimer);
    busyTimer = null;
    hideBusyBar();
  }
}

/* The shape every caller actually wants: wrap an async function so the
   indicator is raised for exactly as long as it runs, however it ends.
   The result and any thrown error pass straight through — this must be
   invisible to the operation it is wrapping, including to the callers
   that read publishToServer()'s true/false.

   Named withBusyBar, not withBusy: 20e-connect.js already declares its own
   withBusy(button, label, work), and the fragments in src/js share ONE
   function scope (see build.mjs). Two function declarations of one name in
   one scope is not two functions — the later file simply wins, and since
   20e sorts after 04b every call here would have reached the connect
   dialog's helper with the wrong arguments. */
export async function withBusyBar(label, fn) {
  var token = beginBusy(label);
  try {
    return await fn();
  } finally {
    endBusy(token);
  }
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
