import { S } from "./_state.js";
import { home, setHome } from "./_home.js";
import { SCHEMA_VERSION, loadLastFileHandle } from "./00-prelude.js";
import { DEFAULT_WPM, formatDuration, wordCount } from "./01-scene-status.js";
import { escapeHtml, makeId, migrateRows } from "./02-state.js";
import { syncDocIdentity } from "./02b-doc-id.js";
import { cloneState, setBaseState, updateIdentityChip } from "./03-sync.js";
import { render } from "./05-render.js";
import { resetProductionPanelState } from "./07-production-tags.js";
import { showTaggingHelp } from "./10-comments.js";
import { openGdocModal, openImportModal } from "./11-import.js";
import { clearDirty, showToast, updateSaveStatus } from "./12-dirty-toast.js";
import { fileKindFromName, openLocalFile, openProjectFile, updateFileChip } from "./18-local-files.js";
import { desktopAppUrl } from "./20a-update.js";
import { seedCheckPasses } from "./20b-onboarding.js";
import { startTour } from "./20c-help.js";
import { openServersDialog } from "./20e-connect.js";
import { makeDesktopHandle, notifyDesktopDocumentState } from "./20f-desktop.js";
import { draftRestorePending } from "./20g-drafts.js";
import { STARTERS, starterById } from "./_starters.js";

/* ================= the New Tab page =================

   A new desktop tab (and a fresh copy of the app in the browser) used to
   land on the seeded demo document, so the first thing anyone did was
   clear out somebody else's example script or go hunting through the File
   drawer for Open. This page is where a new tab starts instead — since
   issue #144 a start screen: a blank script or one of three starter
   scripts, the recent documents on desktop, a drop zone, and the file
   picker and the shared-session dialog one click away in its own top bar.
   Since #169 it is Direction B's "On air" page (board B-StartOnAir): a
   band with the programme clock at 00:00, a tally lamp and "New script",
   and on desktop the most recent script with a Continue button.

   WHAT IT IS NOT: a modal. It is an opaque full-page layer at z-index
   130 — above the topbar (120), below the side panels (140), the modals
   (150) and the tour (160) — so the first-run wizard still shows over it
   on a genuinely first run, and so nothing here can swallow a dialog.
   The Servers dialog and the paste modal this page opens sit over it the
   same way, and Esc belongs to them while they are up.

   WHAT IT DOES NOT TOUCH: the document. Showing the page changes no
   state at all; the demo is still underneath, which is why "Look at the
   example script instead" (and Esc) can simply dismiss it — and why the
   tour and the tagging cheat sheet dismiss it too, since both are about
   that example. Only a card replaces the document, and with a NEW one: a
   blank is one empty scene with no tags, no comments, no b-roll; a starter
   is a copy of one of the documents in src/starters/ (_starters.js). Both
   get a fresh identity, no home and nothing to save — exactly what the
   blank has always been — never a filtered copy of the seed.

   THE RECENT COLUMN (issue #15) is recently-opened documents, and it is
   DESKTOP ONLY. The list is kept by the main process in
   desktop-state.json (contract DESKTOP-RECENTS) because that is the only
   side that can hold a durable reference to a file: the browser build
   remembers exactly one handle, and can only reopen one it still has
   permission for. So in the browser this column stays hidden, and so
   does the band's Continue row — which in the browser could never have
   anything to show anyway, because a remembered handle is exactly what
   keeps this page from showing itself there (the gate at the bottom).

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
  /* The page scrolls itself; the demo underneath must not show a second
     scroll bar beside it, or scroll under a wheel that missed the page. */
  document.documentElement.classList.add("is-newtab-open");
  updateDesktopPitch();
  document.addEventListener("keydown", onNewTabKeydown, true);
  var first = el.querySelector('[data-newtab-action="new"]');
  if (first) first.focus();
  /* Asked for every time the page is shown rather than cached: another
     tab (or another window) may have opened something since, and main is
     the only authority on the list. Not awaited — the cards must not
     wait on IPC to become clickable. */
  refreshRecents();
}

export function closeNewTabPage() {
  var el = newTabPageEl();
  if (!newTabPageShown) return;
  newTabPageShown = false;
  if (el) el.hidden = true;
  document.documentElement.classList.remove("is-newtab-open");
  setDropHover(false);
  document.removeEventListener("keydown", onNewTabKeydown, true);
}

/* Esc is the page's own "not now" — unless something opened over it has
   the keyboard: the paste modal, the Servers dialog, the first-run wizard,
   Help. Those are all .modal-backdrop, and each closes on its own Esc
   listener further out; swallowing the key here (capture, on document)
   would leave the dialog up and take the page down from under it. */
