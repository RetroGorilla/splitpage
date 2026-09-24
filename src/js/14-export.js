import { S } from "./_state.js";
import { writePref } from "./00p-prefs.js";
import { fileHome, home, restoreHome, setHome } from "./_home.js";
import { rememberLastFileHandle } from "./00-prelude.js";
import { formatDuration, totalSeconds } from "./01-scene-status.js";
import { migrateRows } from "./02-state.js";
import {
  copyDocHistorySafe,
  mintDocId,
  normalizeDocId,
  syncDocIdentity
} from "./02b-doc-id.js";
import {
  ensureBytes,
  has as hasBlob,
  rowImage,
  rowImageBytes,
  rowImageDataUrl,
  rowImageKey
} from "./02c-blobs.js";
import { morePictureRefs, pictureBytes, rowVideoLinks, videoLinkLabel } from "./02d-gallery.js";
import { refsIn } from "../../shared/blob-policy.js";
import {
  RELOAD_GUARD_KEY,
  acceptStash,
  applyMerge,
  clearStash,
  cloneState,
  getEditorName,
  readStash,
  setBaseState
} from "./03-sync.js";
import { htmlToMarkdown, inertBody } from "./04-richtext.js";
import { cellOf, toMarkdown } from "./04c-doc-model.js";
import { pad2 } from "./05-render.js";
import { breakdownRows } from "./08-production-panels.js";
import { commentBodyText, commentEntries, nowIso } from "./10-comments.js";
import {
  clearDirty,
  noteSaveStatus,
  setSaveButtons,
  showToast,
  updateSaveStatus
} from "./12-dirty-toast.js";
import {
  SERVER_RESUME_KEY,
  onServerDoc,
  saveToServer,
  serverSessionExpired
} from "./13-hosted.js";
import {
  checkFileConflict,
  deliverFile,
  fileKindFromName,
  showFileConflict,
  updateFileChip
} from "./18-local-files.js";
import { buildMarkdownProject, buildSplitpageFile, fileImagesMissing } from "./20d-formats.js";
import { makeDesktopHandle } from "./20f-desktop.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
export var autoSaveEnabled;

/* ================= save / export ================= */

