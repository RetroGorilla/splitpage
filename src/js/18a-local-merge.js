import { S } from "./_state.js";
import { fileHome } from "./_home.js";
import { rowStatus } from "./01-scene-status.js";
import { escapeHtml, migrateRows } from "./02-state.js";
import { normalizeDocId } from "./02b-doc-id.js";
import { blobImgHtml, rowImage, rowImageKey } from "./02c-blobs.js";
import { ROW_FIELDS, byId, cloneState, mergeTextField, rowContentEqual, textMergeContext } from "./03-sync.js";
import { safeImageSrc } from "./04-richtext.js";
import { pad2 } from "./05-render.js";
import {
  normalizeTagName,
  registryKey,
  tagCategory,
  tagStatus
} from "./07-production-tags.js";
import { applyStashedWork, htmlToPlainText } from "./14-export.js";
import { closeFileConflict, parseProjectFileState } from "./18-local-files.js";

/* ================= merging a local file that changed on disk =================

   The on-disk conflict guard (checkFileConflict, 18-local-files.js) used to
   offer four outcomes, and every one of them means picking one version
   whole, sight unseen. "Merge them" is the fifth: it lists every field the
   two versions disagree about, side by side, and only then runs the same
   three-way mergeStates() the hosted save and the crash-draft restore
   already run. Nothing is read into the document and nothing is written to
   disk until the user confirms (HANDOFF #1) — Cancel leaves the file, the
   document and the modal exactly as they were.

   The merge is genuinely three-way wherever there is an ancestor to use:
   the state as parsed at the last read from, or write to, THIS file is
   kept on the file's own home record (home.diskBase, _home.js, set by
   adoptProjectState and by saveDoc's successful write). Keeping it there
   rather than in a variable of its own means it is dropped the moment the
   document's home changes, and can never be mistaken for some other
   file's ancestor. With no ancestor at all it degrades to the two-way
   merge mergeStates already does, where everything that differs becomes a
   conflict comment: nothing is lost either way, there is just far more to
   review. */

/* What "Merge them" would merge, parsed once when the conflict modal goes
   up: {theirs, base, home, fileName, lastModified}, or null while there is
   nothing mergeable on disk. */
var mergeCandidate = null;
/* A second conflict can raise the modal while the first probe is still
   reading — only the newest one may reveal the button. */
var mergeProbeToken = 0;

/* The common ancestor for a local-file merge, or null for a two-way one. */
function fileMergeBase(home) {
  if (home && home.diskBase) return home.diskBase;
  /* saveDoc() sets baseState to exactly what it wrote (HANDOFF §3.6), so on
     the project path it holds the same ancestor — the fallback for a
     document that reached this file by a route predating diskBase (a
     crash-draft restore, a boot stash merge). Only ever this document's. */
  if (home && home === fileHome() && S.baseState && S.state &&
      normalizeDocId(S.baseState.docId) === normalizeDocId(S.state.docId)) return S.baseState;
  return null;
}

export function resetMergeOffer() {
  mergeCandidate = null;
  mergeProbeToken++;
  var btn = document.getElementById("file-conflict-merge");
  if (btn) btn.hidden = true;
}

/* Can the version now on disk be read back as a document? Only then is
   there anything to merge with. A .docx, a .csv, a .txt or somebody else's
   .md re-read through loadFileIntoEditor() comes back with fresh row ids,
   which mergeStates would read as "every scene deleted and every scene
   added again" — and the import re-save path writes exactly those formats
   (buildFileData's lossy exports, never a project file), so "Merge them"
   simply never appears there. The parse is told not to raise the
   row-count question (noAsk): nothing may put a second modal on screen
   for a merge nobody has asked for yet. */
