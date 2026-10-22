import { normalizeTagName, registryKey } from "../core/document/tags.ts";
import { mergeTextField } from "../core/merge/text-field.ts";
import { byId, rowContentEqual, rowFieldKey } from "../core/merge/rows.ts";
import { GALLERY_FIELDS, ROW_FIELDS } from "../core/document/fields.ts";
import { normalizeDocId } from "../../shared/doc-id-policy.js";
import { rowStatus, tagCategory, tagStatus } from "../core/production/looks.ts";
import { S } from "./_state.js";
import { amendHome, fileHome } from "../legacy/location-bridge.ts";
import { escapeHtml, migrateRows } from "./02-state.js";
import { blobImgHtml, rowImage, rowImageKey } from "../adapters/storage/02c-blobs.js";
import { videoLinkLabel } from "../adapters/storage/02d-gallery.js";
import { textMergeContext } from "./03-sync.js";
import { applyStashedWork } from "./14-export.js";
import { closeFileConflict, parseProjectFileState } from "./18-local-files.js";
import { idMap } from "../core/document/id-map.ts";
import { safeImageSrc } from "../core/document/text-policy.ts";
import { pad2 } from "../core/production/timing.ts";
import { htmlToPlainText } from "../legacy/plain-text.ts";
import { cloneState } from "../core/document/clone.ts";

var mergeCandidate = null;
var mergeProbeToken = 0;

function fileMergeBase(home) {
  if (home && home.diskBase) return home.diskBase;
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
  if (token !== mergeProbeToken) return;
  if (!parsed || parsed.error || !parsed.state) return;

  var theirs = parsed.state;
  var base = fileMergeBase(home);
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

var MERGE_OUTCOME_TEXT = {
  theirs: "The file's version is taken",
  mine: "Your version is kept",
  conflict: "Changed on both sides — the file's version goes live, yours is kept as a comment",
  conflictMarks: "Linked or tagged differently on both sides — the file's link or tag goes live with the rest combined, yours is kept as a comment",
  merged: "Changed on both sides — both sets of changes are combined",
  status: "Whichever got further wins",
  both: "Both sides are kept"
};

function mergeFieldOutcome(b, m, t) {
  if (m === t) return null;
  if (b !== null && m === b) return "theirs";
  if (b !== null && t === b) return "mine";
  return "conflict";
}

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

function mergeItemSummary(bits) {
  return bits.filter(function (b) { return b; }).join(" · ");
}

function mergeListEntries(label, mineList, theirList, keyOf, nameOf, summaryOf) {
  var mineMap = idMap(), theirMap = idMap(), order = [], seen = idMap();
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

function mergeGallerySummary(row, f) {
  var v = row && Array.isArray(row[f]) ? row[f] : [];
  if (f === "imageLinks") return v.map(videoLinkLabel).join(", ");
  if (!v.length) return "";
  var links = [];
  v.forEach(function (it) { (it.links || []).forEach(function (l) { links.push(videoLinkLabel(l)); }); });
  return v.length + (v.length === 1 ? " picture" : " pictures") + (links.length ? " · " + links.join(", ") : "");
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

export function cancelMergeReview() {
  document.getElementById("merge-review-modal").hidden = true;
  document.getElementById("merge-review-list").innerHTML = "";
  if (mergeCandidate) document.getElementById("file-conflict-modal").hidden = false;
}

export function confirmFileMerge() {
  var cand = mergeCandidate;
  if (!cand || !S.state) { cancelMergeReview(); return; }
  document.getElementById("merge-review-modal").hidden = true;
  document.getElementById("merge-review-list").innerHTML = "";
  closeFileConflict();

  var diskCopy = cloneState(cand.theirs);
  var prevDocId = S.state.docId;
  if (cand.home) {
    amendHome(cand.home, cand.lastModified
      ? { diskBase: diskCopy, lastModified: cand.lastModified }
      : { diskBase: diskCopy });
  }
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

export function __init() {}