export async function saveDoc(opts) {
  opts = opts || {};
  var saveAs = !!opts.saveAs;
  /* An automatic save writes exactly what a manual one writes; what it
     must not do is talk over the typing that triggered it. So the "Saved
     to …" toast is left to the save the user asked for, and the failures
     that would otherwise repeat every couple of seconds — a rejected
     write, a file changed on disk — halt autosave instead, with the
     reason kept for the indicator beside the Save button. */
  var auto = !!opts.auto;
  /* Pressing Save is the user saying they have dealt with whatever stopped
     autosave; from here the automatic writes are welcome again. */
  if (!auto) resumeAutoSave();
  /* A Save As makes a second file. If this document's id has already been
     written somewhere (a file, a server, a draft), both files would carry
     it and share one version history, so the copy gets a new id. An id
     that never left the page just travels with its first save. Decided on
     opts.saveAs, not the local `saveAs` below: a legacy .html converting to
     .md on its first Save is the same document moving house, not a copy. */
  var forkDocId = (opts.saveAs && S.docIdWrittenOut) ? mintDocId() : null;
  /* Which document this save belongs to. Every await below (the native
     dialog above all — main keeps serving a double-click in Explorer while
     it is up) can end with a different document on screen, and nothing
     that follows may re-id, retarget or mark clean THAT one on this save's
     behalf. Same check as publishToServer's `state.docId === oldId`. */
  var docIdAtSave = S.state.docId;
  /* A fresh pick retargets Save only if the write lands. Otherwise the next
     plain Save would quietly reuse a file that never got this document —
     and, after a Save As whose fork was thrown away with the failed write,
     put the already-used id into a second file (invariant #36). */
  var prevHome = null;
  var retarget = null;
  /* The home a fresh pick was made for: the new file home, or — for a Save
     As from a hosted document — the server home it leaves alone. Only
     while that is still the home is the picked file remembered for the
     next launch (rememberLastFileHandle, below). */
  var pickedFor = null;
  var wrote = false;
  function retargetTo(handle, k) {
    if (S.state.docId !== docIdAtSave) return;
    /* A Save As from a hosted document takes a copy home while the page
       stays on the server document (adoptSavedCopyDocId below), so the
       copy is a file on disk and not this document's home. It used to be
       one anyway, half-set: a project file underneath the server document,
       invisible until the server side was cleared, when Save would start
       writing into the copy without asking (#73). */
    if (home.kind === "server") { pickedFor = home; return; }
    prevHome = home;
    retarget = setHome("file", { handle: handle, format: k, name: handle.name });
    pickedFor = retarget;
    /* A document imported from a .docx/.csv/.txt that is saved as a
       project moves home: the file chip and "Save to <name>" were about
       the import, and follow it out (18-local-files.js). */
    if (prevHome.kind === "import") updateFileChip();
  }
  function undoRetarget() {
    if (retarget && !wrote && home === retarget) {
      restoreHome(prevHome);
      if (prevHome.kind === "import") updateFileChip();
    }
    retarget = null;
  }
  S.saveButtonBusy = true;
  setSaveButtons("Saving…", true);

  /* A hosted document saves to the server, not to disk. "Save As" still
     means "give me a local copy of this", so it deliberately falls through
     to the file path below even when a server document is open — that is
     how you take a script home, or fork one. */
  if (onServerDoc() && !saveAs) {
    try {
      /* A hosted save that did not go through (a read-only server, a
         lapsed sign-in, a document someone deleted) would not go through
         in two seconds either, and saveToServer has already said so once.
         Same rule as the file path's failures below. */
      var sentToServer = await saveToServer();
      if (auto && sentToServer === false) {
        haltAutoSave("Autosave is paused — the last save to the server did not go through. " +
                     "Press Save to try again.");
      }
    } finally {
      S.saveButtonBusy = false;
      setSaveButtons(S.dirty ? "Save •" : "Save", false);
    }
    return;
  }

  /* A project opened from a legacy .html file is never written back as
     HTML — the page stopped being a document format when .md and
     .splitpage arrived (HANDOFF §3.1). The first Save after opening one
     behaves as Save As, defaulting to <slug>.md, and says why. */
  var converting = !saveAs && home.kind === "file" && home.format === "html";
  if (converting) {
    saveAs = true;
    showToast("Older .html projects are saved as Markdown from now on — choose where to keep it.", "ok");
  }

  /* Freeze exactly what we save. `state` keeps mutating while the write is
     in flight, so re-cloning here means edits typed during the save aren't
     silently included as if they'd already been saved. */
  S.state.rev = (S.state.rev || 0) + 1;
  S.state.lastEditedBy = getEditorName();
  S.state.lastEditedAt = nowIso();
  var published = cloneState(S.state);
  /* the bytes carry the fork's id; `state` adopts it only once the write
     has succeeded (adoptSavedCopyDocId), so a cancelled dialog or a failed
     write leaves this document's identity exactly as it was */
  if (forkDocId) published.docId = forkDocId;
  var seqAtSave = S.editSeq;
  var slug = slugify(published.title);
  /* Save As always asks where to write, ignoring any file we already have.
     Plain Save reuses that file once one exists, and only asks the first
     time it has none. Either way, a fresh pick becomes the file future
     plain Saves write to — once the write to it has succeeded
     (retargetTo/undoRetarget above). */
  var targetHandle = saveAs || !fileHome() ? null : fileHome().handle;
  /* Which serializer runs is decided by the file, not by a preference —
     and for a fresh pick that cannot be known until the picker has come
     back with the name the user typed. */
  var kind = saveAs ? "md" : ((fileHome() && fileHome().format) || "md");

  /* Was this the same file we already had open, with a fresh-pick not
     needed? Then the on-disk-conflict check below applies — a brand new
     pick from the Save As dialog has no prior baseline to compare against
     (checkFileConflict skips it when lastModified is unset), and a picked
     file that happens to already exist is a deliberate replace through
     the OS's own picker, not "changed under us". */
  var reusingHandle = !!targetHandle;

  try {
    /* Desktop has no File System Access API at all (it is a Chromium
       feature, not something Electron's renderer gets for free), and a
       native Save dialog is the whole point of running as a real app —
       DESKTOP.saveFileDialog() is checked first so it is never shadowed
       by the browser branch below, which stays exactly as it was for the
       web build. A cancelled native dialog resolves null, same shape as
       the picker's AbortError just below: restore the rev bump, no error
       toast, nothing written. */
    if (!targetHandle && S.DESKTOP) {
      var pickedDesktop = await S.DESKTOP.saveFileDialog({
        suggestedName: slug + ".md",
        filters: [
          { name: "Markdown script", extensions: ["md"] },
          { name: "Splitpage script", extensions: ["splitpage"] }
        ]
      });
      if (!pickedDesktop) {
        S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
        S.saveButtonBusy = false;
        setSaveButtons(S.dirty ? "Save •" : "Save", false);
        return;
      }
      targetHandle = makeDesktopHandle(pickedDesktop);
      kind = fileKindFromName(pickedDesktop.name) === "splitpage" ? "splitpage" : "md";
      retargetTo(targetHandle, kind);
    } else if (!targetHandle && window.showSaveFilePicker) {
      targetHandle = await window.showSaveFilePicker({
        suggestedName: slug + ".md",
        types: [
          { description: "Markdown script", accept: { "text/markdown": [".md"] } },
          { description: "Splitpage script", accept: { "application/json": [".splitpage"] } }
        ]
      });
      kind = fileKindFromName(targetHandle.name) === "splitpage" ? "splitpage" : "md";
      retargetTo(targetHandle, kind);
    }

    /* On-disk conflict check (HANDOFF #1, same guard as the import
       re-save path's saveBackToFile) — only when writing back into the
       file we already had open, and not when opts.force says the user
       just chose "Overwrite it" in that modal. */
    if (reusingHandle && !opts.force) {
      var check = await checkFileConflict(targetHandle, home.lastModified);
      if (!check.ok) {
        /* Nobody asked for this write, so it does not get to throw a modal
           over the sentence being typed. Autosave stops until a manual
           Save, which shows the same conflict modal and offers the same
           choices — the indicator says why in the meantime. */
        if (auto) haltAutoSave("Autosave is paused — " + targetHandle.name +
                               " changed on disk since it was opened. Press Save to sort it out.");
        else showFileConflict(targetHandle.name, check.current, { kind: "project" });
        S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
        S.saveButtonBusy = false;
        setSaveButtons(S.dirty ? "Save •" : "Save", false);
        return;
      }
    }

    /* The file carries its pictures inline (#82 D1/D2), so their bytes
       have to be in this page first — fetched from the blob store (or the
       server) when they are not. One nobody has goes into the file as a
       ref with no picture, and the user is told once the write lands. */
    await ensureBytes(refsIn(published));
    var imagesLeftOut = fileImagesMissing(published).length;

    var filename = slug + (kind === "splitpage" ? ".splitpage" : ".md");
    var body;
    try {
      body = kind === "splitpage" ? buildSplitpageFile(published) : buildMarkdownProject(published);
    } catch (e) {
      showToast("Could not prepare the file to save.", "error");
      S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
      /* before setSaveButtons, whose identity sync would otherwise adopt
         the never-written file as this document's home for a moment */
      undoRetarget();
      S.saveButtonBusy = false;
      setSaveButtons(S.dirty ? "Save •" : "Save", false);
      return;
    }

    if (targetHandle) {
      var writable = await targetHandle.createWritable();
      await writable.write(body);
      await writable.close();
      wrote = true;
      /* Re-checked here, after the awaits, not assumed (see docIdAtSave).
         If another document took over, the copy is still written — the
         user asked for it — but it stays just a file on disk. */
      var stillOurs = S.state.docId === docIdAtSave;
      var homeAtWrite = fileHome() && fileHome().handle === targetHandle ? home : null;
      if (stillOurs) setBaseState(published, "saveDoc: the bytes just written to the file");
      if (pickedFor && home === pickedFor) rememberLastFileHandle(targetHandle);
      adoptSavedCopyDocId(forkDocId, docIdAtSave);
      var docIdAfterSave = S.state.docId;
      /* What this file now says the document is — the ancestor a later
         "Merge them" measures both sides against (18a-local-merge.js).
         Set beside lastModified because the two are one fact: the state
         and the timestamp of the bytes that are on disk right now. */
      if (homeAtWrite && stillOurs) homeAtWrite.diskBase = published;
      try {
        var afterFile = await targetHandle.getFile();
        if (homeAtWrite && home === homeAtWrite) homeAtWrite.lastModified = afterFile.lastModified;
      } catch (e) { /* not fatal — the write already succeeded */ }
      if (stillOurs && S.state.docId === docIdAfterSave && S.editSeq === seqAtSave) clearDirty();
      /* An automatic save says so through the indicator, not a toast (see
         `auto` at the top): one "Saved to script.md" per pause in the
         typing is noise sitting on top of the work. */
      if (!auto) showToast((saveAs ? "Saved a new copy: " : "Saved to ") + targetHandle.name, "ok");
      else noteSaveStatus("Saved to " + targetHandle.name);
      warnImagesLeftOut(imagesLeftOut, targetHandle.name);
    } else {
      /* no File System Access API (e.g. Firefox) — a plain download is the
         best this browser can do; the user re-opens the newest copy next
         time. Same bytes, same extension as the in-place write above. */
      var ok = await deliverFile(filename, body, { savedMsg: "Downloaded " + filename });
      if (ok) {
        wrote = true;
        var downloadedOurs = S.state.docId === docIdAtSave;
        if (downloadedOurs) setBaseState(published, "saveDoc: the copy just downloaded");
        adoptSavedCopyDocId(forkDocId, docIdAtSave);
        if (downloadedOurs && S.editSeq === seqAtSave) clearDirty();
        warnImagesLeftOut(imagesLeftOut, filename);
      } else {
        S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
      }
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
    } else {
      var why = err && err.message ? err.message : "please try again";
      showToast("Could not save — " + why + ".", "error");
      /* Toasted once, then no more: an automatic save that cannot write
         (a locked file, a full disk, a revoked permission) would fail
         again in two seconds, and in two after that. */
      if (auto) haltAutoSave("Autosave is paused — the last save failed (" + why + "). Press Save to try again.");
      S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
    }
  } finally {
    /* any failure after a fresh pick: a createWritable/write/close that
       rejects (a OneDrive lock, Controlled Folder Access, a failed IPC
       write). Undone before setSaveButtons syncs identity. */
    undoRetarget();
    S.saveButtonBusy = false;
    setSaveButtons(S.dirty ? "Save •" : "Save", false);
  }
}

