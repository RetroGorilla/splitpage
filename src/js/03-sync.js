import { S } from "./_state.js";
import { SCHEMA_VERSION } from "./00-prelude.js";
import { DEFAULT_WPM } from "./01-scene-status.js";
import { STATE_FIELDS, escapeHtml, makeId, migrateRows } from "./02-state.js";
import { dataUrlForSync, internDataUrl, isDurableSync } from "./02c-blobs.js";
import { noteRemoteChange } from "./12a-undo.js";
import { isSha256Hex, normalizeImageRef, refsIn } from "../../shared/blob-policy.js";
import {
  adoptRestoredState,
  mergedDocId,
  normalizeDocId,
  noteMergedDocId
} from "./02b-doc-id.js";
import {
  captureSnapshot,
  getHistorySnapshot,
  historyNoop,
  listDocHistory,
  protectHistorySnapshot
} from "./03a-history-store.js";
import {
  SIDE_PANEL_IDS,
  applySidePanelWidth,
  readSidePanelWidth
} from "./03b-side-panels.js";
import { safeId, storedImageHtml } from "./04-richtext.js";
import { fromHtml, mergeCells, sameCell, toHtml } from "./04c-doc-model.js";
import { render } from "./05-render.js";
import { BROLL_PROPS_MAX, brollPropKey } from "./08c-broll.js";
import {
  TAG_STATUSES,
  ensureTagIds,
  normalizeTagName,
  registryKey,
  registryTagHooks,
  resetProductionPanelState,
  tagStatus,
  tagStatusRank
} from "./07-production-tags.js";
import {
  formatTimestamp,
  getSavedAuthorName,
  nowIso,
  saveAuthorName
} from "./10-comments.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { driveFormatSize } from "./13-hosted.js";
import { haltAutoSave, queueAutoSave } from "./14-export.js";
import { updateFileChip } from "./18-local-files.js";

/* ================= sync: identity, snapshots, merge =================

   There is no shared realtime channel available to this page, so
   collaboration rides on the publish/reload cycle:

     * every save is a compare-and-set against the version this view loaded;
     * if someone published first the call rejects `conflict` and the shell
       reloads this view to THEIR version — in-memory edits would vanish;
     * a successful save reloads this view too (the whole page is replaced),
       so the only way to keep local work is to stash it BEFORE publishing
       and merge it back into whatever we reload into.

   Everything below exists so that no edit is ever silently dropped. */

var STASH_KEY = "splitpage-conflict-stash";
export var SNAPSHOT_KEY = "splitpage-snapshots";
export var RELOAD_GUARD_KEY = "splitpage-conflict-reloaded";

/* the version this view loaded (or last successfully published) — the
   common ancestor for every three-way merge */
S.baseState = null;

export function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

export function getEditorName() {
  return getSavedAuthorName() || "Anonymous";
}

export function stampRow(row) {
  row.updatedAt = nowIso();
  row.updatedBy = getEditorName();
}

/* ---- version history (per document — the store is 03a-history-store.js) ---- */

/* The old shared list's raw text, or null. Nothing writes this key any
   more: its only reader is the one-time migration into "Older history"
   (startHistoryMigration, 03a), which needs the exact bytes so it can
   tell whether another tab changed the key while it was copying. */
export function readLegacySnapshotsRaw() {
  try {
    var raw = localStorage.getItem(SNAPSHOT_KEY);
    return typeof raw === "string" ? raw : null;
  } catch (e) { return null; }
}

/* Captures synchronously and returns a PushTicket {id, docId, done} or
   null; the write is queued and never awaited here. WHY it must stay
   synchronous: these callers replace or mutate `state` on the very next
   line, so any await before the capture would snapshot the document that
   REPLACED the one the label names —
     10-comments.js  restoreConflictValue (twice: title, field)
     11-import.js    confirmImport (replacing rows)
     13-hosted.js    openServerDoc; saveToServer's 409 merge
     18-local-files.js adoptProjectState; loadFileIntoEditor;
                       reloadFileFromDisk
   None of them awaits ticket.done: a failed history write must never
   become a failed open, import or save. Only restoreSnapshot, undoMerge
   (through it) and the crash-draft file merge (applyMerge's
   awaitUndoPoint) wait for the write.

   With no explicit snapshotState, the untouched demo document is skipped
   (isPristineSeedDocument): opening a file into a fresh page would
   otherwise file a copy of the seed under an id no panel ever shows. An
   explicit state is always captured. */
export function pushSnapshot(label, snapshotState) {
  return captureSnapshot(label, snapshotState || S.state, { allowSeedSkip: !snapshotState });
}

var restoreInFlight = false;
var RESTORE_BACKUP_ATTEMPTS = 3;

/* → 'restored' | 'no-backup' | 'missing' | 'changed' | 'corrupt' | 'busy'.

   A restore replaces the document and then queueAutoSave() writes that
   over the file, so the version on screen is gone for good unless a backup
   of it was STORED first. Hence the order: read the snapshot, store a
   "Before restoring" backup and wait for the store to confirm it, and only
   then adopt. Without a confirmed backup the answer is 'no-backup' and
   nothing changes, unless the caller passes force (the user said "restore
   anyway").

   Every await is followed by a document check: opening another document
   while the backup is being written must not adopt this snapshot over
   THAT document ('changed'). Typing during the wait is not a reason to
   abort, but the typed edits must be in the backup too — so the backup is
   captured again while editSeq keeps moving, up to three times. The same
   goes for `state` REPLACED under the same docId with no edit (saveToServer's
   409 merge, a reload from disk, reopening the same server document):
   editSeq does not move, yet the backup holds the object that was replaced
   and does not protect the version this restore would overwrite
   (invariant #39). So a backup counts only while both the state object and
   editSeq are the ones it was captured from. Nothing awaits between that
   check and adoptRestoredState, so what counted is exactly what is replaced.

   The snapshot being restored is held (protectHistorySnapshot, 03a) for the
   whole call: the backup's own write may have to evict, the Older bucket
   goes first, and without the hold a restore from Older under a full quota
   could delete the very snapshot it is restoring — leaving nothing for the
   "restore anyway" click to find.

   `opts.restoredText` replaces the "Restored the version from …" toast,
   for a caller that knows better what just happened (undoMerge after a
   save conflict, whose next save has something specific to do).

   `opts.local` leaves the restored version on screen and dirty instead of
   writing it straight away — markDirty() still arms the ordinary idle
   autosave, so the autosave preference decides when it goes, not this
   call. (With autosave on, queueAutoSave() writes at once; with it off,
   neither path writes until the user saves.) undoMerge
   passes it after a save conflict: there the version being replaced is
   already safe on the server, and the write this would force is the one
   that takes a collaborator's work back out of it for everybody. */
async function restoreSnapshot(id, opts) {
  opts = opts || {};
  if (restoreInFlight) return "busy";
  if (!S.state) return "missing";
  restoreInFlight = true;
  var docIdAtStart = S.state.docId;
  var moved = function () { return !S.state || S.state.docId !== docIdAtStart; };
  var releaseHold = historyNoop;
  try {
    releaseHold = protectHistorySnapshot({ docId: opts.older ? null : docIdAtStart, older: !!opts.older, id: id });

    var snap = await getHistorySnapshot({ docId: opts.older ? null : docIdAtStart, older: !!opts.older, id: id });
    if (moved()) return "changed";
    if (!snap) return "missing";
    var parsed = null;
    try { parsed = JSON.parse(snap.stateJson); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rows)) return "corrupt";

    var stored = false;
    for (var attempt = 0; attempt < RESTORE_BACKUP_ATTEMPTS; attempt++) {
      var stateAtCapture = S.state;
      var seqAtCapture = S.editSeq;
      var ticket = captureSnapshot("Before restoring an earlier version", S.state, { allowSeedSkip: false });
      /* null: the document could not even be serialized — no backup */
      if (!ticket) { stored = false; break; }
      var result = await ticket.done;
      if (moved()) return "changed";
      stored = !!(result && result.stored);
      if (S.state === stateAtCapture && S.editSeq === seqAtCapture) break;
      /* edits landed, or the document was replaced under the same docId,
         while that backup was being written; a backup that misses that
         version does not protect it, so it does not count */
      stored = false;
    }
    if (!stored && !opts.force) return "no-backup";

    /* adoptRestoredState, not migrateRows: a restore changes the content,
       never the document's identity (02b-doc-id.js) — even a snapshot from
       the Older bucket, which may carry some other document's id. */
    adoptRestoredState(parsed);
    resetProductionPanelState(); /* same reason as adoptProjectState — different document underneath */
    markDirty();
    render();
    closeHistoryPanel();
    showToast(opts.restoredText || "Restored the version from " + formatTimestamp(snap.meta && snap.meta.at), "ok");
    if (!opts.local) queueAutoSave();
    return "restored";
  } finally {
    releaseHold();
    restoreInFlight = false;
  }
}

/* The panel's "Restore this version" button. A first click that comes
   back 'no-backup' arms the button for 4 s; a second click inside that
   window restores anyway. The armed key (not the element) is remembered,
   because a history write settling in the meantime re-renders the panel
   and replaces every button — renderHistory re-applies it. */