export async function offerFileMerge(currentFile, home) {
  resetMergeOffer();
  var token = mergeProbeToken;
  if (!currentFile || !S.state) return;
  var parsed;
  try {
    parsed = await parseProjectFileState(currentFile, { noAsk: true });
  } catch (e) {
    parsed = null;
  }
  if (token !== mergeProbeToken) return;   /* a newer conflict owns the modal */
  if (!parsed || parsed.error || !parsed.state) return;

  var theirs = parsed.state;
  var base = fileMergeBase(home);
  /* THE docIdEmbedded RULE, the same one restoreFileDraft() applies
     (20g-drafts.js): a file that carries its own id and now carries a
     DIFFERENT one is a different script saved into the same place, and
     splicing two unrelated scripts together is not a merge. Anything else
     — above all a legacy file whose id is derived from its own bytes, and
     whose bytes have just changed — is still this file, so line the disk
     copy up with the document's identity before merging, or mergedDocId
     would take the freshly derived id and split the version history. */
  var refId = normalizeDocId((base && base.docId) || S.state.docId);
  if (parsed.docIdEmbedded && refId && normalizeDocId(theirs.docId) !== refId) return;
  if (refId) theirs.docId = refId;

  mergeCandidate = {
    theirs: theirs,
    base: base,
    home: home || null,
    fileName: currentFile.name || "",
    lastModified: currentFile.lastModified || null
  };
  var btn = document.getElementById("file-conflict-merge");
  if (btn) btn.hidden = false;
}

/* ---- what differs, field by field ---- */

var MERGE_OUTCOME_TEXT = {
  theirs: "The file's version is taken",
  mine: "Your version is kept",
  conflict: "Changed on both sides — the file's version goes live, yours is kept as a comment",
  merged: "Changed on both sides — both sets of changes are combined",
  status: "Whichever got further wins",
  both: "Both sides are kept"
};

/* Mirrors mergeRow()'s ladder in 03-sync.js exactly for the fields it
   still compares whole — the title and the picture: the pane has to say
   what the merge is actually going to do, not something close to it. `b`
   is null when there is no ancestor, which is what makes every difference
   a conflict in a two-way merge. A script cell is decided by the merge's
   own mergeTextField() instead (#85). */
function mergeFieldOutcome(b, m, t) {
  if (m === t) return null;
  if (b !== null && m === b) return "theirs";
  if (b !== null && t === b) return "mine";
  return "conflict";
}

/* Which way a row present on only one side goes — the same three rules
   mergeStates applies when it walks each side's rows. */
function mergeRowFate(b, m, t) {
  if (m && t) return null;
  if (m && !t) {
    if (b && rowContentEqual(b, m)) return "Deleted in the file on disk — it goes.";
    return b ? "Deleted in the file on disk, but you changed it — your version stays."
             : "A scene you added — it stays.";
  }
  if (b && rowContentEqual(b, t)) return "You deleted this scene — it stays deleted.";
  return b ? "You deleted this scene, but it changed on disk — it comes back."
           : "A new scene from the file on disk.";
}

function mergeFieldText(row, field) {
  if (!row) return "";
  return htmlToPlainText(row[field] || "");
}

function mergeStatusLabel(id) {
  var s = rowStatus(id);
  return s ? s.label : "To do";
}

/* One item of the breakdown registry / crew / b-roll list as a single line
   of text, so the three of them can be diffed the same way a field is.
   All three merge by union (mergePeople, mergeProductionTags,
   mergeBrollShots), so the outcome is always "both". */
function mergeItemSummary(bits) {
  return bits.filter(function (b) { return b; }).join(" · ");
}

function mergeListEntries(label, mineList, theirList, keyOf, nameOf, summaryOf) {
  var mineMap = {}, theirMap = {}, order = [], seen = {};
  (mineList || []).forEach(function (it) { if (it) mineMap[keyOf(it)] = it; });
  (theirList || []).forEach(function (it) { if (it) theirMap[keyOf(it)] = it; });
  (theirList || []).concat(mineList || []).forEach(function (it) {
    if (!it) return;
    var k = keyOf(it);
    if (seen[k]) return;
    seen[k] = true;
    order.push(k);
  });
  var entries = [];
  order.forEach(function (k) {
    var m = mineMap[k], t = theirMap[k];
    var ms = m ? summaryOf(m) : "", ts = t ? summaryOf(t) : "";
    if (ms === ts) return;
    var pair = mergeDiffPairHtml(ms, ts);
    entries.push({
      label: label + ": " + nameOf(m || t),
      outcome: "both",
      mineHtml: pair.mine,
      theirsHtml: pair.theirs
    });
  });
  return entries;
}

/* The whole pane's content: groups of entries, in the order the merged
   document will be in (theirs first, then anything only this side has). */