/* A written file that could not carry every picture: its bytes were
   nowhere to be had (a version restored after its image was lost, say).
   The row keeps naming the picture, so nothing is deleted — but the file
   does not show it, and the user should know before sending it on. */
export function warnImagesLeftOut(n, name) {
  if (!n) return;
  showToast(n + (n === 1 ? " image" : " images") + " could not be included in " + name +
    " — the picture" + (n === 1 ? " was" : "s were") + " not available on this computer.", "warn");
}

/* The one place a Save As fork becomes this document's identity (DOCID-API).
   Called only after the bytes are safely written, and before clearDirty(),
   so a cancelled dialog or a failed write never leaves history copied under
   an id no file carries. The copy just written IS the document on screen
   from now on — plain Save writes to it — so the view follows it to the
   new id and takes its history along.

   A server document is the exception: Save As there takes a copy home
   while the page stays on the server document (saveDoc's comment above),
   so the page keeps the server's id; only the file carries the fork.

   Marks the id as written out and re-syncs identity, fork or not, because
   every successful save or download means this id is now on disk
   somewhere.

   `docIdAtSave` is the id the saved document had when saveDoc froze it.
   If the page has moved on to a different document during the save's
   awaits, that document is left exactly as it is: re-iding it would give
   it an id its own file does not carry, and copy ITS history under the
   id of someone else's new file. The fork's history still comes from
   docIdAtSave — the file just written carries it, whatever is on screen. */
function adoptSavedCopyDocId(forkDocId, docIdAtSave) {
  forkDocId = normalizeDocId(forkDocId);
  var sameDocument = !!S.state && S.state.docId === docIdAtSave;
  if (forkDocId) {
    if (sameDocument && !onServerDoc()) S.state.docId = forkDocId;
    copyDocHistorySafe(docIdAtSave, forkDocId);
  }
  if (!sameDocument) return;
  S.docIdWrittenOut = true;
  syncDocIdentity();
}

/* Runs on load: if a stash survived, three-way merge it into whatever
   version we just loaded so no local edit is lost.

   `override` is the same {base, mine} shape read from somewhere other than
   sessionStorage — today, a crash draft taken back from disk (20g-drafts.js).
   Everything that belongs to the sessionStorage stash is then skipped: the
   reload guard was never set, SERVER_RESUME_KEY says nothing about a draft
   (a draft of a server document has its own path through resumeServerDoc),
   there is nothing to clear, and the caller has already aligned the two ids
   itself under rules a stash does not have (the docIdEmbedded rule,
   DRAFT-RENDERER-API). The merge below is deliberately identical for both:
   one three-way merge, one "Before merging" snapshot, one undo point.

   `apply` is the rest of applyMerge's options (03-sync.js). Without it this
   function merges and hands the result back for the caller to adopt. With
   it the same applyMerge call finishes the job instead — adopt, base, redraw,
   report — so no caller writes out a second copy of the sequence: the file
   merge (confirmFileMerge, 18a-local-merge.js, #72), the boot stash
   (21-events.js) and the crash-draft file merge (20g-drafts.js, #96), the
   last with `awaitUndoPoint`, which makes the answer a Promise. The early
   answers below (no stash, a server document's stash) never reach
   applyMerge, so they adopt nothing: the caller still holds `loaded`. */