function onNewTabKeydown(e) {
  if (e.key !== "Escape") return;
  if (document.querySelector(".modal-backdrop:not([hidden]), #tour-overlay:not([hidden])")) return;
  e.stopPropagation();
  e.preventDefault();
  closeNewTabPage();
}

/* ---- a new document: Blank script, a starter, a paste ----

   migrateRows fills in every list the document carries (comments,
   productionTags, people, brollShots, wordsPerMinute) and mints a fresh
   docId, so building the blank from its two required fields is enough —
   and is the only way to be sure nothing of the seed survives. */
function blankDocumentState() {
  return migrateRows({
    title: "Untitled Script",
    rows: [{ id: makeId("r"), visualText: "", imageRef: null, audioText: "" }]
  });
}

/* A starter is stored already migrated (_starters.js), so this is a copy
   of it plus the one thing migration adds: an identity of its own. The
   copy is deep because migrateRows works in place, and the bundled
   original is what the next click on the same card copies again. */
function starterDocumentState(id) {
  var starter = starterById(id);
  return starter ? migrateRows(JSON.parse(JSON.stringify(starter.state))) : null;
}

/* The one way a card replaces the document.

   Not dirty, and editSeq untouched: a new document nobody has typed into
   yet is exactly what isPristineSeedDocument() (03a-history-store.js)
   means by pristine, which is what lets the desktop shell keep routing an
   open into this tab and keep closing it without a prompt — a starter no
   one has touched is as easy to get back as a blank is.

   And no home, nothing unsaved. The page only ever shows itself over a
   clean document with no home (the gate below), but a new document has
   no file to save back into whatever was on screen before it, and nothing
   of its own to save yet — so a file or import home, and a dirty flag and
   the autosave it would arm, are let go of here rather than trusted to be
   absent. */
function adoptNewDocument(next, reason) {
  S.state = next;
  setBaseState(cloneState(S.state), reason);
  /* This id has never left this page, so a first Save can take it with it
     rather than forking a new one (02b-doc-id.js). */
  S.docIdWrittenOut = false;
  if (home.kind === "file" || home.kind === "import") setHome("none");
  clearDirty();
  resetProductionPanelState();
  render();
  updateFileChip();
  updateIdentityChip();
  updateSaveStatus();
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  closeNewTabPage();
}

function startNewDocument(makeState, reason) {
  /* Clicked before loadInitialState() resolved: assigning `state` now
     would just be overwritten when the boot load lands (the same race
     20f-desktop.js's open handlers wait out). */
  if (!S.state && S.initialStateReady) {
    return S.initialStateReady.then(function () { return startNewDocument(makeState, reason); });
  }
  var next = makeState();
  if (!next) return Promise.resolve(false);
  adoptNewDocument(next, reason);
  return Promise.resolve(true);
}

function startBlankScript() {
  return startNewDocument(blankDocumentState, "startBlankScript: a new blank document");
}

function startStarterScript(id) {
  return startNewDocument(function () { return starterDocumentState(id); },
    "startStarterScript: a new document from the " + id + " starter");
}

/* "paste one": the ordinary import modal, in the mode where what it
   imports becomes a new document (11-import.js) rather than rows added to
   the demo underneath. Cancelled, it leaves this page exactly as it was.
   `rows` arrive as the import builds them — HTML already, which is why the
   schema is stamped current, as loadFileIntoEditor (18-local-files.js)
   does for the same rows. The import then runs its scans over them,
   marks the document dirty (a pasted script is on no disk yet) and says
   how many rows came in. */
