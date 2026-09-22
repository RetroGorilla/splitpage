import { S } from "./_state.js";
import { home } from "./_home.js";
import { loadLastFileHandle } from "./00-prelude.js";
import { escapeHtml, makeId, migrateRows } from "./02-state.js";
import { syncDocIdentity } from "./02b-doc-id.js";
import { cloneState, updateIdentityChip } from "./03-sync.js";
import { render } from "./05-render.js";
import { resetProductionPanelState } from "./07-production-tags.js";
import { showToast, updateSaveStatus } from "./12-dirty-toast.js";
import { openLocalFile, openProjectFile, updateFileChip } from "./18-local-files.js";
import { seedCheckPasses } from "./20b-onboarding.js";
import { makeDesktopHandle, notifyDesktopDocumentState } from "./20f-desktop.js";
import { draftRestorePending } from "./20g-drafts.js";

/* ================= the New Tab page =================

   A new desktop tab (and a fresh copy of the app in the browser) used to
   land on the seeded demo document, so the first thing anyone did was
   clear out somebody else's example script or go hunting through the File
   drawer for Open. This page puts the only two things a new tab is
   actually for one click away: an empty script, or the file picker.

   WHAT IT IS NOT: a modal. It is an opaque full-page layer at z-index
   130 — above the topbar (120), below the side panels (140), the modals
   (150) and the tour (160) — so the first-run wizard still shows over it
   on a genuinely first run, and so nothing here can swallow a dialog.

   WHAT IT DOES NOT TOUCH: the document. Showing the page changes no
   state at all; the demo is still underneath, which is why "Look at the
   example script instead" (and Esc) can simply dismiss it. Only the
   "New script" button replaces the document, and it replaces it with a
   genuinely empty one — one blank scene, no tags, no comments, no
   b-roll, a fresh identity — not a filtered copy of the seed.

   THE THIRD COLUMN (issue #15) is recently-opened documents, and it is
   DESKTOP ONLY. The list is kept by the main process in
   desktop-state.json (contract DESKTOP-RECENTS) because that is the only
   side that can hold a durable reference to a file: the browser build
   remembers exactly one handle, and can only reopen one it still has
   permission for. So in the browser this column stays hidden and the
   page keeps its two cards.

   Nothing about the list reaches this page but what it needs to draw it
   and click it: an opaque fileId, the file's basename, the title the
   document last reported, and when. Never a path (invariant #34), and it
   is deliberately not in the app-data export either (§5 #48) — it is a
   record of what someone has been working on.

   Like 20b/20c/20e this fragment wires itself directly rather than
   through init(): #newtab-page is in the DOM by the time this classic
   script runs. */

var newTabPageShown = false;

function newTabPageEl() { return document.getElementById("newtab-page"); }

/* The test harness turns the page off the same way it turns the first-run
   wizard off, and for the same reason: every existing suite boots on the
   pristine demo and clicks into it, and a full-page layer over that would
   break all of them. Both drivers set the flag before any page script
   runs unless the suite asked for the page with ?newtab=1. */
function newTabSuppressed() {
  return window.__splitpageNoNewTab === true;
}

function openNewTabPage() {
  var el = newTabPageEl();
  if (!el || newTabPageShown) return;
  newTabPageShown = true;
  el.hidden = false;
  document.addEventListener("keydown", onNewTabKeydown, true);
  var first = el.querySelector('[data-newtab-action="new"]');
  if (first) first.focus();
  /* Asked for every time the page is shown rather than cached: another
     tab (or another window) may have opened something since, and main is
     the only authority on the list. Not awaited — the two cards must not
     wait on IPC to become clickable. */
  refreshRecents();
}

export function closeNewTabPage() {
  var el = newTabPageEl();
  if (!newTabPageShown) return;
  newTabPageShown = false;
  if (el) el.hidden = true;
  document.removeEventListener("keydown", onNewTabKeydown, true);
}

function onNewTabKeydown(e) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  e.preventDefault();
  closeNewTabPage();
}

/* ---- "New script": a genuinely empty document ----

   migrateRows fills in every list the document carries (comments,
   productionTags, people, brollShots, wordsPerMinute) and mints a fresh
   docId, so building the blank from its two required fields is enough —
   and is the only way to be sure nothing of the seed survives.

   Not dirty, and editSeq untouched: an empty document nobody has typed
   into yet is exactly what isPristineSeedDocument() (03a-history-store.js)
   means by pristine, which is what lets the desktop shell keep routing an
   open into this tab and keep closing it without a prompt. */