function mergeDiffModel(base, mine, theirs) {
  var groups = [];
  var b = base || null;

  var mineTitle = mine.title || "", theirTitle = theirs.title || "";
  if (mineTitle !== theirTitle) {
    var titlePair = mergeDiffPairHtml(mineTitle, theirTitle);
    groups.push({ label: "Title", entries: [{
      label: "Script title",
      outcome: mergeFieldOutcome(b ? (b.title || "") : null, mineTitle, theirTitle),
      mineHtml: titlePair.mine,
      theirsHtml: titlePair.theirs
    }] });
  }

  var baseRows = byId(b && b.rows), mineRows = byId(mine.rows), theirRows = byId(theirs.rows);
  var textCtx = textMergeContext(b, mine, theirs);
  var order = [], seen = {}, sceneNo = {};
  theirs.rows.forEach(function (r) { order.push(r.id); seen[r.id] = true; sceneNo[r.id] = order.length; });
  mine.rows.forEach(function (r) { if (!seen[r.id]) { order.push(r.id); seen[r.id] = true; sceneNo[r.id] = order.length; } });

  order.forEach(function (id) {
    var m = mineRows[id] || null, t = theirRows[id] || null, bb = baseRows[id] || null;
    var entries = [];
    ROW_FIELDS.forEach(function (f) {
      if (f === "imageRef") {
        /* Compared as rowImageKey says: the sha the ref names. */
        var mi = rowImageKey(m), ti = rowImageKey(t);
        if (mi === ti) return;
        entries.push({
          label: "Visual image",
          outcome: mergeFieldOutcome(bb ? rowImageKey(bb) : null, mi, ti),
          mineHtml: mergeDiffImageHtml(m),
          theirsHtml: mergeDiffImageHtml(t)
        });
        return;
      }
      /* Decided the way mergeStates decides it, by mergeTextField() on the
         cells themselves rather than the plain text diffed below: two
         cells can read identically while differing in a tag or a comment
         anchor, and two different strings can be the same cell. A scene
         only one side has is decided by mergeRowFate() and shown whole. */
      var outcome = m && t
        ? mergeTextField(bb ? (bb[f] || "") : undefined, m[f], t[f], textCtx).outcome
        : mergeFieldOutcome(bb ? (bb[f] || null) : null, (m && m[f]) || null, (t && t[f]) || null);
      if (outcome === "same" || outcome === null) return;
      var mv = mergeFieldText(m, f), tv = mergeFieldText(t, f);
      /* A difference in formatting, a tag or a comment anchor alone has
         nothing to show side by side as text — unless it is a conflict,
         which leaves a card behind and so is always listed. */
      if (mv === tv && outcome !== "conflict") return;
      var pair = mergeDiffPairHtml(mv, tv);
      entries.push({
        label: f === "audioText" ? "Audio" : "Visual",
        outcome: outcome,
        mineHtml: pair.mine,
        theirsHtml: pair.theirs
      });
    });
    if (m && t && m.status !== t.status) {
      var statusPair = mergeDiffPairHtml(mergeStatusLabel(m.status), mergeStatusLabel(t.status));
      entries.push({ label: "Status", outcome: "status", mineHtml: statusPair.mine, theirsHtml: statusPair.theirs });
    }
    if (!entries.length) return;
    groups.push({ label: "Scene " + pad2(sceneNo[id]), note: mergeRowFate(bb, m, t), entries: entries });
  });

  /* by id, the way mergeProductionTags() merges them (#85): a rename shows
     as one item whose name differs, not as one deleted and one added */
  var tagEntries = mergeListEntries("Breakdown", mine.productionTags, theirs.productionTags,
    function (t) { return t.id || registryKey(t.cat, t.name); },
    function (t) { var c = tagCategory(t.cat); return (c ? c.label + " " : "") + t.name; },
    function (t) {
      var st = tagStatus(t.status);
      return mergeItemSummary([t.name, st ? st.label : "Needed", t.owner, t.notes]);
    });
  if (tagEntries.length) groups.push({ label: "Production breakdown", entries: tagEntries });

  var peopleEntries = mergeListEntries("Crew", mine.people, theirs.people,
    function (p) { return normalizeTagName(p.name); },
    function (p) { return p.name; },
    function (p) { return p.name; });
  if (peopleEntries.length) groups.push({ label: "Crew", entries: peopleEntries });

  var brollEntries = mergeListEntries("B-roll", mine.brollShots, theirs.brollShots,
    function (s) { return s.id; },
    function (s) { return s.name || "Shot"; },
    function (s) {
      return mergeItemSummary([s.name, s.desc, s.location, s.owner, s.audioRef, s.notes,
        s.status === "shot" ? "Shot" : "Not shot", s.reshoot ? "Needs attention" : ""]);
    });
  if (brollEntries.length) groups.push({ label: "B-roll", entries: brollEntries });

  return groups;
}