var RESTORE_ARM_MS = 4000;
var RESTORE_LABEL = "Restore this version";
var RESTORE_ARMED_LABEL = "Couldn't keep a backup — restore anyway?";
var restoreArmedKey = null;
var restoreArmTimer = null;

function restoreCardKey(bucket, id) {
  return (bucket === "older" ? "older" : "doc") + "/" + id;
}

function applyRestoreArm() {
  var panel = document.getElementById("history-panel");
  if (!panel) return;
  Array.prototype.forEach.call(panel.querySelectorAll('[data-action="restore-snapshot"]'), function (b) {
    var armed = restoreArmedKey !== null &&
      restoreCardKey(b.getAttribute("data-bucket"), b.getAttribute("data-id")) === restoreArmedKey;
    b.classList.toggle("armed", armed);
    b.textContent = armed ? RESTORE_ARMED_LABEL : RESTORE_LABEL;
  });
}

function disarmRestore() {
  clearTimeout(restoreArmTimer);
  restoreArmTimer = null;
  restoreArmedKey = null;
  applyRestoreArm();
}

export function restoreSnapshotFromCard(btn) {
  if (!btn) return;
  var id = btn.getAttribute("data-id") || "";
  var older = btn.getAttribute("data-bucket") === "older";
  var key = restoreCardKey(older ? "older" : "doc", id);
  var force = restoreArmedKey === key;
  if (force) disarmRestore();
  return restoreSnapshot(id, { older: older, force: force }).then(function (r) {
    if (r === "no-backup") {
      clearTimeout(restoreArmTimer);
      restoreArmedKey = key;
      applyRestoreArm();
      restoreArmTimer = setTimeout(disarmRestore, RESTORE_ARM_MS);
    } else if (r === "missing") {
      showToast("That version is no longer in the history.", "warn");
      renderHistory();
    } else if (r === "corrupt") {
      showToast("That version could not be read, so nothing was restored.", "warn");
    } else if (r === "changed") {
      showToast("A different document was opened while restoring, so nothing was restored.", "warn");
    }
    /* 'busy': a restore is already running — this click adds nothing */
    return r;
  }, function (e) {
    if (window.console) console.error(e);
    return "corrupt";
  });
}

/* ---- three-way merge ---- */

export function byId(list) {
  var map = {};
  (list || []).forEach(function (item) { map[item.id] = item; });
  return map;
}

export var ROW_FIELDS = ["visualText", "imageRef", "audioText"];

/* What a row field is compared by. Text by its HTML; the picture by the
   sha its imageRef names (#82) — two records for the same bytes are the
   same picture, and a record is an object, which === would never equate. */
export function rowFieldKey(row, f) {
  if (!row) return null;
  if (f === "imageRef") {
    var r = row.imageRef;
    return r && typeof r === "object" && typeof r.sha256 === "string" ? r.sha256 : null;
  }
  return row[f] || null;
}

export function rowContentEqual(a, b) {
  if (!a || !b) return false;
  return ROW_FIELDS.every(function (f) { return rowFieldKey(a, f) === rowFieldKey(b, f); });
}

/* The comment-level equivalent of rowContentEqual, used the same way: to
   tell "the other side left this untouched since base" (safe to honor a
   delete) apart from "the other side genuinely changed it" (a reply or a
   resolve must survive even if I deleted my copy). */
function commentContentEqual(a, b) {
  if (!a || !b) return false;
  if ((a.body || "") !== (b.body || "")) return false;
  if (!!a.resolved !== !!b.resolved) return false;
  if ((a.assignee || "") !== (b.assignee || "")) return false;
  if (JSON.stringify(a.replies || []) !== JSON.stringify(b.replies || [])) return false;
  return true;
}

/* ---- one script cell, three ways (#85, docs/DOCUMENT-MODEL.md §8) ----

   A cell used to be compared as its HTML string, whole: re-tag a word on
   one side and fix a typo on the other and the cell was a conflict, with
   my whole cell on an "Unmerged edit" card. Now each side is read into the
   document model (04c-doc-model.js) and merged there, a word at a time
   (mergeCells): only the same words changed differently on both sides, or
   given a different link or tag on both sides, are a conflict, and that
   conflict is handled exactly as before (design D3).

   Each side's HTML names a tag by (category, name), and each side is read
   through ITS OWN registry, so a tag renamed on one side resolves to the
   same registry id on all three and a rename alone is not a change to the
   cell. What is written back names each tag the way the MERGED registry
   does.

   Strings are only parsed where they differ, and two strings that read as
   the same cell (a different nesting of the same bold and italic, say) are
   the same cell: a re-serialisation alone never counts as an edit. */

/* A side's registry as the model's tag hooks. An entry without an id (a
   base kept from before ids) gets the one ensureTagIds would mint for it,
   which is the id the other sides minted for the same key. */
function tagHooksFor(tags) {
  var list = tags || [];
  if (list.some(function (t) { return t && !t.id; })) {
    /* copies: ensureTagIds works in place, and this is a side's document */
    list = list.map(function (t) { return t && Object.assign({}, t); });
    ensureTagIds(list);
  }
  return registryTagHooks(list);
}

/* Does the merged registry name any of this side's entries differently (a
   rename from the other side)? Only then can this side's HTML hold a tag
   span that needs its name brought up to date. */
function registryRenamed(sideTags, mergedTags) {
  var merged = {};
  (mergedTags || []).forEach(function (t) { if (t && t.id) merged[t.id] = t; });
  return (sideTags || []).some(function (t) {
    var m = t && t.id && merged[t.id];
    return !!m && (m.cat !== t.cat || m.name !== t.name);
  });
}

/* Everything mergeTextField() needs about the three registries, built once
   per merge: each side's hooks, the hooks the result is written with, and
   which sides' spans may be named out of date. `mergedTags` is the merged
   registry; left out, it is what mergeProductionTags() makes of the three.
   A tag the merged registry no longer holds keeps the name a side gave it
   (theirs first), so a span is never dropped from the text — the heal in
   migrateRows re-registers it, as it always has. */
export function textMergeContext(base, mine, theirs, mergedTags) {
  var baseTags = base && base.productionTags;
  if (mergedTags === undefined) mergedTags = mergeProductionTags(baseTags, mine.productionTags, theirs.productionTags);
  var hb = tagHooksFor(baseTags), hm = tagHooksFor(mine.productionTags), ht = tagHooksFor(theirs.productionTags);
  var hout = registryTagHooks(mergedTags);
  return {
    hasBase: !!base,
    base: hb,
    mine: hm,
    theirs: ht,
    out: {
      tagId: hout.tagId,
      tagOf: function (id) { return hout.tagOf(id) || ht.tagOf(id) || hm.tagOf(id) || hb.tagOf(id); }
    },
    refit: {
      mine: registryRenamed(mine.productionTags, mergedTags),
      theirs: registryRenamed(theirs.productionTags, mergedTags)
    }
  };
}

/* A cell as the model reads it, through one side's registry; `media` says
   it held a picture or a video card, which the model leaves out (design
   D7) and so must not be merged through it. */
function readCell(html, hooks) {
  var media = false;
  var cell = fromHtml(html, { tagId: hooks.tagId, onMedia: function () { media = true; } });
  return { cell: cell, media: media };
}

/* One side's HTML as it goes into the merged document: unchanged, unless
   the merged registry renamed a tag it names — then rewritten through the
   model so its spans carry the new name. */
function refitCell(html, side, ctx) {
  if (!ctx.refit[side] || html.indexOf("tag-anchor") === -1) return html;
  var cell = fromHtml(html, { tagId: ctx[side].tagId });
  if (sameCell(fromHtml(html, { tagId: ctx.out.tagId }), cell)) return html;
  return toHtml(cell, { tagOf: ctx.out.tagOf });
}

/* base (undefined when the row has no ancestor), mine, theirs: a cell's
   HTML on each side. Returns {html, outcome}: outcome is "same" (no
   difference that matters), "mine" / "theirs" (only that side changed it),
   "merged" (both did, and both sets of changes are in html) or "conflict"
   (both changed the same words: html is theirs, and the caller keeps mine
   on a card — or, with `marks: true`, both put a different link or tag on
   the same words: html is the merged cell, with their link or tag there,
   and mine still goes on a card). mergeRow() below and the on-disk merge review
   (18a-local-merge.js) both decide by this, so the review says exactly
   what the merge will do. */