function blankDocumentState() {
  return migrateRows({
    title: "Untitled Script",
    rows: [{ id: makeId("r"), visualText: "", visualImage: null, audioText: "" }]
  });
}

function startBlankScript() {
  /* Clicked before loadInitialState() resolved: assigning `state` now
     would just be overwritten when the boot load lands (the same race
     20f-desktop.js's open handlers wait out). */
  if (!S.state && S.initialStateReady) return S.initialStateReady.then(startBlankScript);
  S.state = blankDocumentState();
  S.baseState = cloneState(S.state);
  /* A blank document's id has never left this page, so a first Save can
     take it with it rather than forking a new one (02b-doc-id.js). */
  S.docIdWrittenOut = false;
  resetProductionPanelState();
  render();
  updateFileChip();
  updateIdentityChip();
  updateSaveStatus();
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  closeNewTabPage();
  return Promise.resolve(true);
}

/* ---- "Open a file" ----
   Exactly the File ▸ Open a document… path, picker and all. A cancelled
   picker leaves the page up (nothing happened); an open that main routed
   into some OTHER tab leaves this one on the New Tab page too, which is
   what that tab now is. */
async function newTabOpenFile() {
  await openLocalFile();
  if (home.kind === "import" || home.kind === "file") closeNewTabPage();
}

/* ---- the recent-documents column (DESKTOP-RECENTS) ---- */

function recentsSupported() {
  return !!(S.DESKTOP && typeof S.DESKTOP.listRecents === "function");
}

function formatRecentWhen(at) {
  if (!at) return "";
  var days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  return new Date(at).toLocaleDateString();
}

function renderRecents(entries) {
  var col = document.getElementById("newtab-recents");
  var list = document.getElementById("newtab-recents-list");
  var cards = document.querySelector("#newtab-page .newtab-cards");
  var inner = document.querySelector("#newtab-page .newtab-inner");
  if (!col || !list) return;
  /* The column itself stays once it is up, empty list and all: "Recent
     (nothing yet)" is a truthful answer, and a column that appears and
     disappears under the pointer as the last entry is forgotten is not. */
  col.hidden = false;
  if (cards) cards.classList.add("has-recents");
  if (inner) inner.classList.add("has-recents");
  var clear = document.getElementById("newtab-recents-clear");
  if (clear) clear.hidden = !entries.length;
  if (!entries.length) {
    list.innerHTML = '<div class="newtab-recents-empty">Nothing yet — what you open shows up here.</div>';
    return;
  }
  list.innerHTML = entries.map(function (r) {
    var when = formatRecentWhen(r.at);
    var title = r.title || r.name;
    return '<div class="newtab-recent">' +
      '<button type="button" class="newtab-recent-open" data-newtab-action="open-recent" ' +
        'data-file-id="' + escapeHtml(r.fileId) + '" title="' + escapeHtml(r.name) + '">' +
        '<span class="newtab-recent-title">' + escapeHtml(title) + '</span>' +
        '<span class="newtab-recent-name">' + escapeHtml(r.name) + (when ? " · " + escapeHtml(when) : "") + '</span>' +
      '</button>' +
      '<button type="button" class="newtab-recent-forget" data-newtab-action="forget-recent" ' +
        'data-file-id="' + escapeHtml(r.fileId) + '" title="Forget this one" ' +
        'aria-label="Forget ' + escapeHtml(title) + '">\u00d7</button>' +
    '</div>';
  }).join("");
}

async function refreshRecents() {
  if (!recentsSupported()) return;
  var entries;
  try { entries = await S.DESKTOP.listRecents(); } catch (e) { return; }
  renderRecents(Array.isArray(entries) ? entries : []);
}

/* A click on a card is the same open File ▸ Open a document… performs,
   minus the picker: main already holds the path behind this fileId and
   still decides where it lands. A file that has been moved or deleted
   since is the case the issue calls out — routeOpen rejects, and the
   entry says so and offers to forget itself rather than failing
   silently. */