/* ---- a word-level diff, dependency-free ----

   Tokenise both sides into words and the whitespace between them, find the
   longest common subsequence, mark whatever is not in it. Quadratic, so a
   pair of very long fields falls back to marking each side whole rather
   than making the modal wait on a table of millions of cells — the pane is
   still correct there, just less precise. Every token is escaped on the
   way out; nothing reaches innerHTML unescaped. */

var MERGE_DIFF_TOKEN_CAP = 600;

function mergeDiffTokenize(s) {
  return String(s == null ? "" : s).split(/(\s+)/).filter(function (t) { return t !== ""; });
}

function mergeDiffOps(a, b) {
  var n = a.length, m = b.length;
  if (n > MERGE_DIFF_TOKEN_CAP || m > MERGE_DIFF_TOKEN_CAP) return null;
  var w = m + 1;
  var lcs = new Int32Array((n + 1) * w);
  for (var i = n - 1; i >= 0; i--) {
    for (var j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  var out = [], x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) { out.push({ op: "same", text: a[x] }); x++; y++; }
    else if (lcs[(x + 1) * w + y] >= lcs[x * w + y + 1]) { out.push({ op: "del", text: a[x] }); x++; }
    else { out.push({ op: "add", text: b[y] }); y++; }
  }
  while (x < n) out.push({ op: "del", text: a[x++] });
  while (y < m) out.push({ op: "add", text: b[y++] });
  return out;
}

function mergeDiffSideHtml(ops, want) {
  var html = "", any = false;
  ops.forEach(function (o) {
    if (o.op !== "same" && o.op !== want) return;
    if (o.text.trim()) any = true;
    html += o.op === "same"
      ? escapeHtml(o.text)
      : '<span class="diff-' + want + '">' + escapeHtml(o.text) + "</span>";
  });
  return any ? html : '<em class="diff-empty">(empty)</em>';
}

function mergeDiffWholeHtml(text, cls) {
  return text ? '<span class="diff-' + cls + '">' + escapeHtml(text) + "</span>"
              : '<em class="diff-empty">(empty)</em>';
}

function mergeDiffPairHtml(mineText, theirText) {
  var ops = mergeDiffOps(mergeDiffTokenize(mineText), mergeDiffTokenize(theirText));
  if (!ops) return { mine: mergeDiffWholeHtml(mineText, "del"), theirs: mergeDiffWholeHtml(theirText, "add") };
  return { mine: mergeDiffSideHtml(ops, "del"), theirs: mergeDiffSideHtml(ops, "add") };
}

/* A ref'd picture goes out as <img data-blob>, filled in by the hydrator
   (02c-blobs.js) once its bytes are here. */
function mergeDiffImageHtml(row) {
  var img = rowImage(row);
  if (img && img.ref) return blobImgHtml(img.ref, "diff-img");
  var ok = img ? safeImageSrc(img.dataUrl) : null;
  return ok ? '<img class="diff-img" src="' + escapeHtml(ok) + '" alt="">'
            : '<em class="diff-empty">(no image)</em>';
}

/* ---- the review pane ---- */

function mergeEntryHtml(e) {
  return '<div class="merge-entry" data-outcome="' + escapeHtml(e.outcome || "both") + '">' +
    '<div class="merge-entry-head">' + escapeHtml(e.label) +
      '<span class="merge-entry-outcome">' + escapeHtml(MERGE_OUTCOME_TEXT[e.outcome] || "") + "</span></div>" +
    '<div class="merge-sides">' +
      '<div class="merge-side"><div class="merge-side-head">Open here</div>' +
        '<div class="merge-side-body">' + e.mineHtml + "</div></div>" +
      '<div class="merge-side"><div class="merge-side-head">On disk</div>' +
        '<div class="merge-side-body">' + e.theirsHtml + "</div></div>" +
    "</div></div>";
}