export function mergeTextField(base, mine, theirs, ctx) {
  var bv = base == null ? "" : String(base), mv = mine == null ? "" : String(mine), tv = theirs == null ? "" : String(theirs);
  var hasBase = ctx.hasBase && base !== undefined;
  if (mv === tv) return { html: refitCell(tv, "theirs", ctx), outcome: "same" };

  var M = readCell(mv, ctx.mine), T = readCell(tv, ctx.theirs);
  var B = !hasBase ? null : bv === mv ? M : bv === tv ? T : readCell(bv, ctx.base);
  /* A picture or video card in a cell has no place in the model, so any of
     the three holding one is compared as a string, whole, as before. */
  if (M.media || T.media || (B && B.media)) {
    if (hasBase && mv === bv) return { html: tv, outcome: "theirs" };
    if (hasBase && tv === bv) return { html: mv, outcome: "mine" };
    return { html: tv, outcome: "conflict" };
  }
  if (sameCell(M.cell, T.cell)) return { html: refitCell(tv, "theirs", ctx), outcome: "same" };
  if (!hasBase) return { html: refitCell(tv, "theirs", ctx), outcome: "conflict" };

  var mineChanged = mv !== bv && !sameCell(M.cell, B.cell);
  var theirsChanged = tv !== bv && !sameCell(T.cell, B.cell);
  if (!mineChanged) return { html: refitCell(tv, "theirs", ctx), outcome: "theirs" };
  if (!theirsChanged) return { html: refitCell(mv, "mine", ctx), outcome: "mine" };

  var r = mergeCells(B.cell, M.cell, T.cell);
  if (r.conflict) return { html: refitCell(tv, "theirs", ctx), outcome: "conflict" };
  /* Both changed it and the changes fit together. Where the result is
     simply one side's cell (the other's change was already in it), that
     side's own HTML goes in rather than a rewrite of it. */
  var res = sameCell(r.cell, T.cell) ? { html: refitCell(tv, "theirs", ctx), outcome: "theirs" }
    : sameCell(r.cell, M.cell) ? { html: refitCell(mv, "mine", ctx), outcome: "mine" }
    : { html: toHtml(r.cell, { tagOf: ctx.out.tagOf }), outcome: "merged" };
  if (!r.markConflicts) return res;
  /* Both sides put a different link, or a different tag, on the same
     characters (formatting never counts: bold is on or off, and either
     side's toggle is simply kept). The merged cell stays live, with their
     link or tag on those characters, but mine would be lost without a
     trace — so it is a conflict like any other: my whole cell goes on the
     card (design D3). `marks` says why, for the on-disk review's wording;
     `withMine` says my other edits are in the live cell, which counts the
     row as one I edited. */
  return { html: res.html, outcome: "conflict", marks: true, withMine: res.outcome !== "theirs" };
}

/* Merge `mine` and `theirs`, both descended from `base`.
   Anything that cannot be reconciled is preserved, never dropped. */
export function mergeStates(base, mine, theirs) {
  var conflicts = [];
  var stats = { rowsFromThem: 0, rowsFromMe: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 };

  var baseRows = byId(base && base.rows), mineRows = byId(mine.rows), theirRows = byId(theirs.rows);
  var merged = [];
  var placed = {};

  /* The registry is merged first, not in its turn below: the cells are
     written naming their tags the way the merged registry does. */
  var tagField = STATE_FIELDS.filter(function (f) { return f.key === "productionTags"; })[0];
  var mergedTags = tagField.mergeList(base && base.productionTags, mine.productionTags, theirs.productionTags);
  var textCtx = textMergeContext(base, mine, theirs, mergedTags);

  function mergeRow(b, m, t) {
    /* present on both sides — reconcile field by field. The picture is
       compared by rowFieldKey (its sha) and taken whole from its side; a
       script cell goes through mergeTextField(), a word at a time. */
    var out = JSON.parse(JSON.stringify(t));
    var tookMine = false, tookTheirs = false;
    ROW_FIELDS.forEach(function (f) {
      if (f !== "imageRef") {
        var r = mergeTextField(b ? (b[f] == null ? "" : b[f]) : undefined, m[f], t[f], textCtx);
        if (r.html !== (t[f] == null ? "" : String(t[f]))) out[f] = r.html;
        if (r.outcome === "mine" || r.outcome === "merged" || r.withMine) tookMine = true;
        if (r.outcome === "theirs" || r.outcome === "merged" || r.outcome === "conflict") tookTheirs = true;
        /* both changed the same words, or linked or tagged them
           differently: keep theirs live, keep my whole cell intact on a
           card (design D3) */
        if (r.outcome === "conflict") conflicts.push({ rowId: t.id, field: f, mine: m[f] || null, theirs: t[f] || null });
        return;
      }
      var mv = rowFieldKey(m, f), tv = rowFieldKey(t, f), bv = b ? rowFieldKey(b, f) : null;
      if (mv === tv) return;
      if (b && mv === bv) { tookTheirs = true; return; }            /* only they changed it */
      if (b && tv === bv) {                                         /* only I changed it */
        out[f] = m[f] == null ? null : JSON.parse(JSON.stringify(m[f]));
        tookMine = true;
        return;
      }
      /* both changed the same field: keep theirs live, keep mine intact */
      tookTheirs = true;
      conflicts.push({ rowId: t.id, field: f, mine: m[f] || null, theirs: t[f] || null });
    });
    /* Status isn't text to reconcile, it's progress to accumulate: if
       either of us has marked a scene shot, it has been shot. Taking the
       furthest-along value can never un-shoot something someone filmed. */
    var rank = { todo: 0, ready: 1, shot: 2 };
    out.status = (rank[m.status] || 0) >= (rank[t.status] || 0) ? m.status : t.status;
    /* A row whose cells combine both sides' words counts as mine: my edit
       is in it, which is what "rows you edited" reports. With no ancestor
       nothing can be told apart, and any row they hold counts as theirs,
       as it always has. */
    if (tookMine) {
      out.updatedAt = nowIso();
      out.updatedBy = getEditorName();
      stats.rowsFromMe++;
    } else if (b ? tookTheirs : !rowContentEqual({}, t)) {
      stats.rowsFromThem++;
    }
    return out;
  }

  /* start from their ordering — it is the published truth */
  theirs.rows.forEach(function (t) {
    var b = baseRows[t.id], m = mineRows[t.id];
    if (!m) {
      if (b && rowContentEqual(b, t)) return;  /* I deleted it and they left it alone */
      merged.push(JSON.parse(JSON.stringify(t)));  /* they edited it — an edit outranks my delete */
      placed[t.id] = true;
      return;
    }
    merged.push(mergeRow(b, m, t));
    placed[t.id] = true;
  });

  /* rows only I have: ones I added, or ones they deleted but I edited */
  mine.rows.forEach(function (m, idxInMine) {
    if (placed[m.id] || theirRows[m.id]) return;
    var b = baseRows[m.id];
    if (b && rowContentEqual(b, m)) return;   /* they deleted it, I never touched it */
    if (!b) stats.rowsAddedByMe++;
    /* slot it back in after whichever of my neighbours survived */
    var anchorIdx = -1;
    for (var k = idxInMine - 1; k >= 0; k--) {
      var prevId = mine.rows[k].id;
      for (var j = 0; j < merged.length; j++) {
        if (merged[j].id === prevId) { anchorIdx = j; break; }
      }
      if (anchorIdx !== -1) break;
    }
    var copy = JSON.parse(JSON.stringify(m));
    if (anchorIdx === -1) merged.unshift(copy);
    else merged.splice(anchorIdx + 1, 0, copy);
    placed[m.id] = true;
  });

  theirs.rows.forEach(function (t) { if (!baseRows[t.id] && !mineRows[t.id]) stats.rowsAddedByThem++; });

  /* comments: union by id, newest wins, replies unioned */
  var baseC = byId(base && base.comments), mineC = byId(mine.comments), theirC = byId(theirs.comments);
  var mergedComments = [];
  var seen = {};
  function newer(a, b2) {
    return (a.updatedAt || a.createdAt || "") >= (b2.updatedAt || b2.createdAt || "") ? a : b2;
  }
  Object.keys(theirC).concat(Object.keys(mineC)).forEach(function (id) {
    if (seen[id]) return;
    seen[id] = true;
    var m = mineC[id], t = theirC[id], b = baseC[id];
    var pick;
    if (m && t) {
      pick = JSON.parse(JSON.stringify(newer(m, t)));
      /* `resolved` is forward progress, the same rule this file already
         applies to row/tag status ("a merge can never un-shoot/un-buy
         something") — so it is merged independently rather than riding
         along with whichever whole side "newer" happened to pick. Without
         this, an unrelated action that bumps updatedAt on one side (e.g. a
         reply) can silently revert a resolve/unresolve that happened
         earlier in wall-clock time on the other side. */
      pick.resolved = !!(m.resolved || t.resolved);
      /* resolvedBy/resolvedAt (#29) ride along with the same
         forward-progress rule: a resolve from either side beats an
         unresolved copy, and between two resolves the later timestamp
         wins, so the merge always credits whoever actually closed the
         thread most recently rather than whichever whole side "newer"
         happened to pick above. */
      if (m.resolved && t.resolved) {
        if ((t.resolvedAt || "") >= (m.resolvedAt || "")) {
          pick.resolvedBy = t.resolvedBy || null; pick.resolvedAt = t.resolvedAt || null;
        } else {
          pick.resolvedBy = m.resolvedBy || null; pick.resolvedAt = m.resolvedAt || null;
        }
      } else if (m.resolved) {
        pick.resolvedBy = m.resolvedBy || null; pick.resolvedAt = m.resolvedAt || null;
      } else if (t.resolved) {
        pick.resolvedBy = t.resolvedBy || null; pick.resolvedAt = t.resolvedAt || null;
      } else {
        pick.resolvedBy = null; pick.resolvedAt = null;
      }
      /* assignee: filled beats empty, the same rule mergeProductionTags
         already applies to owner/notes — an assignment only one side
         made still survives the merge. */
      if (!pick.assignee) pick.assignee = m.assignee || t.assignee || "";
    }
    /* An edit outranks a delete for comments the same way it already does
       for rows a few lines up: only a comment BOTH honor as unchanged
       since base is safe to drop when the other side deleted it. */
    else if (t && !m) { if (b && commentContentEqual(b, t)) return; pick = JSON.parse(JSON.stringify(t)); }   /* I deleted it */
    else { if (b && commentContentEqual(b, m)) return; pick = JSON.parse(JSON.stringify(m)); }                /* they deleted it */
    if (m && t) {
      var replies = byId(m.replies);
      (t.replies || []).forEach(function (r) { replies[r.id] = r; });
      pick.replies = Object.keys(replies).map(function (k) { return replies[k]; })
        .sort(function (x, y) { return (x.createdAt || "").localeCompare(y.createdAt || ""); });
    }
    mergedComments.push(pick);
  });

  /* Row fields raise a conflict comment the instant both sides touch the
     same field — the title never did: it just kept theirs, silently,
     whenever both sides had changed it (or base wasn't available at
     all, e.g. resumeServerDoc() with no stash.base). Route it through
     the same conflicts array instead (pushed before the forEach below
     builds comments from it), with rowId: null marking it as a title
     conflict rather than a row one (findAnchorLocationLabel,
     restoreConflictValue and the label just below all special-case
     field === "title" to handle that). */
  var mergedTitle = theirs.title;
  if (base && mine.title !== base.title && theirs.title === base.title) {
    mergedTitle = mine.title;
  } else if (mine.title !== theirs.title && (!base || (mine.title !== base.title && theirs.title !== base.title))) {
    if (mine.title) conflicts.push({ rowId: null, field: "title", mine: mine.title, theirs: theirs.title });
  }

  /* every unreconcilable field becomes a comment holding my version. A
     picture is held as `imageValue`, the record itself — what "Use my
     version" puts back — and the body shows it in the stored HTML form,
     <img data-blob> (#82 P6); a file writes it into the body inline for
     older clients (inlineStateImages, 02c-blobs.js). The comment's field
     keeps the old name "visualImage" (#82 D5). */
  conflicts.forEach(function (c) {
    var image = c.field === "imageRef";
    var label = c.field === "audioText" ? "Audio" : c.field === "visualText" ? "Visual" :
      c.field === "title" ? "Title" : "Visual image";
    var isEmpty = !c.mine;
    var bodyHtml = image ? storedImageHtml(c.mine)
      : c.field === "title" ? escapeHtml(c.mine || "")
      : (c.mine || "");
    mergedComments.push({
      id: makeId("c"),
      rowId: c.rowId,
      field: image ? "visualImage" : c.field,
      imageValue: image ? (normalizeImageRef(c.mine) || null) : undefined,
      anchorId: null,
      quotedText: "",
      author: getEditorName(),
      body: bodyHtml,
      resolved: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      kind: "conflict",
      conflictField: label,
      emptyValue: isEmpty,
      /* plain text, kept alongside the escaped display body so restoring
         it doesn't need to round-trip back out of HTML */
      titleValue: c.field === "title" ? (c.mine || "") : undefined,
      replies: []
    });
  });

  /* Built by walking STATE_FIELDS (02-state.js), not from a hand-written
     literal. Invariant #4 used to live in a comment here: a field left out
     of that literal was destroyed on every merge, and the merge is the one
     code path every hosted save, every stash and every file merge goes
     through. Now a field the registry knows about cannot be left out, and
     one it does not know about throws rather than disappearing (#60). */
  var out = {};
  STATE_FIELDS.forEach(function (f) {
    switch (f.merge) {
      case "title":    out[f.key] = mergedTitle; break;
      /* Without this the document would come out of every server and
         stash merge with a fresh random id, orphaning its history. */
      case "doc-id":   out[f.key] = mergedDocId(base, mine, theirs); break;
      case "rows":     out[f.key] = merged; break;
      case "comments": out[f.key] = mergedComments; break;
      /* Each of these takes base: a union with no ancestor cannot tell a
         delete from an entry the other side simply never had, so every
         merge resurrected whatever either of us had removed (#61). */
      case "list-union-with-base":
        out[f.key] = f === tagField ? mergedTags : f.mergeList(base && base[f.key], mine[f.key], theirs[f.key]); break;
      case "changed-side-wins":
        out[f.key] = mergeChangedSideWins(f, base, mine, theirs); break;
      case "max-plus-one":
        out[f.key] = Math.max(theirs[f.key] || 0, mine[f.key] || 0) + 1; break;
      case "theirs-wins":
        out[f.key] = theirs[f.key] || mine[f.key] || null; break;
      case "constant": out[f.key] = SCHEMA_VERSION; break;
      default: throw new Error("no merge strategy for state field " + f.key);
    }
  });

  return {
    merged: migrateRows(out),
    conflicts: conflicts,
    stats: stats
  };
}