export function applyStashedWork(loaded, override, apply) {
  var stash = override || readStash();
  if (!override) { try { sessionStorage.removeItem(RELOAD_GUARD_KEY); } catch (e) {} }
  if (!stash || !stash.mine || !Array.isArray(stash.mine.rows)) return { state: loaded, report: null, snapshot: null };
  /* the pictures it carries, and an older build's stripped images (#82) */
  acceptStash(stash, loaded);
  /* A stash left by a lapsed hosted session belongs to a document on the
     server, not to the page's own embedded one. Merging it into `loaded`
     here would splice someone's script into a blank default document —
     leave it for resumeServerDoc(), which knows which document it is. */
  if (!override) {
    try {
      if (sessionStorage.getItem(SERVER_RESUME_KEY)) return { state: loaded, report: null, snapshot: null };
    } catch (e) {}

    /* The stash is this same document from before the reload, so it keeps
       its id. Without this copy the equality check just below could never
       hold — `loaded` carries a fresh random id from migrateRows — and an
       unchanged stash would always snapshot, merge, mark the document dirty
       and queue a save for nothing. */
    var stashId = normalizeDocId(stash.mine.docId);
    if (stashId) { loaded.docId = stashId; S.docIdWrittenOut = true; }

    clearStash();
  }
  /* applyMerge speaks in {state, result, snapshot}; this function has
     always answered in {state, report, snapshot} and its callers read that,
     so the two names are reconciled here rather than in three places. */
  function through(extra) {
    var out = applyMerge(Object.assign(
      { theirs: loaded, source: "stash", mergeOnly: !apply }, extra, apply || {}
    ));
    function answer(o) { return { state: o.state, report: o.result, snapshot: o.snapshot }; }
    /* `apply.awaitUndoPoint` makes applyMerge's answer a Promise */
    return out && typeof out.then === "function" ? out.then(answer) : answer(out);
  }

  /* nothing changed under us after all */
  if (JSON.stringify(stash.mine) === JSON.stringify(loaded)) return through({ unchanged: true });

  /* The undo point is captured synchronously and its ticket kept, so it is
     known at once — no reading the store before and after to guess which
     entry is new. Boot never awaits snap.done (state is still null while
     this runs); undoMerge waits for its own backup instead. The explicit
     state means the pristine-seed skip can never drop it. */
  return through({
    base: stash.base || null,
    mine: stash.mine,
    undoPoint: migrateRows(cloneState(loaded))
  });
}

/* ================= autosave =================

   Two ways in, one write path. A discrete action — posting a comment,
   cycling a tag's status, a find-and-replace — calls queueAutoSave() and
   the write goes out at once, because the action is over the moment it is
   made. Typing calls scheduleAutoSave() from markDirty() (the one save
   state funnel, invariant #20) and the write waits for a pause: a save per
   keystroke would serialize and re-write the whole document tens of times
   a sentence.

   Both are gated the same way (the autosave preference, then
   autoSaveTarget below) and both go through
   saveDoc({auto:true}), which writes exactly what a manual Save writes and
   differs only in what it says about it: no "Saved to …" toast per pause
   in the typing — the save-state indicator beside the Save button
   (12-dirty-toast.js) is the feedback, and it is there for manual saves
   too. */
export var AUTOSAVE_KEY = "splitpage-autosave";
/* Quiet enough that typing never waits on a write, short enough that
   walking away from the keyboard means the file is already current. The
   max timer is not reset by further edits, so a long stretch of
   uninterrupted typing still lands regularly — same shape as the crash
   draft writer's timing (20g-drafts.js), a few times slower because this
   one writes the user's own file. */
export var autoSaveTiming = { idle: 2000, hostedIdle: 5000, max: 15000 };

/* Hosted documents wait longer than local ones (#70). With a 2s idle, two
   people typing at once conflict on very nearly every save, and each
   conflict costs a whole-document 409 round trip plus a "Before merging in
   someone else's changes" snapshot against the 50-entry history cap. A
   local file and a crash draft have no one to contend with, so they keep
   the 2s: the only cost there is a write nobody is waiting on. The max
   timer is shared — it bounds how long uninterrupted typing can go
   unsaved, which is the same question whoever else is in the document. */
export function autoSaveIdleFor(target) {
  return target === "server" ? autoSaveTiming.hostedIdle : autoSaveTiming.idle;
}
export var autoSaveIdleTimer = null;
export var autoSaveMaxTimer = null;
/* Why autosave has stopped writing by itself, as a sentence the indicator
   can show. Set when an automatic save fails or finds the file changed on
   disk: retrying every two seconds would either spam the same failure or
   re-open the same modal over the typing. A manual Save clears it — that
   is the user saying they have dealt with it. */
export var autoSaveHalt = "";

function readAutoSavePref() {
  try { return localStorage.getItem(AUTOSAVE_KEY) !== "0"; } catch (e) { return true; }
}

/* Where an automatic save would go, or null if it would have to ask first.
   The whole point of the gate: a save that pops the native file dialog, or
   silently downloads a copy, must never happen because someone typed a
   word. A hosted document always has somewhere to go, so autosave is live
   there from the first edit. */