function openPasteAsNewDocument() {
  openImportModal({
    intoNewDocument: function (rows) {
      adoptNewDocument(migrateRows({ schema: SCHEMA_VERSION, title: "Untitled Script", rows: rows }),
        "newtab paste: a new document from pasted text");
    }
  });
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

/* ---- the drop zone ----

   A dropped file opens the way the file input behind "Open a file" opens
   one (21-events.js's #open-file-input listener): openProjectFile with no
   handle, which reads a project file as a project and anything else as a
   new document, and closes this page when it lands. No handle means Save
   asks where to put it — a dropped File carries no permission to write
   back, and on desktop the renderer never learns its path (invariant
   #34). The whole page takes the drop, not just the zone, so a file let go
   of a little off target is not the browser navigating away to show it. */
function isFileDrag(e) {
  var types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  for (var i = 0; i < types.length; i++) if (types[i] === "Files") return true;
  return false;
}

function setDropHover(on) {
  var zone = document.getElementById("newtab-drop");
  if (zone) zone.classList.toggle("is-over", !!on);
}

function newTabOpenDropped(file) {
  if (!file) return Promise.resolve(false);
  if (!fileKindFromName(file.name)) {
    showToast("Splitpage opens .md, .splitpage, .docx, .txt and .csv files — " +
      file.name + " isn't one of them.", "warn");
    return Promise.resolve(false);
  }
  return openProjectFile(file, null);
}

/* ---- the starter cards ----

   Built from STARTERS once, at boot, after the Blank script card that is
   written into page.html. Each is drawn the way Direction B draws any
   script (#169, board B-StartOnAir): the document it opens and how many
   scenes it has, then its rundown in miniature — a block per scene, sized
   by read time the way the editor's rundown strip sizes them — and its
   running time. Worked out from the starter's own rows at its own reading
   speed, so the picture stays true if a starter is rewritten. */
function starterSceneSeconds(state) {
  var wpm = state.wordsPerMinute || DEFAULT_WPM;
  return state.rows.map(function (row) { return wordCount(row.audioText) / wpm * 60; });
}

function starterPreviewHtml(state) {
  var secs = starterSceneSeconds(state);
  var total = secs.reduce(function (n, s) { return n + s; }, 0);
  /* Whole seconds as flex weights, with a floor of one so a scene with no
     words yet is still a block rather than a gap. */
  return '<span class="newtab-preview" aria-hidden="true">' +
    '<span class="newtab-preview-bar">' + secs.map(function (s) {
      return '<i style="flex-grow:' + Math.max(1, Math.round(s)) + '"></i>';
    }).join("") + '</span>' +
    '<span class="newtab-preview-time">' + escapeHtml(formatDuration(total)) + '</span>' +
  '</span>';
}

function renderStarterCards() {
  var cards = document.getElementById("newtab-cards");
  if (!cards || cards.querySelector('[data-newtab-action="starter"]')) return;
  cards.insertAdjacentHTML("beforeend", STARTERS.map(function (s) {
    var scenes = s.state.rows.length;
    return '<button type="button" class="newtab-card" data-newtab-action="starter" data-starter="' + escapeHtml(s.id) + '">' +
      '<strong class="newtab-card-name">' + escapeHtml(s.name) + '</strong>' +
      '<span class="newtab-card-desc">' + escapeHtml(s.desc) + '</span>' +
      '<span class="newtab-card-meta">' +
        '<span class="newtab-card-doc">' + escapeHtml(s.state.title) + '</span>' +
        '<span aria-hidden="true">·</span>' +
        '<span class="newtab-card-count">' + scenes + (scenes === 1 ? ' scene' : ' scenes') + '</span>' +
      '</span>' +
      starterPreviewHtml(s.state) +
    '</button>';
  }).join(""));
}

/* ---- the footer's desktop-app line: browser build only ----
   Asked on every show (and with the recents, which ask the bridge anyway)
   rather than once at boot: the desktop bridge is there before any script
   runs in the real app, but a suite installs __desktopTest's fake one
   later, and the link target can arrive with an update status after
   boot. */
function updateDesktopPitch() {
  var pitch = document.getElementById("newtab-desktop");
  if (!pitch) return;
  pitch.hidden = !!S.DESKTOP;
  var link = document.getElementById("newtab-desktop-link");
  if (link && !S.DESKTOP) link.href = desktopAppUrl();
}

/* ---- the recent-documents column (DESKTOP-RECENTS) ---- */

function recentsSupported() {
  return !!(S.DESKTOP && typeof S.DESKTOP.listRecents === "function");
}

/* "2 h ago", "Yesterday", then a date — "12 Sep" on the board (#169),
   in the locale's order. Each is a label of its own, so sentence case
   starts it. The day and short month rather than a numeric date, which
   most locales write with slashes — on a list that promises to show no
   paths (invariant #34), and that suite 36 checks for a "/". */
function formatRecentWhen(at) {
  if (!at) return "";
  var mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + " min ago";
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + " h ago";
  var days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return days + " days ago";
  var d = new Date(at);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear()
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

/* The band's Continue row: the most recent entry, or nothing. Its button
   carries the same data-newtab-action and fileId a Recent row's does, so
   it opens through openRecent below and says the same thing when the file
   has gone. The line under the heading ("…or carry on where you left
   off") shows only while there is something to carry on with. */
function renderContinue(entry) {
  var row = document.getElementById("newtab-continue");
  var sub = document.querySelector("#newtab-page .newtab-sub");
  var btn = document.getElementById("newtab-continue-btn");
  if (!row || !btn) return;
  var has = !!(entry && entry.fileId);
  row.hidden = !has;
  if (sub) sub.hidden = !has;
  if (!has) { btn.setAttribute("data-file-id", ""); return; }
  var title = entry.title || entry.name;
  document.getElementById("newtab-continue-title").textContent = title;
  document.getElementById("newtab-continue-when").textContent = formatRecentWhen(entry.at);
  btn.setAttribute("data-file-id", entry.fileId);
  btn.setAttribute("aria-label", "Continue " + title);
  btn.title = entry.name;
}

function renderRecents(entries) {
  var col = document.getElementById("newtab-recents");
  var list = document.getElementById("newtab-recents-list");
  var main = document.querySelector("#newtab-page .newtab-main");
  if (!col || !list) return;
  /* The column itself stays once it is up, empty list and all: "Recent
     (nothing yet)" is a truthful answer, and a column that appears and
     disappears under the pointer as the last entry is forgotten is not.
     The band's Continue row does go with the last entry: it offers one
     script, and there is none. */
  col.hidden = false;
  if (main) main.classList.add("has-recents");
  renderContinue(entries[0] || null);
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
        '<svg class="nt-icon newtab-recent-icon" aria-hidden="true"><use href="#i-file"/></svg>' +
        '<span class="newtab-recent-text">' +
          '<span class="newtab-recent-title">' + escapeHtml(title) + '</span>' +
          '<span class="newtab-recent-meta"><span class="newtab-recent-name">' + escapeHtml(r.name) + '</span></span>' +
        '</span>' +
        (when ? '<span class="newtab-recent-when">' + escapeHtml(when) + '</span>' : '') +
      '</button>' +
      '<button type="button" class="newtab-recent-forget" data-newtab-action="forget-recent" ' +
        'data-file-id="' + escapeHtml(r.fileId) + '" title="Forget this one" ' +
        'aria-label="Forget ' + escapeHtml(title) + '">' +
        '<svg class="nt-icon" aria-hidden="true"><use href="#i-close"/></svg></button>' +
    '</div>';
  }).join("");
}

