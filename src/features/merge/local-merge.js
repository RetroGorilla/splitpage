import { normalizeTagName, registryKey } from "../../core/document/tags.ts";
import { mergeTextField } from "../../core/merge/text-field.ts";
import { byId, rowFieldKey } from "../../core/merge/rows.ts";
import { GALLERY_FIELDS, ROW_FIELDS } from "../../core/document/fields.ts";
import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { rowStatus, tagCategory, tagStatus } from "../../core/production/looks.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { rowImage, rowImageKey } from "../../core/document/media.ts";
import { idMap } from "../../core/document/id-map.ts";
import { safeImageSrc } from "../../core/document/text-policy.ts";
import { pad2 } from "../../core/production/timing.ts";
import { cloneState } from "../../core/document/clone.ts";
import {
  mergeDiffPairHtml,
  mergeFieldOutcome,
  mergeGallerySummary,
  mergeItemSummary,
  mergeListEntries,
  mergeRowFate
} from "../../core/merge/review.ts";

var ports = null;
var mergeCandidate = null;
var mergeProbeToken = 0;

function currentDocument() { return ports.document.current(); }
function mergeBase() { return ports.session.mergeBase(); }
function fileHome() { return ports.place.fileHome(); }
function amendHome(record, fields) { return ports.homes.amendHome(record, fields); }
function migrateRows(raw) { return ports.entry.migrate(raw); }
function blobImgHtml(ref, cls) { return ports.pictures.imgHtml(ref, cls); }
function textMergeContext(base, mine, theirs) { return ports.textMergeContext(base, mine, theirs); }
function parseProjectFileState(file, opts) { return ports.files.parse(file, opts); }
function fileConflicts() { return ports.conflicts; }
function applyStashedWork(disk, work, options) { return ports.recovery.applyStashedWork(disk, work, options); }
function htmlToPlainText(html) { return ports.text.htmlToPlainText(html); }

function fileMergeBase(home) {
  if (home && home.diskBase) return home.diskBase;
  if (home && home === fileHome() && mergeBase() && currentDocument() &&
      normalizeDocId(mergeBase().docId) === normalizeDocId(currentDocument().docId)) return mergeBase();
  return null;
}

function resetMergeOffer() {
  mergeCandidate = null;
  mergeProbeToken++;
  var btn = document.getElementById("file-conflict-merge");
  if (btn) btn.hidden = true;
}