export function autoSaveTarget() {
  if (serverSessionExpired) return null;
  if (onServerDoc()) return "server";
  /* No file established yet — wait for an explicit Save. The dirty
     indicator and the unload guard cover the user in the meantime; once a
     file handle exists (from a manual Save, or from opening a project),
     later edits save into it silently. */
  var file = fileHome();
  if (!file || !file.handle) return null;
  /* A legacy .html project's next save opens a picker (see saveDoc) —
     exactly the ambush this gate exists to prevent. */
  if (file.format === "html") return null;
  return "file";
}

/* Exported for Settings (#181), which sets it rather than toggling it. */
export function setAutoSaveEnabled(on) {
  autoSaveEnabled = !!on;
  /* stored and announced, so Settings (#181) follows the File menu's switch */
  writePref(AUTOSAVE_KEY, autoSaveEnabled ? "1" : "0");
  if (!autoSaveEnabled) clearAutoSaveTimers();
  else if (S.dirty) scheduleAutoSave();
  updateAutoSaveMenu();
  updateSaveStatus();
}

export function toggleAutoSave() {
  setAutoSaveEnabled(!autoSaveEnabled);
  showToast(autoSaveEnabled
    ? "Autosave is on — edits go to the file you saved to, a moment after you stop typing."
    : "Autosave is off — your changes are only written when you press Save.", "ok");
}

/* The menu entry is a switch (#145): its position says what is on, which a
   verb in a menu of verbs could not — "Autosave" beside a switch that is
   on cannot be misread as a command to turn it on. */
export function updateAutoSaveMenu() {
  var item = document.getElementById("menu-autosave");
  if (!item) return;
  item.setAttribute("aria-checked", autoSaveEnabled ? "true" : "false");
  item.classList.toggle("is-on", autoSaveEnabled);
}

/* Called from markDirty() on every edit that changes the document, so it
   does nothing but move two timers. */
export function scheduleAutoSave() {
  if (!autoSaveEnabled || autoSaveHalt) return;
  var target = autoSaveTarget();
  if (!target) return;
  if (autoSaveIdleTimer) clearTimeout(autoSaveIdleTimer);
  autoSaveIdleTimer = setTimeout(runAutoSaveTimer, autoSaveIdleFor(target));
  if (!autoSaveMaxTimer) autoSaveMaxTimer = setTimeout(runAutoSaveTimer, autoSaveTiming.max);
}

export function clearAutoSaveTimers() {
  if (autoSaveIdleTimer) { clearTimeout(autoSaveIdleTimer); autoSaveIdleTimer = null; }
  if (autoSaveMaxTimer) { clearTimeout(autoSaveMaxTimer); autoSaveMaxTimer = null; }
}

function runAutoSaveTimer() {
  clearAutoSaveTimers();
  /* A manual Save (or a save from an action) can land between the last
     keystroke and this timer — there is nothing left to write then. */
  if (!S.dirty) return;
  queueAutoSave();
}

/* Leaving the window with work a timer has not written yet is the one
   moment the pause-and-write rule costs something, so the pending write is
   brought forward rather than left on its timer. Nothing is scheduled when
   autosave is off, so this is silent there — it never writes a file the
   user did not ask it to. */
export function flushAutoSave() {
  if (!autoSaveIdleTimer && !autoSaveMaxTimer) return;
  clearAutoSaveTimers();
  if (S.dirty) queueAutoSave();
}

/* An automatic save that failed, or that found the file changed under it,
   stops the automatic ones until the user saves by hand — with the reason
   kept for the indicator's tooltip rather than repeated as a toast. */
export function haltAutoSave(reason) {
  clearAutoSaveTimers();
  autoSaveHalt = reason || "Autosave is paused — press Save to try again.";
  updateSaveStatus();
}

export function resumeAutoSave() {
  if (!autoSaveHalt) return;
  autoSaveHalt = "";
  updateSaveStatus();
}

/* serialize auto-saves so two quick ones (e.g. posting a comment right
   after resolving another, or a timer landing on top of either) never
   overlap. Private to queueAutoSave: the flag the two Save buttons read is
   saveButtonBusy (12-dirty-toast.js). Until #59 both were called
   saveInFlight and the fragments' shared scope hoisted them into one bit,
   so saveDoc() cleared this latch on its own way out and the
   serialization the comment describes was never actually held. */
var saveInFlight = false;
var saveQueued = false;
export function queueAutoSave() {
  /* Off means off for a discrete action too, not only for typing. This
     used to check only WHERE to write, so with autosave off every add,
     move, status click, comment, find-and-replace and history restore still
     wrote the file at once. Every caller marks the document dirty first,
     so skipping here leaves the change on screen as unsaved work — the
     indicator and the unload guard cover it until the user saves. */
  if (!autoSaveEnabled) return;
  if (!autoSaveTarget()) return;
  if (autoSaveHalt) return;
  /* A pending timer would fire into a document this call is already
     writing; queueing is this function's own job from here. */
  clearAutoSaveTimers();
  if (saveInFlight) { saveQueued = true; return; }
  /* Some other saveDoc() caller — a manual Save, a save from an action —
     is already writing. saveQueued is drained by the chain below and
     nothing else, so latching here would drop this write entirely; come
     back on the ordinary idle timer instead. */
  if (S.saveButtonBusy) { scheduleAutoSave(); return; }
  saveInFlight = true;
  /* The catch matters more than it looks: without it, one rejected save
     leaves saveInFlight stuck true and every later auto-save is silently
     dropped for the rest of the session. */
  Promise.resolve()
    .then(function () { return saveDoc({ auto: true }); })
    .catch(function () {})
    .then(function () {
      saveInFlight = false;
      if (saveQueued) { saveQueued = false; queueAutoSave(); }
    });
}

export function slugify(s) {
  return String(s || "splitpage")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "splitpage";
}

/* A bare "|" inside a cell ends the column early and shears the rest of the
   row into the wrong headings. Notes are free text now, so this is a real
   possibility rather than a theoretical one; newlines get folded for the
   same reason. */
function mdCell(value) {
  return String(value == null ? "" : value)
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}