/* A list merge that only ever unions can never delete: whatever one side
   removed, the other side's copy puts back on the next merge, and on
   every merge after that, forever (#61). The row merge has had the right
   rule since the beginning — deleted on one side and untouched on the
   other since base means deleted — so the three list merges use it too.
   Anything else (deleted by one of us, edited by the other) still unions,
   which is the safe direction for a list nobody owns.

   `keyOf` is the identity the list merges by; `fingerprint` is everything
   else about an entry, so "untouched since base" is a string compare. */
function droppedListKeys(baseList, mineList, theirList, keyOf, fingerprint) {
  var dropped = {};
  /* No ancestor (a two-way merge, or a stash with nothing retained) means
     nothing can be called a delete rather than an addition. Union, as
     before. */
  if (!baseList || !baseList.length) return dropped;
  var mineBy = {}, theirBy = {};
  (mineList || []).forEach(function (e) { var k = e && keyOf(e); if (k) mineBy[k] = e; });
  (theirList || []).forEach(function (e) { var k = e && keyOf(e); if (k) theirBy[k] = e; });
  baseList.forEach(function (e) {
    var k = e && keyOf(e);
    if (!k) return;
    var m = mineBy[k], t = theirBy[k];
    if (m && t) return;          /* still on both sides — not a delete */
    if (!m && !t) return;        /* both of us dropped it; nothing to keep out */
    if (fingerprint(m || t) === fingerprint(e)) dropped[k] = true;
  });
  return dropped;
}

/* The crew list and the production registry are both append-mostly lists
   that nobody "owns" — dropping either side's would quietly lose work that
   no row diff can reconstruct (an assignment, a note, an item deliberately
   kept after being cut from the script). Union them, minus whatever one of
   us deleted and the other left alone. */
export function mergePeople(basePeople, minePeople, theirPeople) {
  /* Keyed by name, not id: a person is the same person to everyone
     reading the script, and the two sides can hold different ids for one
     name (each side minted its own on first mention). A rename is then a
     delete plus an add, which is what it reads as in the panel too. */
  var personKey = function (p) { return p.name ? normalizeTagName(p.name) : ""; };
  var dropped = droppedListKeys(basePeople, minePeople, theirPeople, personKey, personKey);
  var out = [], seenId = {}, seenName = {};
  (theirPeople || []).concat(minePeople || []).forEach(function (p) {
    if (!p || !p.name) return;
    var norm = normalizeTagName(p.name);
    if (dropped[norm]) return;
    if (seenId[p.id] || seenName[norm]) return;
    seenId[p.id] = true;
    seenName[norm] = true;
    out.push({ id: p.id, name: p.name });
  });
  return out;
}