async function refreshRecents() {
  updateDesktopPitch();
  if (!recentsSupported()) { renderContinue(null); return; }
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
    renderStarterCards();
    el.addEventListener("click", function (e) {
      var target = e.target.closest("[data-newtab-action]");
      if (!target) return;
      var action = target.getAttribute("data-newtab-action");
      e.preventDefault();
      if (action === "new") startBlankScript();
      else if (action === "starter") startStarterScript(target.getAttribute("data-starter"));
      else if (action === "open") newTabOpenFile();
      else if (action === "join") openServersDialog();                 /* 20e-connect.js */
      else if (action === "paste") openPasteAsNewDocument();
      else if (action === "gdoc") openGdocModal();                     /* 11-import.js */
      else if (action === "dismiss") closeNewTabPage();
      /* The tour and the cheat sheet are both about the example script,
         so they take the page down to show it. */
      else if (action === "tour") { closeNewTabPage(); startTour(); }  /* 20c-help.js */
      else if (action === "tagging-help") { closeNewTabPage(); showTaggingHelp(); } /* 10-comments.js */
      else if (action === "open-recent") openRecent(target.getAttribute("data-file-id"));
      else if (action === "forget-recent") forgetRecent(target.getAttribute("data-file-id"));
      else if (action === "clear-recents") clearRecents();
    });

    el.addEventListener("dragover", function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (err) {}
      setDropHover(true);
    });
    el.addEventListener("dragleave", function (e) {
      /* Fired for every child crossed; only leaving the page itself counts. */
      if (!e.relatedTarget || !el.contains(e.relatedTarget)) setDropHover(false);
    });
    el.addEventListener("drop", function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDropHover(false);
      newTabOpenDropped(e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  })();

  maybeAutoShowNewTabPage();

  /* ---- test hook ----
     Same trick as window.__onboarding: the gate and the new documents are
     what a headless suite has to drive, and neither has a UI affordance
     that can be clicked into existence on demand. Nothing in the app reads
     this. */
  window.__newTab = {
    open: openNewTabPage,
    isOpen: function () { return newTabPageShown; },
    eligible: newTabEligibleForAutoShow,
    blankState: blankDocumentState,
    /* The starters (issue #144): their ids in card order, and a fresh
       document built from one exactly as its card builds it. */
    starterIds: function () { return STARTERS.map(function (s) { return s.id; }); },
    starterState: starterDocumentState,
    /* The recents column (issue #15). Desktop-only and driven by IPC, so a
       browser suite reaches it through __desktopTest's fake backend. */
    refreshRecents: refreshRecents
  };
}