async function openRecent(fileId) {
  if (!fileId || !recentsSupported()) return;
  var entry;
  try {
    var r = await S.DESKTOP.routeOpen({ kind: "file", fileId: fileId });
    if (!r || r.where !== "this-tab") {
      /* It went to the tab that already had it, or to a new one. This tab
         is still a new tab; leave the page up, same as the picker path. */
      refreshRecents();
      return;
    }
    entry = await S.DESKTOP.readFile(fileId);
  } catch (e) {
    showToast("That file isn't there any more — it may have been moved or deleted. " +
      "Use × to take it off this list.", "warn");
    refreshRecents();
    return;
  }
  var handle = makeDesktopHandle(entry);           /* 20f-desktop.js */
  await openProjectFile(await handle.getFile(), handle);  /* 18-local-files.js */
}

async function forgetRecent(fileId) {
  /* DESKTOP can go away under a rendered column — __desktopTest's
     restoreBackend() does exactly that at the end of a suite — so every
     one of these re-checks the bridge rather than trusting the button's
     existence. */
  if (!fileId || !recentsSupported() || typeof S.DESKTOP.removeRecent !== "function") return;
  var entries;
  try { entries = await S.DESKTOP.removeRecent(fileId); } catch (e) { return; }
  renderRecents(Array.isArray(entries) ? entries : []);
}

async function clearRecents() {
  if (!recentsSupported() || typeof S.DESKTOP.clearRecents !== "function") return;
  var entries;
  try { entries = await S.DESKTOP.clearRecents(); } catch (e) { return; }
  renderRecents(Array.isArray(entries) ? entries : []);
}

/* ---- deciding whether to show it, at boot ----

   The same "must never appear over a document that is about to open"
   rule the first-run wizard's gate follows (20b-onboarding.js), minus
   its once-per-launch conditions: a new tab is a new tab every time.

     - the pristine-seed gate (invariant #30) — the document on screen is
       the shipped demo and nothing else;
     - no hosted document, and no file adopted this load;
     - desktop: the tab's own launchIntent says 'blank' and there is no
       crash draft coming (TAB-BOOT-SYNC);
     - browser: no remembered file handle, which is the one thing
       tryResumeLastProject() (21-events.js) may still be about to reopen
       or offer to reopen. */
async function newTabEligibleForAutoShow() {
  if (newTabSuppressed()) return false;
  if (!seedCheckPasses()) return false;
  if (S.DESKTOP && typeof draftRestorePending !== "undefined" && draftRestorePending) return false;
  if (home.kind === "server" || home.kind === "file") return false;
  if (S.DESKTOP) {
    if ((S.DESKTOP.launchIntent && S.DESKTOP.launchIntent.type !== "blank") ||
        S.DESKTOP.hasDraftToRestore) return false;
  } else {
    var handle;
    try { handle = await loadLastFileHandle(); } catch (e) { handle = null; }
    if (handle) return false;
  }
  /* Re-check what the round trip above gave a file time to change. */
  if (home.kind !== "none") return false;
  return true;
}

async function maybeAutoShowNewTabPage() {
  var eligible;
  try { eligible = await newTabEligibleForAutoShow(); } catch (e) { eligible = false; }
  if (eligible) openNewTabPage();
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  (function wireNewTabPage() {
    var el = newTabPageEl();
    if (!el) return;
    el.addEventListener("click", function (e) {
      var target = e.target.closest("[data-newtab-action]");
      if (!target) return;
      e.preventDefault();
      var action = target.getAttribute("data-newtab-action");
      if (action === "new") startBlankScript();
      else if (action === "open") newTabOpenFile();
      else if (action === "dismiss") closeNewTabPage();
      else if (action === "open-recent") openRecent(target.getAttribute("data-file-id"));
      else if (action === "forget-recent") forgetRecent(target.getAttribute("data-file-id"));
      else if (action === "clear-recents") clearRecents();
    });
  })();

  maybeAutoShowNewTabPage();

  /* ---- test hook ----
     Same trick as window.__onboarding: the gate and the blank document are
     what a headless suite has to drive, and neither has a UI affordance
     that can be clicked into existence on demand. Nothing in the app reads
     this. */
  window.__newTab = {
    open: openNewTabPage,
    close: closeNewTabPage,
    isOpen: function () { return newTabPageShown; },
    eligible: newTabEligibleForAutoShow,
    blank: startBlankScript,
    blankState: blankDocumentState,
    /* The recents column (issue #15). Desktop-only and driven by IPC, so a
       browser suite reaches it through __desktopTest's fake backend. */
    refreshRecents: refreshRecents,
    openRecent: openRecent
  };
}