/* Shared by both Markdown shapes below: the breakdown and comments always
   follow the script, however the scenes themselves were laid out. */
function appendMarkdownTail(lines) {
  var breakdown = breakdownRows();
  if (breakdown.length) {
    lines.push("## Production breakdown");
    lines.push("");
    lines.push("| Category | Item | Status | Assigned to | Mentions | Scenes | Notes |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    breakdown.forEach(function (r) {
      lines.push("| " + [r.categoryLabel, r.name, r.statusLabel, r.owner, r.mentions,
                         r.scenes.join(", "), r.notes].map(mdCell).join(" | ") + " |");
    });
    lines.push("");
  }

  /* pieces: a picture in a comment or reply is "[image]" (commentBodyText) */
  var comments = commentEntries({ pieces: true });
  if (comments.length) {
    lines.push("## Comments");
    lines.push("");
    comments.forEach(function (c) {
      lines.push("**" + c.location + "**" +
                 (c.resolved ? " _(resolved" + (c.resolvedBy ? " by " + c.resolvedBy : "") + ")_" : "") +
                 (c.assignee ? " _(assigned to " + c.assignee + ")_" : "") +
                 " — " + c.author + (c.when ? " · " + c.when : ""));
      lines.push("");
      if (c.quoted) {
        lines.push("> " + c.quoted.split(/\r\n|\r|\n/).join("  \n> "));
        lines.push("");
      }
      lines.push((commentBodyText(c) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n"));
      c.replies.forEach(function (rp) {
        lines.push("");
        lines.push("> ↳ **" + rp.author + "**" + (rp.when ? " · " + rp.when : "") + ":  " +
                   (commentBodyText(rp) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n> "));
      });
      lines.push("");
      lines.push("---");
      lines.push("");
    });
  }
}

/* The file extension a data: URI's own mime says it is — used to name the
   sibling image files toMarkdownDoc() references instead of embedding
   (below), so a re-encoded PNG doesn't end up on disk claiming to be a
   .jpg. Defaults to jpg: every image this app writes out itself is a
   JPEG (toJpegDataUrl, 15-docx.js); only a foreign import could carry
   something else. */
function dataUrlImageExt(dataUrl) {
  var m = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl || "");
  var t = m ? m[1].toLowerCase() : "jpeg";
  if (t === "jpeg") return "jpg";
  if (t === "svg+xml") return "svg";
  return t;
}

/* Where a scene's picture lives once it's a sibling file rather than a
   base64 blob sitting in the text — shared by toMarkdownDoc() (which
   writes the reference) and markdownExportImages() (which writes the
   bytes), so the two can never point at different names. */
function markdownImagePath(row, i) {
  var img = rowImage(row);
  return "images/scene-" + pad2(i + 1) + "." + dataUrlImageExt(img && img.ref ? "data:" + img.ref.mime : img && img.dataUrl);
}

/* Whether the plain Markdown export shows the row's picture: a legacy
   inline one always, a ref'd one when its bytes are here to be written
   alongside (buildFileData awaits ensureBytes first) — a reference to a
   file the zip does not carry would be a broken image. */
function markdownHasPicture(row) {
  var img = rowImage(row);
  return !!img && (!!img.dataUrl || hasBlob(img.ref.sha256));
}

/* The scene's further pictures (#135) that the export can carry — their
   bytes here — each with the sibling file it is written to:
   images/scene-NN-2.ext, -3, … by its place in the gallery. */
function markdownMorePictures(row, i) {
  var out = [];
  morePictureRefs(row).forEach(function (ref, k) {
    var pic = pictureBytes(ref);
    if (!pic) return;
    out.push({ path: "images/scene-" + pad2(i + 1) + "-" + (k + 2) + "." + dataUrlImageExt("data:" + ref.mime), bytes: pic.bytes });
  });
  return out;
}

/* Every image the plain Markdown export needs to carry alongside it, as
   real files rather than base64 text. */
export function markdownExportImages() {
  var out = [];
  S.state.rows.forEach(function (row, i) {
    /* A ref'd picture's bytes are in memory by now (buildFileData awaits
       ensureBytes first); one nobody had, or unreadable legacy data, is
       left out — the export just won't carry that one's picture. */
    var pic = rowImage(row) && rowImageBytes(row);
    if (pic) out.push({ path: markdownImagePath(row, i), bytes: pic.bytes });
    out = out.concat(markdownMorePictures(row, i));
  });
  return out;
}

/* The plain "Markdown" export: a document meant to be read, not a filled-
   in form. Visual and Audio used to each get their own bold label on its
   own line, with an italic placeholder when a field was empty — this
   reads instead like a script, with the visual direction as an inline
   lead-in ahead of whatever is actually spoken, and nothing printed for a
   field that has nothing to say. Pictures are referenced from a sibling
   images/ folder (buildFileData, 18-local-files.js, bundles both into a
   zip when there is at least one) rather than pasted inline as base64 —
   the embedded 2 MB a phone photo becomes made this file unreadable as
   text and enormous for what it is.

   The cells are the document model's toMarkdown() (#85 step 3), which lays
   its delimiters out for CommonMark rather than copying the elements'
   nesting the way htmlToMarkdown() does ("**a****b**", "**a **b" and the
   like came out of that). This file is only ever read, by people and
   Markdown renderers, so writing it better changes nothing anyone relies
   on — unlike the table of a saved .md project (mdSceneCellSource below). */
export function toMarkdownDoc() {
  var lines = [];
  lines.push("# " + (S.state.title || "Untitled Script"));
  lines.push("");
  if (!S.state.rows.length) {
    lines.push("_No rows yet._");
    lines.push("");
  } else {
    lines.push("_" + S.state.rows.length + " scene" + (S.state.rows.length === 1 ? "" : "s") +
               " · est. " + formatDuration(totalSeconds()) + " running time_");
    lines.push("");
  }
  S.state.rows.forEach(function (row, i) {
    lines.push("### Scene " + pad2(i + 1));
    lines.push("");
    if (markdownHasPicture(row)) {
      lines.push("![visual for scene " + pad2(i + 1) + "](" + markdownImagePath(row, i) + ")");
      lines.push("");
    }
    /* the rest of the scene's gallery and its video links (#135) */
    var more = markdownMorePictures(row, i);
    more.forEach(function (m, k) {
      lines.push("![visual " + (k + 2) + " for scene " + pad2(i + 1) + "](" + m.path + ")");
      lines.push("");
    });
    var vlinks = rowVideoLinks(row);
    vlinks.forEach(function (l) {
      lines.push(l.href
        ? "▶ [" + videoLinkLabel(l).replace(/([[\]()])/g, "\\$1") + "](" + l.href.replace(/[()\s]/g, encodeURIComponent) + ")"
        : "▶ " + l.name.replace(/([\\`*_[\]<>])/g, "\\$1") + " _(video file)_");
    });
    if (vlinks.length) lines.push("");
    var vmd = toMarkdown(cellOf(row.visualText));
    if (vmd) {
      lines.push("*Visual —* " + vmd);
      lines.push("");
    }
    var amd = toMarkdown(cellOf(row.audioText));
    if (amd) {
      lines.push(amd);
      lines.push("");
    } else if (!vmd && !markdownHasPicture(row) && !more.length && !vlinks.length) {
      lines.push("_(blank scene)_");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  });
  appendMarkdownTail(lines);
  return lines.join("\n");
}

/* A table-shaped Markdown cell can't hold a literal newline or an
   unescaped pipe without breaking the row, so line breaks become <br> (the
   one bit of raw HTML every Markdown table renderer still honors inside a
   cell) and pipes are backslash-escaped rather than flattened to a space —
   unlike mdCell, which is only ever fed plain single-line breakdown data. */
function mdRichTableCell(md) {
  return String(md || "").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

/* What a scene's two table cells say, as one description used twice: to
   write the table below, and — on the way back in — to decide whether a
   cell was edited outside Splitpage (`reconcileMarkdownRows`,
   20d-formats.js). Two copies of this composition would drift, and the
   drift would read as "every cell was edited" on the next open.

   Newlines are folded to <br> here because that is part of what the cell
   *says*; the pipe-escaping mdRichTableCell adds is a property of the
   table *row* and is undone again by parseMarkdownTable, so it is
   deliberately not part of this comparison basis.

   The cells are htmlToMarkdown() of the stored HTML, NOT the document
   model's toMarkdown() (#85 step 3), which the plain export above uses and
   which writes better Markdown. This comparison is a contract with every
   copy of the app that will ever open the file, older ones included (a
   second machine, a desktop install not yet updated, the 3.0 pre-release):
   each decides whether a cell was edited outside Splitpage by comparing
   the table with ITS OWN rendering of the data block's HTML, and every
   copy in circulation renders with htmlToMarkdown(). A cell written any
   other way ("**ab**" for the "**a****b**" the stored HTML gives, a space
   moved outside a delimiter) reads there as edited by hand and is rebuilt
   from the table: its comment anchors and b-roll key gone, its tags
   re-found by name at best. The same writer is what keeps an unchanged
   document's bytes the same from one save to the next, which a file kept
   under version control needs, and what makes a file an older copy wrote
   open here unchanged.

   Reading already takes the model's form as unchanged too (`model` true,
   reconcileMarkdownRows, 20d-formats.js): once no copy from before that is
   in use, the writer can switch without any copy misreading a file. */
export function mdSceneCellSource(row, i, model) {
  var toMd = model ? function (html) { return toMarkdown(cellOf(html)); } : htmlToMarkdown;
  var text = toMd(row.visualText);
  var visual = text;
  /* The picture inline, as it always was (#82 D2) — a legacy URI exactly as
     stored, a ref'd one as its canonical data: URI. */
  var image = rowImageDataUrl(row);
  if (image) {
    visual = "![visual for scene " + pad2(i + 1) + "](" + image + ")" + (visual ? "<br>" + visual : "");
  }
  return {
    visual: String(visual).replace(/\r\n|\r|\n/g, "<br>").trim(),
    /* the same cell without its picture, and which picture — what the
       reconcile compares when the whole cell differs only in how the
       picture's base64 was spelled (an older client's file) */
    visualText: String(text).replace(/\r\n|\r|\n/g, "<br>").trim(),
    image: image ? rowImageKey(row) : null,
    audio: String(toMd(row.audioText)).replace(/\r\n|\r|\n/g, "<br>").trim()
  };
}

/* The same script as toMarkdownDoc, laid out as a Visual/Audio table
   instead of a stacked Scene-by-scene list — this is also exactly the
   table shape Import ▸ Two columns already knows how to read back in, so
   round-tripping through this export doesn't lose the split, and it is the
   human-readable half of a saved .splitpage-in-Markdown project
   (buildMarkdownProject, 20d-formats.js). */
export function toMarkdownTableDoc(s) {
  s = s || S.state;
  var lines = [];
  lines.push("# " + (s.title || "Untitled Script"));
  lines.push("");
  if (!s.rows.length) {
    lines.push("_No rows yet._");
  } else {
    lines.push("| # | Visual | Audio | Status |");
    lines.push("| --- | --- | --- | --- |");
    s.rows.forEach(function (row, i) {
      var cell = mdSceneCellSource(row, i);
      lines.push("| " + pad2(i + 1) + " | " + mdRichTableCell(cell.visual) + " | " +
                 mdRichTableCell(cell.audio) + " | " + (row.status || "todo") + " |");
    });
  }
  lines.push("");
  appendMarkdownTail(lines);
  return lines.join("\n");
}

/* ================= binary helpers ================= */

export function strBytes(s) { return new TextEncoder().encode(s); }

/* latin1 bytes — for PDF, where the file is a byte stream, not UTF-8 text */
export function latin1Bytes(s) {
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function concatBytes(chunks) {
  var total = 0, i;
  for (i = 0; i < chunks.length; i++) total += chunks[i].length;
  var out = new Uint8Array(total), at = 0;
  for (i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
  return out;
}

var CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]); }
function u32(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]); }

/* ================= zip (store-only writer, full reader) ================= */

/* We write uncompressed ("stored") entries — a completely valid zip that Word,
   Pages and every unzip tool accept — which avoids needing a deflate encoder. */
export function zipWrite(entries) {
  var now = new Date();
  var dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() / 2) & 0x1f);
  var dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);

  var local = [], central = [], offset = 0;
  entries.forEach(function (e) {
    var nameB = strBytes(e.name);
    var crc = crc32(e.data);
    var lh = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(nameB.length), u16(0), nameB
    ]);
    local.push(lh, e.data);
    central.push(concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB
    ]));
    offset += lh.length + e.data.length;
  });

  var cd = concatBytes(central);
  var eocd = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0)
  ]);
  return concatBytes([concatBytes(local), cd, eocd]);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("no-decompression-stream");
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  var buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function zipRead(arrayBuffer) {
  var bytes = new Uint8Array(arrayBuffer);
  var dv = new DataView(arrayBuffer);

  /* find the end-of-central-directory record, scanning back over any comment */
  var eocd = -1;
  for (var i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("not-a-zip");

  var count = dv.getUint16(eocd + 10, true);
  var cdOffset = dv.getUint32(eocd + 16, true);
  var files = {};
  var p = cdOffset;

  for (var n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    var method = dv.getUint16(p + 10, true);
    var compSize = dv.getUint32(p + 20, true);
    var nameLen = dv.getUint16(p + 28, true);
    var extraLen = dv.getUint16(p + 30, true);
    var commentLen = dv.getUint16(p + 32, true);
    var localOff = dv.getUint32(p + 42, true);
    var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    var lNameLen = dv.getUint16(localOff + 26, true);
    var lExtraLen = dv.getUint16(localOff + 28, true);
    var dataStart = localOff + 30 + lNameLen + lExtraLen;
    var raw = bytes.subarray(dataStart, dataStart + compSize);
    files[name] = { method: method, raw: raw };
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    async get(name) {
      var f = files[name];
      if (!f) return null;
      return f.method === 0 ? f.raw : await inflateRaw(f.raw);
    },
    names: Object.keys(files)
  };
}

/* ================= plain text from rich html ================= */

export function htmlToPlainText(html) {
  if (!html) return "";
  var c = inertBody(String(html).replace(/<br\s*\/?>/gi, "\n"));
  return (c.textContent || "").replace(/\u00A0/g, " ").trim();
}

export function xmlEscape(s) {
  return String(s == null ? "" : s)
    /* C0 controls (except tab/LF/CR) are illegal in XML 1.0 */
    /* eslint-disable-next-line no-control-regex -- see the line above. */
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/* ================= category colours on paper (#171) =================

   The breakdown's categories in the PDF and .docx exports — and the
   packing list's heading — are drawn in each category's colour: the LIGHT
   theme's --tag-* values from app.css :root, because the page is white
   whatever theme the app is in. A second copy of those hexes, on purpose:
   TAG_CATEGORIES names the CSS token (`var(--tag-prop)`), which means
   nothing to a PDF or a Word file, and reading the live value would give
   the dark palette to anyone exporting in the dark theme. The build is
   one esbuild call with no plugins and the unit tests import src/js
   directly, so there is no build step to inject them from either.
   `src/test/palette.test.mjs` fails the moment this table and :root
   disagree, or either gains a category the other lacks, and checks each
   colour is readable on white (4.5:1) — the same colours the script uses
   on the light theme's page, and all dark enough to read in greyscale.

   Keyed by TAG_CATEGORIES id; hex without "#", upper case, which is what
   Word's <w:color w:val> takes. */
export var TAG_PRINT_COLORS = {
  prop: "764AA2",
  location: "2A7449",
  cast: "A53C75",
  vfx: "5E6C00",
  sound: "AB413E",
  gear: "44693C"
};

/* A category's print colour by id, or null for one this table lacks — an
   export then draws it in plain black, as before #171. */
export function tagPrintColor(catId) {
  return Object.prototype.hasOwnProperty.call(TAG_PRINT_COLORS, catId) ? TAG_PRINT_COLORS[catId] : null;
}

/* Walk rich HTML into a flat list of styled runs:
   [{text, b, i, u, s, mark, href}] with text "\n" marking a line break. */
export function htmlToRuns(html) {
  var container = inertBody(html);
  var runs = [];
  (function walk(node, fmt) {
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) {
        var t = (child.nodeValue || "").replace(/\u00A0/g, " ");
        if (t) runs.push({ text: t, b: fmt.b, i: fmt.i, u: fmt.u, s: fmt.s, mark: fmt.mark, href: fmt.href });
        return;
      }
      if (child.nodeType !== 1) return;
      var tag = child.tagName;
      if (tag === "BR") { runs.push({ text: "\n" }); return; }
      var next = {
        b: fmt.b || tag === "STRONG" || tag === "B",
        i: fmt.i || tag === "EM" || tag === "I",
        u: fmt.u || tag === "U",
        s: fmt.s || tag === "S" || tag === "STRIKE" || tag === "DEL",
        mark: fmt.mark || tag === "MARK",
        href: tag === "A" ? (child.getAttribute("href") || fmt.href) : fmt.href
      };
      walk(child, next);
    });
  })(container, { b: false, i: false, u: false, s: false, mark: false, href: null });
  return runs;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  autoSaveEnabled = readAutoSavePref();

  window.addEventListener("blur", function () { flushAutoSave(); });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushAutoSave();
  });
}