export function mergeProductionTags(baseTags, mineTags, theirTags) {
  /* Merged by id (#85): a renamed item keeps its id, so a rename on one
     side and an assignment on the other are one item with both, not a
     delete plus an add. An entry with no id (from before ids; migrateRows
     gives every entry one, so only a caller that skipped it) falls back to
     its key. */
  var idOf = function (t) { return t.id || (t.name ? "key:" + registryKey(t.cat, t.name) : ""); };
  var tagPrint = function (t) {
    return JSON.stringify([t.cat || "", t.name || "", t.owner || "", t.notes || "",
                           (tagStatus(t.status) || TAG_STATUSES[0]).id]);
  };
  var dropped = droppedListKeys(baseTags, mineTags, theirTags, idOf, tagPrint);
  var baseById = {};
  (baseTags || []).forEach(function (t) { if (t && t.name) baseById[idOf(t)] = t; });
  var out = [], byId = {};
  function entryOf(t) {
    var e = { cat: t.cat, name: t.name, owner: t.owner || "", notes: t.notes || "",
              status: (tagStatus(t.status) || TAG_STATUSES[0]).id };
    if (t.id) e.id = t.id;
    return e;
  }
  (theirTags || []).forEach(function (t) {
    if (!t || !t.name) return;
    var k = idOf(t);
    if (dropped[k] || byId[k]) return;
    byId[k] = entryOf(t);
    out.push(byId[k]);
  });
  (mineTags || []).forEach(function (t) {
    if (!t || !t.name) return;
    var k = idOf(t);
    if (dropped[k]) return;
    var existing = byId[k];
    if (!existing) {
      byId[k] = entryOf(t);
      out.push(byId[k]);
      return;
    }
    /* a rename (or a category change) is taken from whichever side made
       it; both did, differently — theirs, like any other scalar */
    var b = baseById[k];
    if (b && existing.name === b.name && t.name !== b.name) existing.name = t.name;
    if (b && existing.cat === b.cat && t.cat !== b.cat) existing.cat = t.cat;
    /* same item on both sides: never let an empty field overwrite a filled
       one — an assignment or a note only I made still survives the merge */
    if (!existing.owner && t.owner) existing.owner = t.owner;
    if (!existing.notes && t.notes) existing.notes = t.notes;
    /* status merges by rank, the same way a scene's does: whoever got
       further wins. A merge can never un-buy a prop somebody bought. */
    if (tagStatusRank(t.status) > tagStatusRank(existing.status)) {
      existing.status = (tagStatus(t.status) || TAG_STATUSES[0]).id;
    }
  });
  /* Two ids can now name one item: both of us tagged a new name in a way
     that minted different ids, or one renamed onto a name the other had
     added. Fold them the way renameTag() folds a rename onto an existing
     name — the first keeps its id, an empty field never overwrites a
     filled one, and status keeps whichever is furthest along. */
  var byKey = {};
  return out.filter(function (e) {
    var key = registryKey(e.cat, e.name);
    var first = byKey[key];
    if (!first) { byKey[key] = e; return true; }
    if (!first.owner && e.owner) first.owner = e.owner;
    if (!first.notes && e.notes) first.notes = e.notes;
    if (tagStatusRank(e.status) > tagStatusRank(first.status)) first.status = e.status;
    return false;
  });
}

/* The b-roll list merges by id, not by name — two people can legitimately
   be tracking two different shots that read the same, and a rename on one
   side must not fuse them. Otherwise the rules are the production
   registry's: an empty field never overwrites a filled one, and a status
   can only move forward, so a merge can never un-shoot something somebody
   has already been out and shot. The reshoot flag ("Flagged") is the one that
   survives from either side — if one of them thinks it needs another look,
   it needs another look.

   A shot's hand-added props (#149) are a set, merged against the base the
   way the list itself is: a prop either side added is kept, one either
   side took off is gone unless the other side still has it and had it
   from the start — i.e. the other side left it alone. So both sides'
   additions survive, and a removal is not undone by the copy that never
   saw it. Keyed by brollPropKey (the registry id, or the name). */
export function mergeBrollShots(baseShots, mineShots, theirShots) {
  var shotKey = function (b) { return b.id || ""; };
  /* Everything but the id, in a fixed key order so two equal shots print
     equal whatever order their keys were written in. */
  var shotPrint = function (b) {
    return JSON.stringify(Object.keys(b).filter(function (k) { return k !== "id"; }).sort()
      .map(function (k) { return [k, b[k]]; }));
  };
  var dropped = droppedListKeys(baseShots, mineShots, theirShots, shotKey, shotPrint);
  var baseById = {};
  (baseShots || []).forEach(function (b) { if (b && b.id && !baseById[b.id]) baseById[b.id] = b; });
  var out = [], byId = {};
  (theirShots || []).forEach(function (b) {
    if (!b || !b.id || byId[b.id] || dropped[b.id]) return;
    byId[b.id] = cloneState(b);
    out.push(byId[b.id]);
  });
  (mineShots || []).forEach(function (b) {
    if (!b || !b.id || dropped[b.id]) return;
    var existing = byId[b.id];
    if (!existing) { byId[b.id] = cloneState(b); out.push(byId[b.id]); return; }
    if (!existing.owner && b.owner) existing.owner = b.owner;
    if (!existing.notes && b.notes) existing.notes = b.notes;
    if (!existing.audioRef && b.audioRef) existing.audioRef = b.audioRef;
    if (!existing.location && b.location) existing.location = b.location;
    if (b.status === "shot") existing.status = "shot";
    if (b.reshoot) existing.reshoot = true;
    var base = baseById[b.id];
    existing.props = mergeBrollProps(base ? base.props : null, b.props, existing.props);
  });
  return out;
}

/* The three-way set merge of one shot's props (see mergeBrollShots). With
   no base copy of the shot (it is new on both sides, or a two-way merge)
   nothing can be called a removal, so it unions. Theirs' order first, then
   what only I added; capped the way migrateRows caps it. */
function mergeBrollProps(baseProps, mineProps, theirProps) {
  function keyed(list) {
    var by = {}, order = [];
    (Array.isArray(list) ? list : []).forEach(function (p) {
      if (!p || typeof p !== "object" || !p.name) return;
      var k = brollPropKey(p.id, p.name);
      if (by[k]) return;
      by[k] = p;
      order.push(k);
    });
    return { by: by, order: order };
  }
  var base = keyed(baseProps), mine = keyed(mineProps), theirs = keyed(theirProps);
  var hasBase = Array.isArray(baseProps);
  var out = [];
  function keep(k) {
    var inMine = !!mine.by[k], inTheirs = !!theirs.by[k], inBase = !!base.by[k];
    if (inMine && inTheirs) return true;
    return !hasBase || !inBase;
  }
  theirs.order.forEach(function (k) {
    if (keep(k)) out.push({ id: theirs.by[k].id || "", name: theirs.by[k].name });
  });
  mine.order.forEach(function (k) {
    if (!theirs.by[k] && keep(k)) out.push({ id: mine.by[k].id || "", name: mine.by[k].name });
  });
  return out.slice(0, BROLL_PROPS_MAX);
}

/* Reading speed was theirs-wins, silently: set it to 180 here and the next
   merge with a server copy still on 150 put it back, with nothing to show
   for the change (#61). Base-aware, it behaves like any other plain scalar
   — whoever moved it off base wins, theirs if we both did — so this is the
   strategy rather than that one field's special case. */
function mergeChangedSideWins(f, base, mine, theirs) {
  var m = mine[f.key], t = theirs[f.key];
  var fallback = f.def ? f.def() : null;
  if (base && t === base[f.key] && m !== base[f.key]) return m || fallback;
  return t || m || fallback;
}

/* ---- conflict stash (survives the reload the shell forces on us) ----

   The stash names its pictures the way the document does, by imageRef
   (#82). What the durable blob store does not hold yet travels with it as
   `blobs: {sha: data URI}`, so the reload cannot lose a picture this page
   only had in memory; what the store holds needs no copy. There is no
   image-stripping fallback any more: a stash too big for sessionStorage is
   not written, and the caller does not reload (it never could throw the
   work away). */
function stashBlobsFor(docs) {
  var blobs = {}, any = false;
  docs.forEach(function (d) {
    refsIn(d).forEach(function (sha) {
      if (blobs[sha] || isDurableSync(sha)) return;
      var url = dataUrlForSync(sha);
      if (url) { blobs[sha] = url; any = true; }
    });
  });
  return any ? blobs : null;
}

/* Returns true only if the work is genuinely persisted. The caller MUST NOT
   force a reload on false — that would throw the work away. */
export function stashLocalWork() {
  if (!S.state) return false;
  var payload = { at: nowIso(), by: getEditorName(), base: S.baseState, mine: S.state };
  var blobs = stashBlobsFor([S.state, S.baseState]);
  if (blobs) payload.blobs = blobs;
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify(payload));
    return true;
  } catch (e) { return false; }
}

/* Makes a stash (or a crash draft handed over as one) ready to merge:
   its carried `blobs` interned — each re-hashed, so a copy that is not
   what its key says is simply not the picture — and, for ONE RELEASE, the
   stash an older build wrote when the document was too big: every image
   replaced by the sentinel "__IMAGE__" with `imagesStripped` set. Whether
   such a row's picture changed cannot be known, so it takes `theirs`'s
   picture for that row (the old merge raised an empty conflict card and
   kept theirs; the card had nothing in it to restore). Changes the stash
   in place and returns it. */
export function acceptStash(stash, theirs) {
  if (!stash || typeof stash !== "object") return stash;
  if (stash.blobs && typeof stash.blobs === "object") {
    Object.keys(stash.blobs).forEach(function (sha) {
      if (isSha256Hex(sha) && typeof stash.blobs[sha] === "string") internDataUrl(stash.blobs[sha]);
    });
  }
  if (stash.imagesStripped) {
    var theirRows = byId(theirs && Array.isArray(theirs.rows) ? theirs.rows : []);
    [stash.mine, stash.base].forEach(function (doc) {
      if (!doc || !Array.isArray(doc.rows)) return;
      doc.rows.forEach(function (r) {
        if (!r || r.visualImage !== "__IMAGE__") return;
        var t = theirRows[r.id];
        delete r.visualImage;
        r.imageRef = t && t.imageRef ? JSON.parse(JSON.stringify(t.imageRef)) : null;
      });
    });
    delete stash.imagesStripped;
  }
  return stash;
}