async function offerFileMerge(currentFile, home) {
  resetMergeOffer();
  var token = mergeProbeToken;
  if (!currentFile || !currentDocument()) return;
  var parsed;
  try {
    parsed = await parseProjectFileState(currentFile, { noAsk: true });
  } catch (e) {
    parsed = null;
  }
  if (token !== mergeProbeToken) return;
  if (!parsed || parsed.error || !parsed.state) return;

  var theirs = parsed.state;
  var base = fileMergeBase(home);
  var refId = normalizeDocId((base && base.docId) || currentDocument().docId);
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

var MERGE_OUTCOME_TEXT = {
  theirs: "The file's version is taken",
  mine: "Your version is kept",
  conflict: "Changed on both sides — the file's version goes live, yours is kept as a comment",
  conflictMarks: "Linked or tagged differently on both sides — the file's link or tag goes live with the rest combined, yours is kept as a comment",
  merged: "Changed on both sides — both sets of changes are combined",
  status: "Whichever got further wins",
  both: "Both sides are kept"
};

function mergeFieldText(row, field) {
  if (!row) return "";
  return htmlToPlainText(row[field] || "");
}

function mergeStatusLabel(id) {
  var s = rowStatus(id);
  return s ? s.label : "To do";
}

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
  var order = [], seen = idMap(), sceneNo = idMap();
  theirs.rows.forEach(function (r) { order.push(r.id); seen[r.id] = true; sceneNo[r.id] = order.length; });
  mine.rows.forEach(function (r) { if (!seen[r.id]) { order.push(r.id); seen[r.id] = true; sceneNo[r.id] = order.length; } });

  order.forEach(function (id) {
    var m = mineRows[id] || null, t = theirRows[id] || null, bb = baseRows[id] || null;
    var entries = [];
    ROW_FIELDS.forEach(function (f) {
      if (GALLERY_FIELDS[f]) {
        if (rowFieldKey(m, f) === rowFieldKey(t, f)) return;
        var gm = mergeGallerySummary(m, f), gt = mergeGallerySummary(t, f);
        var gPair = mergeDiffPairHtml(gm, gt);
        entries.push({
          label: f === "imageLinks" ? "Video links" : "More pictures",
          outcome: "both",
          mineHtml: gPair.mine,
          theirsHtml: gPair.theirs
        });
        return;
      }
      if (f === "imageRef") {
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
      var decided = m && t
        ? mergeTextField(bb ? (bb[f] || "") : undefined, m[f], t[f], textCtx)
        : { outcome: mergeFieldOutcome(bb ? (bb[f] || null) : null, (m && m[f]) || null, (t && t[f]) || null) };
      var outcome = decided.outcome;
      if (outcome === "same" || outcome === null) return;
      var mv = mergeFieldText(m, f), tv = mergeFieldText(t, f);
      if (mv === tv && outcome !== "conflict") return;
      var pair = mergeDiffPairHtml(mv, tv);
      entries.push({
        label: f === "audioText" ? "Audio" : "Visual",
        outcome: outcome,
        text: decided.marks ? MERGE_OUTCOME_TEXT.conflictMarks : undefined,
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
        s.status === "shot" ? "Shot" : "To shoot", s.reshoot ? "Flagged" : "",
        (Array.isArray(s.props) ? s.props : []).map(function (p) { return p && p.name; }).filter(Boolean).join(", ")]);
    });
  if (brollEntries.length) groups.push({ label: "B-roll", entries: brollEntries });

  return groups;
}

function mergeDiffImageHtml(row) {
  var img = rowImage(row);
  if (img && img.ref) return blobImgHtml(img.ref, "diff-img");
  var ok = img ? safeImageSrc(img.dataUrl) : null;
  return ok ? '<img class="diff-img" src="' + escapeHtml(ok) + '" alt="">'
            : '<em class="diff-empty">(no image)</em>';
}

function mergeEntryHtml(e) {
  return '<div class="merge-entry" data-outcome="' + escapeHtml(e.outcome || "both") + '">' +
    '<div class="merge-entry-head">' + escapeHtml(e.label) +
      '<span class="merge-entry-outcome">' + escapeHtml(e.text || MERGE_OUTCOME_TEXT[e.outcome] || "") + "</span></div>" +
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

function openMergeReview() {
  if (!mergeCandidate || !currentDocument()) return;
  var groups = mergeDiffModel(mergeCandidate.base, currentDocument(), mergeCandidate.theirs);
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

function cancelMergeReview() {
  document.getElementById("merge-review-modal").hidden = true;
  document.getElementById("merge-review-list").innerHTML = "";
  if (mergeCandidate) document.getElementById("file-conflict-modal").hidden = false;
}

function confirmFileMerge() {
  var cand = mergeCandidate;
  if (!cand || !currentDocument()) { cancelMergeReview(); return; }
  document.getElementById("merge-review-modal").hidden = true;
  document.getElementById("merge-review-list").innerHTML = "";
  fileConflicts().close();

  var diskCopy = cloneState(cand.theirs);
  var prevDocId = currentDocument().docId;
  if (cand.home) {
    amendHome(cand.home, cand.lastModified
      ? { diskBase: diskCopy, lastModified: cand.lastModified }
      : { diskBase: diskCopy });
  }
  applyStashedWork(migrateRows(cloneState(cand.theirs)), {
    base: cand.base, mine: cloneState(currentDocument())
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

export function __init(given) {
  ports = given;
  var disposed = false;
  return {
    offer: offerFileMerge,
    reset: resetMergeOffer,
    open: openMergeReview,
    cancel: cancelMergeReview,
    confirm: confirmFileMerge,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      resetMergeOffer();
      ports = null;
    }
  };
}