function mergeGroupHtml(g) {
  return '<div class="merge-group">' +
    '<div class="merge-group-head">' + escapeHtml(g.label) +
      (g.note ? '<span class="merge-group-note">' + escapeHtml(g.note) + "</span>" : "") + "</div>" +
    g.entries.map(mergeEntryHtml).join("") +
  "</div>";
}

/* Opens over the conflict modal rather than replacing it: Cancel here puts
   the four original choices straight back, having changed nothing. */
export function openMergeReview() {
  if (!mergeCandidate || !S.state) return;
  var groups = mergeDiffModel(mergeCandidate.base, S.state, mergeCandidate.theirs);
  var count = groups.reduce(function (n, g) { return n + g.entries.length; }, 0);
  document.getElementById("merge-review-detail").textContent = count
    ? (count === 1 ? "One field differs" : count + " fields differ") +
      " between " + (mergeCandidate.fileName || "the file on disk") + " and what you have open" +
      (mergeCandidate.base ? "" : ", and there is no earlier version of this file to compare both against, " +
        "so every one of them is treated as changed on both sides") +
      ". Nothing is written until you merge."
    : "Nothing differs between " + (mergeCandidate.fileName || "the file on disk") +
      " and what you have open.";
  document.getElementById("merge-review-list").innerHTML = count
    ? groups.map(mergeGroupHtml).join("")
    : '<div class="comments-empty">The two versions say the same thing.</div>';
  document.getElementById("file-conflict-modal").hidden = true;
  document.getElementById("merge-review-modal").hidden = false;
  document.getElementById("merge-review-confirm").focus();
}

/* Back to the conflict modal with the candidate intact — nothing on disk
   and nothing on screen has been touched. */
export function cancelMergeReview() {
  document.getElementById("merge-review-modal").hidden = true;
  document.getElementById("merge-review-list").innerHTML = "";
  if (mergeCandidate) document.getElementById("file-conflict-modal").hidden = false;
}

/* The one place the merge actually happens, and the first moment anything
   changes. Still nothing is written: the merged document is on screen and
   dirty, autosave is halted (reportMerge's noAutoSave, invariant #51), and
   the Save the user presses when they have looked it over is what puts it
   on disk. */
export function confirmFileMerge() {
  var cand = mergeCandidate;
  if (!cand || !S.state) { cancelMergeReview(); return; }
  document.getElementById("merge-review-modal").hidden = true;
  document.getElementById("merge-review-list").innerHTML = "";
  closeFileConflict();

  var diskCopy = cloneState(cand.theirs);
  var prevDocId = S.state.docId;
  /* What is on disk is this document's ancestor from here on, and the next
     Save has to write the merged version over exactly the bytes we just
     read — so the conflict guard's baseline moves with it, or the very
     next Save would raise this same modal again. Set before the merge and
     not after it: the two fields are one fact about the bytes that were
     read, and the merge below is what puts the merged version on screen. */
  if (cand.home) {
    cand.home.diskBase = diskCopy;
    if (cand.lastModified) cand.home.lastModified = cand.lastModified;
  }
  /* applyStashedWork (14-export.js) is the shared merge entry point: it
     files the "Before merging your unsaved changes" snapshot, arms Undo
     merge and runs mergeStates — the same steps the boot-stash and
     crash-draft paths take. The third argument is what applyMerge
     (03-sync.js) does with the result: adopt it, move the history if the
     disk copy's id won the merge, make what is on disk the new base,
     redraw and say so. One call, no second copy of the sequence (#72). */
  applyStashedWork(migrateRows(cloneState(cand.theirs)), {
    base: cand.base, mine: cloneState(S.state)
  }, {
    newBase: cloneState(diskCopy),
    historyFrom: prevDocId,
    chips: true,
    noAutoSave: true,
    toast: {
      text: "Merged " + (cand.fileName || "the file on disk") + " into what you have open. " +
        "Nothing has been saved yet — press Save when you have looked it over.",
      tone: "warn",
      sticky: true
    }
  });
  mergeCandidate = null;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