export function clearStash() {
  try { sessionStorage.removeItem(STASH_KEY); } catch (e) {}
}

export function readStash() {
  try {
    var raw = sessionStorage.getItem(STASH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/* ---- identity ---- */

export function updateIdentityChip() {
  var name = getSavedAuthorName();
  document.getElementById("identity-name").textContent = name || "Set your name";
  document.getElementById("identity-chip").classList.toggle("unnamed", !name);
}

export function promptForName() {
  var current = getSavedAuthorName();
  var host = document.getElementById("identity-chip");
  var existing = document.getElementById("identity-editor");
  if (existing) { existing.remove(); return; }
  var wrap = document.createElement("span");
  wrap.id = "identity-editor";
  wrap.className = "link-popover";
  wrap.style.position = "absolute";
  wrap.style.zIndex = "170";
  wrap.style.background = "var(--surface)";
  wrap.style.border = "1px solid var(--border)";
  wrap.style.borderRadius = "8px";
  wrap.style.padding = "8px";
  wrap.style.boxShadow = "var(--shadow)";
  wrap.innerHTML =
    '<input type="text" id="identity-input" placeholder="Your name" value="' + escapeHtml(current) + '">' +
    '<button type="button" id="identity-save">Save</button>';
  host.parentNode.insertBefore(wrap, host.nextSibling);
  var input = document.getElementById("identity-input");
  input.focus();
  input.select();
  function commit() {
    var v = (input.value || "").trim();
    if (v) saveAuthorName(v);
    wrap.remove();
    updateIdentityChip();
    render();
  }
  document.getElementById("identity-save").addEventListener("click", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); wrap.remove(); }
  });
}

/* Reading speed lives on the document (see migrateRows), so the estimate
   reads the same for whoever opens the file next. Same inline-popover
   pattern as promptForName. */
export function promptForWpm() {
  if (!S.state) return;
  var host = document.getElementById("runtime-chip");
  var existing = document.getElementById("wpm-editor");
  if (existing) { existing.remove(); return; }
  var wrap = document.createElement("span");
  wrap.id = "wpm-editor";
  wrap.className = "link-popover";
  wrap.style.position = "absolute";
  wrap.style.zIndex = "170";
  wrap.style.background = "var(--surface)";
  wrap.style.border = "1px solid var(--border)";
  wrap.style.borderRadius = "8px";
  wrap.style.padding = "8px";
  wrap.style.boxShadow = "var(--shadow)";
  wrap.innerHTML =
    '<input type="number" id="wpm-input" min="60" max="400" step="5" value="' +
      escapeHtml(String(S.state.wordsPerMinute || DEFAULT_WPM)) + '" aria-label="Words per minute">' +
    '<button type="button" id="wpm-save">Set</button>';
  host.parentNode.insertBefore(wrap, host.nextSibling);
  var input = document.getElementById("wpm-input");
  input.focus();
  input.select();
  function commit() {
    var v = Math.round(Number(input.value));
    if (isFinite(v) && v >= 60 && v <= 400 && v !== S.state.wordsPerMinute) {
      S.state.wordsPerMinute = v;
      markDirty();
      render();
      queueAutoSave();
    }
    wrap.remove();
  }
  document.getElementById("wpm-save").addEventListener("click", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); wrap.remove(); }
  });
}

/* ---- version history panel ---- */

/* All the side panels are fixed over the same right-hand strip, so only
   one can be open at a time — opening one always closes the others first,
   otherwise they silently stack on top of each other (whichever is later
   in the DOM wins the pixels) and closing the top one leaves the one
   underneath still "open" with nothing accounting for its layout space. */
export function openSidePanel(id) {
  SIDE_PANEL_IDS.forEach(function (pid) {
    if (pid !== id) {
      var el = document.getElementById(pid);
      if (el) el.hidden = true;
    }
  });
  document.getElementById(id).hidden = false;
  /* Only one panel is ever open at a time, so the width that #root's
     padding-right should track (see body.panel-open #root in app.css)
     is whichever one is being opened right now — set every time, not
     just at boot (03b-side-panels.js). */
  applySidePanelWidth(id, readSidePanelWidth(id));
  syncPanelClass();
}

export function openHistoryPanel() {
  openSidePanel("history-panel");
  renderHistory();
}
export function closeHistoryPanel() {
  var p = document.getElementById("history-panel");
  if (p) p.hidden = true;
  syncPanelClass();
}

/* a side panel is fixed over the right edge — shift the document so it never
   covers the toolbar that opened it */
export function syncPanelClass() {
  var open = SIDE_PANEL_IDS.some(function (pid) {
    var el = document.getElementById(pid);
    return el && !el.hidden;
  });
  document.body.classList.toggle("panel-open", open);
}

/* Async, because the list comes from IndexedDB or the desktop store. Every
   call takes a token; a result that comes back after a newer render began
   is dropped, and so is a result for a document that is no longer the one
   on screen — otherwise a slow read could paint document A's snapshots
   over document B's panel, where "Restore" would then pull A's content
   into B.

   No caller needs to re-render after a write: captureSnapshot, copyHistory,
   the pending retry and the migration already call this when they settle
   (03a-history-store.js). */
var historyRenderToken = 0;

var HISTORY_SUBTITLES = {
  idb: "Snapshots of this document, kept in this browser before anything that could overwrite your work.",
  desktop: "Snapshots of this document, kept on this computer before anything that could overwrite your work.",
  memory: "Snapshots of this document, kept only until this page closes — this browser isn't letting Splitpage store them."
};
var HISTORY_SUBTITLE_DEFAULT = "Snapshots of this document, kept before anything that could overwrite your work.";

function historyCardHtml(m, bucket) {
  var status = m.status === "writing" || m.status === "pending" ? m.status : "stored";
  var rows = Math.max(0, Math.floor(Number(m.rows) || 0));
  var armed = restoreArmedKey !== null && restoreCardKey(bucket, m.id) === restoreArmedKey;
  return '<div class="history-card' + (status === "writing" ? " is-writing" : status === "pending" ? " is-pending" : "") + '">' +
    (bucket === "older" ? '<div class="history-card-doc">' + escapeHtml(m.title || "Untitled") + '</div>' : "") +
    '<div class="history-card-label">' + escapeHtml(m.label || "Snapshot") +
      (status === "pending" ? '<span class="history-card-badge" title="Kept in this window only, and tried again after the next successful write">Not stored</span>' : "") +
    '</div>' +
    '<div class="history-card-meta">' + escapeHtml(formatTimestamp(m.at)) + ' · ' + escapeHtml(m.by || "") +
      ' · ' + rows + ' row' + (rows === 1 ? "" : "s") + '</div>' +
    '<button type="button" data-action="restore-snapshot" data-id="' + escapeHtml(safeId(m.id, "s")) + '"' +
      (bucket === "older" ? ' data-bucket="older"' : "") +
      (armed ? ' class="armed"' : "") + '>' + escapeHtml(armed ? RESTORE_ARMED_LABEL : RESTORE_LABEL) + '</button>' +
    '</div>';
}

function historyUsageText(backend, usage) {
  if (!usage || typeof usage !== "object") return "";
  if (usage.readOnly && backend === "desktop") {
    return "Version history is read-only: it was written by a newer version of Splitpage.";
  }
  var used = driveFormatSize(usage.totalBytes) || "0 KB";
  var cap = Number(usage.capBytes);
  var docs = Math.max(0, Math.floor(Number(usage.docCount) || 0));
  /* The memory backend's cap is our own RAM bound, not storage the user
     has — quoting it as "of 50 MB" would suggest a disk budget. */
  var text = "Version history uses " + used +
    (backend !== "memory" && isFinite(cap) && cap > 0 ? " of " + driveFormatSize(cap) : "") +
    " across " + docs + " document" + (docs === 1 ? "" : "s") + ".";
  if (usage.overCap) text += " It is over its limit, so older snapshots are being removed first.";
  return text;
}

export async function renderHistory() {
  var listEl = document.getElementById("history-list");
  var panel = document.getElementById("history-panel");
  if (!listEl || !panel || panel.hidden || !S.state) return;
  var token = ++historyRenderToken;
  var docId = normalizeDocId(S.state.docId);
  var data;
  try {
    data = await listDocHistory(docId);
  } catch (e) {
    if (window.console) console.error(e);
    return;
  }
  if (token !== historyRenderToken) return;       /* a newer render owns the panel */
  if (!S.state || panel.hidden) return;
  if (normalizeDocId(S.state.docId) !== docId) {
    /* The document changed under this read and nothing newer has asked
       for a render yet — draw the current document instead of leaving
       the old list up. Bounded: it recurses only when the id moved. */
    return renderHistory();
  }
  data = data || {};

  var subtitle = document.getElementById("history-subtitle");
  if (subtitle) subtitle.textContent = HISTORY_SUBTITLES[data.backend] || HISTORY_SUBTITLE_DEFAULT;

  var entries = Array.isArray(data.entries) ? data.entries : [];
  /* One line while the store is moving to its new format, could not finish
     that, or is read-only (#83, listDocHistory): in place of "No snapshots"
     when the list is empty — which it may only look — else in place of the
     usage line. */
  var notice = typeof data.notice === "string" ? data.notice : "";
  if (!entries.length && notice) {
    listEl.innerHTML = '<div class="comments-empty history-notice">' + escapeHtml(notice) + '</div>';
  } else if (!entries.length) {
    listEl.innerHTML = '<div class="comments-empty">No snapshots of this document yet. Splitpage saves one automatically before anything that could overwrite your work — opening a document, replacing rows, or merging someone else\'s changes.</div>';
  } else {
    listEl.innerHTML = entries.map(function (m) { return historyCardHtml(m, "doc"); }).join("");
  }

  var olderEl = document.getElementById("history-older");
  var olderSummary = document.getElementById("history-older-summary");
  var olderList = document.getElementById("history-older-list");
  var older = Array.isArray(data.older) ? data.older : [];
  if (olderEl) olderEl.hidden = !older.length;
  if (olderSummary) olderSummary.textContent = "Older history (before per-document history) · " + older.length;
  if (olderList) {
    olderList.innerHTML = older.map(function (m) {
      return historyCardHtml({
        id: m.id, label: m.label, at: m.at, by: m.by, rows: m.rows, title: m.title, status: "stored"
      }, "older");
    }).join("");
  }

  var usageEl = document.getElementById("history-usage");
  if (usageEl) {
    var usageText = notice ? (entries.length ? notice : "") : historyUsageText(data.backend, data.usage);
    usageEl.textContent = usageText;
    usageEl.hidden = !usageText;
  }
}

/* ---- merge reporting ---- */

/* {id, docId, source} of the undo point the last merge filed ("Before
   merging …"), or null. The docId is kept because history is per document:
   after another document is opened, "Undo merge" must not pull the
   merged-away version of the first one into it. `source` is applyMerge's,
   and says which version the snapshot holds — see undoMerge. */
S.lastMergeUndo = null;
var undoArmed = false;
var undoArmTimer = null;
/* Set to the lastMergeUndo it applies to when an undo came back
   'no-backup'; the user's next confirm then restores anyway. */
var undoMergeForceFor = null;

/* `opts.alreadySaved` is for the hosted path, where the merge happened
   *during* a save and the merged result is already on the server by the
   time we report it. Without it the report marks the document dirty and
   queues another write of identical content — and every needless rev bump
   pushes every other viewer into a 409 and a merge they did not need.

   `opts.noAutoSave` still marks the document dirty — the merged version on
   screen is genuinely not what is on disk — but writes nothing. Crash-draft
   restore (20g-drafts.js) passes it: Splitpage never writes the user's file
   on its own (invariant #41), least of all with a merge the user has not
   seen yet, done against a file they did not open. Their next Save writes
   it, as it would any other unsaved change.

   `opts.undo` is what the banner's "Undo merge" may promise, because the
   merges it reports are not all the same kind (#97):
     undefined  the button as it always was: go back to the version that
                was live before the merge
     "saved"    saveToServer's 409. The undo point is the version the user
                was SAVING, and the merge is already on the server, so
                undoing is local: it puts their version back on screen,
                dirty, and the next save — judged against the rev the
                merge's own save came back with, and measured from the
                merged base — writes it over the merged copy. The banner
                says so.
     false      no button. The pull channel (#69) files no undo point on
                purpose, and undoing a pull would mean throwing away a
                collaborator's saved work, which is not what the button
                promises.
   Whatever `undo` says, there is no button while nothing is armed: a
   button that can only answer "No merge snapshot to undo." is the bug
   this replaced. */
var UNDO_SAVED_NOTE = "Undo merge puts your version back here; the next save replaces the merged copy on the server.";
var UNDO_SAVED_TITLE = "Go back to the version you were saving, before someone else's changes were merged into it. " +
  "It stays unsaved until the next save, which replaces the merged copy on the server. Recoverable from Version history.";
var undoTitleDefault = null;

export function reportMerge(result, opts) {
  opts = opts || {};
  var s = result.stats;
  var bits = [];
  if (s.rowsFromMe) bits.push(s.rowsFromMe + " row" + (s.rowsFromMe === 1 ? "" : "s") + " you edited");
  if (s.rowsAddedByMe) bits.push(s.rowsAddedByMe + " row" + (s.rowsAddedByMe === 1 ? "" : "s") + " you added");
  if (s.rowsFromThem) bits.push(s.rowsFromThem + " changed by someone else");
  if (s.rowsAddedByThem) bits.push(s.rowsAddedByThem + " added by someone else");

  /* nothing actually differed — don't make a ceremony of it */
  if (!bits.length && !result.conflicts.length) {
    if (!opts.alreadySaved) { markDirty(); noteMergeAutoSave(opts); }
    return;
  }

  var summary = bits.length ? "Kept " + bits.join(", ") + "." : "Nothing was lost.";
  if (result.conflicts.length) {
    summary += " " + result.conflicts.length + " edit" + (result.conflicts.length === 1 ? " was" : "s were") +
      " changed on both sides — your version is saved as a comment.";
  }

  var undoBtn = document.getElementById("merge-undo");
  if (undoTitleDefault === null) undoTitleDefault = undoBtn.title;
  var offerUndo = opts.undo !== false && !!S.lastMergeUndo;
  undoBtn.hidden = !offerUndo;
  undoBtn.title = opts.undo === "saved" ? UNDO_SAVED_TITLE : undoTitleDefault;
  if (offerUndo && opts.undo === "saved") summary += " " + UNDO_SAVED_NOTE;

  document.getElementById("merge-summary").textContent = " " + summary;
  document.getElementById("merge-review").hidden = !result.conflicts.length;
  var banner = document.getElementById("merge-banner");
  /* .notice-merge.notice-warn (app.css) flags a merge as urgent — red
     border/background instead of the plain green — but nothing ever
     added the class, so a merge that actually lost data on one side
     (real conflicts, saved as comments below) looked exactly like an
     ordinary clean merge. */
  banner.classList.toggle("notice-warn", !!result.conflicts.length);
  banner.hidden = false;

  /* flash the rows that came from the merge */
  result.conflicts.forEach(function (c) {
    var el = document.querySelector('#rows .row[data-id="' + safeId(c.rowId, "r") + '"]');
    if (el) el.classList.add("just-merged");
  });

  if (!opts.alreadySaved) { markDirty(); noteMergeAutoSave(opts); }
}

/* markDirty() arms the typing autosave (14-export.js) like any other edit,
   which is exactly what `noAutoSave` exists to prevent — and not just for
   this instant: the next keystroke would arm it again and write the same
   unreviewed merge a second later. So the merge halts autosave outright,
   and the Save the user presses when they have looked it over is what puts
   it back to work. The indicator beside the Save button carries the reason
   in the meantime (12-dirty-toast.js). */
function noteMergeAutoSave(opts) {
  if (!opts.noAutoSave) { queueAutoSave(); return; }
  haltAutoSave("Autosave is paused — changes recovered for you are on screen but not in your file yet. " +
               "Press Save once you have looked them over.");
}

/* ---- one merge orchestration, not four copies (#72) ----

   Every merge in this app ran the same sequence by hand: file the undo
   point, merge, adopt the result, let the history follow the id if theirs
   won it, reassign `baseState`, redraw, say what happened. It was written
   out five times — saveToServer's 409 and two of resumeServerDoc's merges
   (13-hosted.js), applyStashedWork (14-export.js) and, through it,
   confirmFileMerge (18a-local-merge.js) — which is five chances for one
   copy to drift from the others, and one already had: the 409 path filed
   an undo snapshot and never armed the button that would use it. #72 gave
   that divergence a name (`armUndo:false`); #97 removed it, so an undo
   point asked for is an undo point armed, on every path.

   THE ONE WRITER OF `baseState` on the merge paths. The base a merge
   measures against has to be exactly what the other side last confirmed
   (HANDOFF §3.6); it stopped being that because six places assigned it.
   Since #96 that includes the boot stash (21-events.js) and the crash-draft
   file merge (20g-drafts.js), which used to adopt applyStashedWork's result
   by hand. Every write of it that is NOT a merge goes through setBaseState()
   below, with its reason, so a grep for assignments to it lists the declaration,
   this function and that one — and nothing else.

   What varies between callers is options, never code:

     base, mine, theirs   the three documents; normalised here, so a caller
                          hands over whatever it is holding
     source               which merge this is — names the undo point's label
     undoPoint            the state the undo snapshot captures: the version
                          the merge REPLACES, which is `theirs` at load time
                          and `mine` in the middle of a save. Omitted files
                          no snapshot and leaves "Undo merge" as it was.
     keepLabel            a second snapshot, of `mine`, so a version that was
                          recovered from somewhere is a version in the history
                          rather than something that only existed in a function
     unchanged            the two sides are identical, so there is nothing to
                          merge: adopt `theirs`, and skip the snapshot, the
                          merge and the rev bump it would carry
     mergeOnly            merge and file the undo point, hand the result back,
                          and change nothing on screen — applyStashedWork's
                          three callers each do something different next
     awaitUndoPoint       adopt nothing until the undo point's write has
                          settled (invariant #39: the undo point is ON DISK
                          before the merged version replaces what the user
                          can see). The crash-draft file merge asks for it
                          (20g-drafts.js); boot and the other paths do not
                          wait. With it the answer is a Promise, always —
                          even when no snapshot was filed.
     newBase              what `baseState` becomes; omitted leaves it alone.
                          A function is called at that moment instead, for
                          a base that is not final until the merge has begun
                          (boot: applyStashedWork gives `loaded` the stash's
                          id first).
     historyFrom          the id this view wrote history under before the
                          merge, for noteMergedDocId
     chips                refresh the identity and file chips as well
     report               false hands the merge back unreported — no banner,
                          and no dirty mark when nothing merged either. The
                          409 path reports only once the merged version is
                          actually stored, so the banner can never describe
                          a merge that failed to save; boot reports after
                          its chips and menus, and adopting a stash that
                          matched what the page loaded leaves it clean.
     noAutoSave           reportMerge's: mark dirty, write nothing
     toast                {text, tone, sticky}; `text` may be a function,
                          called once the merged document is on screen

   → {state, result, snapshot} (a Promise of it with awaitUndoPoint).
   `result` is null when nothing differed. */
var UNDO_LABELS = {
  "server-conflict": "Before merging in someone else's changes",
  "server-resume": "Before merging your recovered changes",
  "stash": "Before merging your unsaved changes"
};

export function applyMerge(opts) {
  opts = opts || {};
  var result = null;
  var snap = null;

  if (!opts.unchanged) {
    /* Synchronous, and the ticket is kept: the undo point has to be known
       before anything replaces what it is a point back to (invariant #39). */
    if (opts.undoPoint) snap = pushSnapshot(UNDO_LABELS[opts.source], opts.undoPoint);
    if (opts.keepLabel) pushSnapshot(opts.keepLabel, opts.mine);
    result = mergeStates(
      opts.base ? migrateRows(cloneState(opts.base)) : null,
      migrateRows(cloneState(opts.mine)),
      opts.theirs
    );
  }
  var next = result ? result.merged : opts.theirs;

  /* Asked for an undo point and the store refused it (a document too large
     to serialise, a full quota): the button must not be left pointing at
     some EARLIER merge of this same document, which is a version from
     before work this one has nothing to do with. */
  function armUndoPoint(docId) {
    if (!opts.undoPoint) return;
    S.lastMergeUndo = snap ? { id: snap.id, docId: docId, source: opts.source } : null;
  }

  if (opts.mergeOnly) {
    /* Nothing has been adopted yet, so the id the undo point was filed
       under is the only one there is. The caller adopts `next` next. */
    armUndoPoint(snap && snap.docId);
    return { state: next, result: result, snapshot: snap };
  }

  function adopt() {
    /* Someone else's changes arriving are not an edit of this tab's: the
       undo stack records what was typed here first, then forgets what the
       merge changed (design D4), so Ctrl+Z never reverts their words. */
    noteRemoteChange(next);
    S.state = next;
    /* Before the undo point is armed: noteMergedDocId may have just moved
       this document's history to the merged id, and undoMerge compares what
       it holds against state.docId before restoring. */
    if (opts.historyFrom) noteMergedDocId(opts.historyFrom);
    armUndoPoint(S.state.docId);
    if (opts.newBase !== undefined) {
      baseStateWhy = "merge: " + (opts.source || "");
      S.baseState = typeof opts.newBase === "function" ? opts.newBase() : opts.newBase;
    }
    render();
    if (opts.chips) { updateIdentityChip(); updateFileChip(); }
    if (result) {
      if (opts.report !== false) reportMerge(result, { noAutoSave: !!opts.noAutoSave });
    } else if (opts.report !== false) {
      /* Nothing merged, but `theirs` still replaced what was on screen and
         is not what is on disk or on the server. */
      markDirty();
    }
    if (opts.toast) {
      /* `text` may be a function, called here rather than by the caller: the
         sentence usually names the document, and its title is the MERGED
         one — which does not exist until the lines above have run. */
      var said = typeof opts.toast.text === "function" ? opts.toast.text() : opts.toast.text;
      if (said) showToast(said, opts.toast.tone || "ok", !!opts.toast.sticky);
    }
    return { state: next, result: result, snapshot: snap };
  }

  if (!opts.awaitUndoPoint) return adopt();
  /* The one place a merge waits for its snapshot (invariant #39). A write
     that failed still settles — enqueueHistory answers {stored:false} —
     and a failed history write must never become a failed merge. */
  var written = snap && snap.done ? snap.done : null;
  return Promise.resolve(written).then(null, function () {}).then(adopt);
}

/* ---- the base, when it is not a merge (#96) ----

   `baseState` is the ancestor every three-way merge measures against, and
   it has to be exactly what the other side last confirmed (HANDOFF §3.6).
   applyMerge above sets it on a merge path. Every other write is "adopt
   exactly what was just confirmed" after a successful save, publish or
   open — or `null`, "there is no ancestor" — and comes through here, so
   the whole list is one grep and each entry says why it is there.

   `why` is that reason, a few words at the call site. It is kept only as
   the last one (baseStateReason, for a unit test or a console), never
   logged or stored. `next` is taken as it is: a caller that still holds
   the object it passes clones it first, as every one of them always has. */
var baseStateWhy = "";

export function setBaseState(next, why) {
  baseStateWhy = String(why || "");
  S.baseState = next;
  return next;
}

/* Why `baseState` last changed: setBaseState's `why`, or "merge: <source>"
   when applyMerge set it. */
export function baseStateReason() {
  return baseStateWhy;
}

/* Reverts to the undo point the merge filed. Destructive enough to need a
   confirm, and recoverable afterwards because restoreSnapshot snapshots
   first. What it discards depends on which version that undo point is:

     most merges      the version that was live before the merge (`theirs`
                      at load time), so undoing discards the work the merge
                      just rescued — "Discard my edits?"
     server-conflict  saveToServer's 409, whose undo point is the version
                      the user was SAVING. Undoing puts that back and
                      discards what the merge brought in from the other
                      side — "Drop their changes?". The merged copy is
                      already on the server; what is restored here stays
                      local and dirty (restoreSnapshot's `local`: the
                      autosave preference decides when it is written, and
                      nothing forces a write), and the next save — Save,
                      or autosave's idle timer when that is on — carries
                      `baseRev` = the rev that merged save came back with,
                      so it is accepted and replaces the merged copy. If
                      somebody saved in the meantime, the merge that brings
                      their save in (that save's 409, or a pull) measures
                      against the merged base, so it counts the undone
                      changes as this side's edits and keeps them undone. */
var UNDO_CONFIRM = { "server-conflict": "Drop their changes?" };
var UNDO_LOCAL = { "server-conflict": true };
var UNDO_RESTORED = {
  "server-conflict": "Your version is back, unsaved. The next save replaces the merged copy on the server."
};

export function undoMerge(btn) {
  if (!S.lastMergeUndo) { showToast("No merge snapshot to undo.", "warn"); return; }
  if (!S.state || S.lastMergeUndo.docId !== S.state.docId) {
    showToast("That merge belongs to a different document, so there is nothing to undo here.", "warn");
    return;
  }
  if (undoArmed) {
    clearTimeout(undoArmTimer);
    undoArmed = false;
    btn.textContent = "Undo merge";
    btn.classList.remove("armed");
    var undo = S.lastMergeUndo;
    var force = undoMergeForceFor === undo;
    undoMergeForceFor = null;
    restoreSnapshot(undo.id, {
      force: force,
      local: !!UNDO_LOCAL[undo.source],
      restoredText: UNDO_RESTORED[undo.source]
    }).then(function (r) {
      if (r === "no-backup") {
        undoMergeForceFor = undo;
        showToast("Couldn't keep a backup of your current version. Undo the merge again to discard your edits anyway.", "warn");
      } else if (r === "missing") {
        showToast("The snapshot from before the merge is no longer in the history.", "warn");
      } else if (r === "corrupt") {
        showToast("The snapshot from before the merge could not be read, so nothing was undone.", "warn");
      } else if (r === "changed") {
        showToast("A different document was opened while undoing, so nothing was undone.", "warn");
      }
    }, function (e) { if (window.console) console.error(e); });
    return;
  }
  undoArmed = true;
  btn.textContent = UNDO_CONFIRM[S.lastMergeUndo.source] || "Discard my edits?";
  btn.classList.add("armed");
  clearTimeout(undoArmTimer);
  undoArmTimer = setTimeout(function () {
    undoArmed = false;
    btn.textContent = "Undo merge";
    btn.classList.remove("armed");
  }, 3000);
}

export function findRowIndex(id) {
  for (var i = 0; i < S.state.rows.length; i++) {
    if (S.state.rows[i].id === id) return i;
  }
  return -1;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
