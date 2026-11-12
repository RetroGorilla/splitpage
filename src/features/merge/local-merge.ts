import { normalizeTagName, registryKey } from "../../core/document/tags.ts";
import { mergeTextField } from "../../core/merge/text-field.ts";
import { byId, rowContentEqual, rowFieldKey } from "../../core/merge/rows.ts";
import { GALLERY_FIELDS, ROW_FIELDS } from "../../core/document/fields.ts";
import { normalizeDocId } from "../../../shared/doc-id-policy.ts";
import { rowStatus, tagCategory, tagStatus } from "../../core/production/looks.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { rowImage, rowImageKey } from "../../core/document/media.ts";
import { idMap } from "../../core/document/id-map.ts";
import { safeImageSrc } from "../../core/document/text-policy.ts";
import { deriveDocumentNumbering } from "../../core/document/numbering.ts";
import { cloneState } from "../../core/document/clone.ts";
import { mergeGalleryThumbnailRemovals } from "../../core/document/gallery.ts";
import type { GallerySide } from "../../core/document/gallery.ts";
import type { MergeReviewControl, MergeReviewPorts } from "./ports.ts";
import type { Home } from "../../application/location/document-location.ts";
import type { DocumentShape, DocumentRow, DocumentShot, ValidatedDocument } from "../../core/document/validated.ts";
import type { Frozen } from "../../core/document/freeze.ts";

type MergeReviewDocument = Frozen<Pick<DocumentShape, "docId" | "title" | "rows" | "productionTags" | "brollShots" | "people">> & { readonly sections?: unknown };
type MergeCandidate = { theirs: ValidatedDocument; base: ReturnType<typeof fileMergeBase>; home: Home | null; fileName: string; lastModified: number | null };
import {
  mergeDiffPairHtml,
  mergeFieldOutcome,
  mergeGalleryMoves,
  mergeGallerySummary,
  mergeItemSummary,
  mergeListEntries,
  mergeRowFate
} from "../../core/merge/review.ts";

type MergeReviewDecision = { outcome: ReturnType<typeof mergeTextField>["outcome"] | ReturnType<typeof mergeFieldOutcome>; marks?: ReturnType<typeof mergeTextField>["marks"] };
type MergeReviewEntry = Omit<ReturnType<typeof mergeListEntries>[number], "outcome"> & { outcome: ReturnType<typeof mergeListEntries>[number]["outcome"] | ReturnType<typeof mergeFieldOutcome>; text?: ReturnType<typeof mergeDiffPairHtml>["mine"] | undefined };
type MergeReviewGroup = Pick<MergeReviewEntry, "label"> & { entries: MergeReviewEntry[]; note?: ReturnType<typeof mergeRowFate> };

let ports: MergeReviewPorts | null = null;
let mergeCandidate: MergeCandidate | null = null;
let mergeProbeToken = 0;

function mergeAllowed() { return (ports as MergeReviewPorts).capability.merge().allowed; }

function mergePermitted(): boolean {
  const current = ports as MergeReviewPorts;
  const can = current.capability.merge();
  if (can.allowed) return true;
  current.notices.show(can.reason, "warn");
  return false;
}

function currentDocument() { return (ports as MergeReviewPorts).document.current(); }
function mergeBase() { return (ports as MergeReviewPorts).session.mergeBase(); }
function fileHome() { return (ports as MergeReviewPorts).place.fileHome(); }
function amendHome(record: Parameters<MergeReviewPorts["homes"]["amendHome"]>[0], fields: Parameters<MergeReviewPorts["homes"]["amendHome"]>[1]) { return (ports as MergeReviewPorts).homes.amendHome(record, fields); }
function migrateRows(raw: Parameters<MergeReviewPorts["entry"]["migrate"]>[0]) { return (ports as MergeReviewPorts).entry.migrate(raw); }
function blobImgHtml(ref: Parameters<MergeReviewPorts["pictures"]["imgHtml"]>[0], cls: Parameters<MergeReviewPorts["pictures"]["imgHtml"]>[1]) { return (ports as MergeReviewPorts).pictures.imgHtml(ref, cls); }
function textMergeContext(base: Parameters<MergeReviewPorts["textMergeContext"]>[0], mine: Parameters<MergeReviewPorts["textMergeContext"]>[1], theirs: Parameters<MergeReviewPorts["textMergeContext"]>[2]) { return (ports as MergeReviewPorts).textMergeContext(base, mine, theirs); }
function parseProjectFileState(file: unknown, opts: Parameters<MergeReviewPorts["files"]["parse"]>[1]) { return (ports as MergeReviewPorts).files.parse(file, opts); }
function fileConflicts() { return (ports as MergeReviewPorts).conflicts; }
function applyStashedWork(disk: Parameters<MergeReviewPorts["recovery"]["applyStashedWork"]>[0], work: Parameters<MergeReviewPorts["recovery"]["applyStashedWork"]>[1], options: Parameters<MergeReviewPorts["recovery"]["applyStashedWork"]>[2]) { return (ports as MergeReviewPorts).recovery.applyStashedWork(disk, work, options); }
function htmlToPlainText(html: Parameters<MergeReviewPorts["text"]["htmlToPlainText"]>[0]) { return (ports as MergeReviewPorts).text.htmlToPlainText(html); }

function fileMergeBase(home: Home | null | undefined) {
  if (home && home.diskBase) return home.diskBase;
  if (home && home === fileHome() && mergeBase() && currentDocument() &&
      normalizeDocId((mergeBase() as MergeReviewDocument).docId) === normalizeDocId((currentDocument() as Pick<MergeReviewDocument, "docId">).docId)) return mergeBase();
  return null;
}

function resetMergeOffer() {
  mergeCandidate = null;
  mergeProbeToken++;
  const btn = document.getElementById("file-conflict-merge");
  if (btn) btn.hidden = true;
}

async function offerFileMerge(currentFile: Parameters<MergeReviewControl["offer"]>[0], home: Parameters<MergeReviewControl["offer"]>[1]) {
  resetMergeOffer();
  const token = mergeProbeToken;
  if (!currentFile || !mergeAllowed() || !currentDocument()) return;
  let parsed;
  try {
    parsed = await parseProjectFileState(currentFile, { noAsk: true });
  } catch (e) {
    parsed = null;
  }
  if (token !== mergeProbeToken) return;
  if (!mergeAllowed()) return;
  if (!parsed || parsed.error || !parsed.state) return;

  const theirs = parsed.state;
  const base = fileMergeBase(home);
  const refId = normalizeDocId((base && (base as Pick<MergeReviewDocument, "docId">).docId) || (currentDocument() as Pick<MergeReviewDocument, "docId">).docId);
  if (parsed.docIdEmbedded && refId && normalizeDocId(theirs.docId) !== refId) return;
  if (refId) theirs.docId = refId;

  mergeCandidate = {
    theirs: theirs,
    base: base,
    home: home || null,
    fileName: currentFile.name || "",
    lastModified: currentFile.lastModified || null
  };
  const btn = document.getElementById("file-conflict-merge");
  if (btn) btn.hidden = false;
}

const MERGE_OUTCOME_TEXT = {
  theirs: "The file's version is taken",
  mine: "Your version is kept",
  conflict: "Changed on both sides — the file's version goes live, yours is kept as a comment",
  conflictMarks: "Linked or tagged differently on both sides — the file's link or tag goes live with the rest combined, yours is kept as a comment",
  merged: "Changed on both sides — both sets of changes are combined",
  status: "Whichever got further wins",
  both: "Both sides are kept"
};

const MERGE_MOVE_TEXT = {
  theirs: "Same video in a different folder — the file's location is kept",
  mine: "Same video in a different folder — your location is kept",
  bundled: "Same video in a different folder — the copy beside the script is kept",
  mixed: "Same videos in different folders — the file's location is kept for some, yours for others"
};

function mergeFieldText(row: DocumentRow | null, field: string) {
  if (!row) return "";
  return htmlToPlainText(row[field] || "");
}

function mergeStatusLabel(id: unknown) {
  const s = rowStatus(id);
  return s ? s.label : "To do";
}

function mergeDiffModel(base: MergeReviewDocument | null | undefined, mine: MergeReviewDocument | null, theirs: MergeReviewDocument) {
  const groups: MergeReviewGroup[] = [];
  const b = base || null;

  const mineTitle = (mine as MergeReviewDocument).title || "", theirTitle = theirs.title || "";
  if (mineTitle !== theirTitle) {
    const titlePair = mergeDiffPairHtml(mineTitle, theirTitle);
    groups.push({ label: "Title", entries: [{
      label: "Script title",
      outcome: mergeFieldOutcome(b ? ((b as MergeReviewDocument).title || "") : null, mineTitle, theirTitle),
      mineHtml: titlePair.mine,
      theirsHtml: titlePair.theirs
    }] });
  }

  const baseRows = byId(b && (b as MergeReviewDocument).rows), mineRows = byId((mine as MergeReviewDocument).rows), theirRows = byId(theirs.rows);
  const textCtx = textMergeContext(b, mine, theirs);
  const order: string[] = [], seen = idMap<boolean>();
  theirs.rows.forEach(function (r) { order.push(r.id); seen[r.id] = true; });
  (mine as MergeReviewDocument).rows.forEach(function (r) { if (!seen[r.id]) { order.push(r.id); seen[r.id] = true; } });

  const mineNumbers = deriveDocumentNumbering(mine ?? { rows: [] });
  const theirNumbers = deriveDocumentNumbering(theirs);
  order.forEach(function (id) {
    const m = mineRows[id] || null, t = theirRows[id] || null, bb = baseRows[id] || null;
    const rowOutcome = m && t ? null : bb && rowContentEqual(bb, m || t)
      ? (m ? "theirs" : "mine") : (m ? "mine" : "theirs");
    const entries: MergeReviewEntry[] = [];
    ROW_FIELDS.forEach(function (f) {
      if (GALLERY_FIELDS[f]) {
        if (rowFieldKey(m, f) === rowFieldKey(t, f)) return;
        const moves = m && t ? mergeGalleryMoves(f, bb, m, t) : null;
        const gm = mergeGallerySummary(m, f, moves?.keys), gt = mergeGallerySummary(t, f, moves?.keys);
        const gPair = mergeDiffPairHtml(gm, gt);
        const moved = moves && moves.only && moves.kept ? moves : null;
        const combined = f === "moreImages" && m && t && mergeGalleryThumbnailRemovals(bb as GallerySide | null, m as GallerySide, t as GallerySide);
        entries.push({
          label: f === "imageLinks" ? "Video links" : "More pictures",
          outcome: rowOutcome ?? (combined ? "merged" : moved && moved.kept !== "mixed" ? moved.kept : "both"),
          text: moved ? MERGE_MOVE_TEXT[moved.bundled ? "bundled" : moved.kept as keyof typeof MERGE_MOVE_TEXT] : undefined,
          mineHtml: gPair.mine,
          theirsHtml: gPair.theirs
        });
        return;
      }
      if (f === "imageRef") {
        const mi = rowImageKey(m), ti = rowImageKey(t);
        if (mi === ti) return;
        entries.push({
          label: "Visual image",
          outcome: rowOutcome ?? mergeFieldOutcome(bb ? rowImageKey(bb) : null, mi, ti),
          mineHtml: mergeDiffImageHtml(m),
          theirsHtml: mergeDiffImageHtml(t)
        });
        return;
      }
      const decided: MergeReviewDecision = m && t
        ? mergeTextField(bb ? (bb[f] || "") : undefined, m[f], t[f], textCtx)
        : { outcome: rowOutcome };
      const outcome = decided.outcome;
      if (outcome === "same" || outcome === null) return;
      const mv = mergeFieldText(m, f), tv = mergeFieldText(t, f);
      if (mv === tv && outcome !== "conflict" && !(rowOutcome && f === "audioText")) return;
      const pair = mergeDiffPairHtml(mv, tv);
      entries.push({
        label: f === "audioText" ? "Audio" : "Visual",
        outcome: outcome,
        text: decided.marks ? MERGE_OUTCOME_TEXT.conflictMarks : undefined,
        mineHtml: pair.mine,
        theirsHtml: pair.theirs
      });
    });
    if (m && t && m.status !== t.status) {
      const statusPair = mergeDiffPairHtml(mergeStatusLabel(m.status), mergeStatusLabel(t.status));
      entries.push({ label: "Status", outcome: "status", mineHtml: statusPair.mine, theirsHtml: statusPair.theirs });
    }
    if (!entries.length) return;
    const here = mineNumbers.beats[id]?.full, disk = theirNumbers.beats[id]?.full;
    const label = here && disk && here !== disk
      ? "Beat " + here + " (Open here) / " + disk + " (On disk)" : "Beat " + (here ?? disk ?? "");
    groups.push({ label, note: mergeRowFate(bb, m, t), entries: entries });
  });

  const tagEntries = mergeListEntries("Breakdown", (mine as MergeReviewDocument).productionTags, theirs.productionTags,
    function (t) { return t.id || registryKey(t.cat, t.name); },
    function (t) { const c = tagCategory(t.cat); return (c ? c.label + " " : "") + t.name; },
    function (t) {
      const st = tagStatus(t.status);
      return mergeItemSummary([t.name, st ? st.label : "Needed", t.owner, t.notes]);
    });
  if (tagEntries.length) groups.push({ label: "Production breakdown", entries: tagEntries });

  const peopleEntries = mergeListEntries("Crew", (mine as MergeReviewDocument).people, theirs.people,
    function (p) { return normalizeTagName(p.name); },
    function (p) { return p.name; },
    function (p) { return p.name; });
  if (peopleEntries.length) groups.push({ label: "Crew", entries: peopleEntries });

  const brollEntries = mergeListEntries("B-roll", (mine as MergeReviewDocument).brollShots, theirs.brollShots,
    function (s) { return s.id; },
    function (s) { return s.name || "Filmed"; },
    function (s) {
      return mergeItemSummary([s.name, s.desc, s.location, s.owner, s.audioRef, s.notes,
        s.status === "shot" ? "Filmed" : "To film", s.reshoot ? "Flagged" : "",
        (Array.isArray(s.props) ? s.props : []).map(function (p: NonNullable<DocumentShot["props"]>[number]) { return p && p.name; }).filter(Boolean).join(", ")]);
    });
  if (brollEntries.length) groups.push({ label: "B-roll", entries: brollEntries });

  return groups;
}

function mergeDiffImageHtml(row: DocumentRow | null) {
  const img = rowImage(row);
  if (img && img.ref) return blobImgHtml(img.ref, "diff-img");
  const ok = img ? safeImageSrc(img.dataUrl) : null;
  return ok ? '<img class="diff-img" src="' + escapeHtml(ok) + '" alt="">'
            : '<em class="diff-empty">(no image)</em>';
}

function mergeEntryHtml(e: ReturnType<typeof mergeDiffModel>[number]["entries"][number]) {
  return '<div class="merge-entry" data-outcome="' + escapeHtml(e.outcome || "both") + '">' +
    '<div class="merge-entry-head">' + escapeHtml(e.label) +
      '<span class="merge-entry-outcome">' + escapeHtml(e.text || MERGE_OUTCOME_TEXT[e.outcome as keyof typeof MERGE_OUTCOME_TEXT] || "") + "</span></div>" +
    '<div class="merge-sides">' +
      '<div class="merge-side"><div class="merge-side-head">Open here</div>' +
        '<div class="merge-side-body">' + e.mineHtml + "</div></div>" +
      '<div class="merge-side"><div class="merge-side-head">On disk</div>' +
        '<div class="merge-side-body">' + e.theirsHtml + "</div></div>" +
    "</div></div>";
}

function mergeGroupHtml(g: ReturnType<typeof mergeDiffModel>[number]) {
  return '<div class="merge-group">' +
    '<div class="merge-group-head">' + escapeHtml(g.label) +
      (g.note ? '<span class="merge-group-note">' + escapeHtml(g.note) + "</span>" : "") + "</div>" +
    g.entries.map(mergeEntryHtml).join("") +
  "</div>";
}

function openMergeReview() {
  if (!mergePermitted()) return;
  if (!mergeCandidate || !currentDocument()) return;
  const groups = mergeDiffModel(mergeCandidate.base, currentDocument(), mergeCandidate.theirs);
  const count = groups.reduce(function (n, g) { return n + g.entries.length; }, 0);
  (document.getElementById("merge-review-detail") as HTMLElement).textContent = count
    ? (count === 1 ? "One field differs" : count + " fields differ") +
      " between " + (mergeCandidate.fileName || "the file on disk") + " and what you have open" +
      (mergeCandidate.base ? "" : ", and there is no earlier version of this file to compare both against, " +
        "so every one of them is treated as changed on both sides") +
      ". Nothing is written until you merge."
    : "Nothing differs between " + (mergeCandidate.fileName || "the file on disk") +
      " and what you have open.";
  (document.getElementById("merge-review-list") as HTMLElement).innerHTML = count
    ? groups.map(mergeGroupHtml).join("")
    : '<div class="comments-empty">The two versions say the same thing.</div>';
  (document.getElementById("file-conflict-modal") as HTMLElement).hidden = true;
  (document.getElementById("merge-review-modal") as HTMLElement).hidden = false;
  (document.getElementById("merge-review-confirm") as HTMLElement).focus();
}

function cancelMergeReview() {
  (document.getElementById("merge-review-modal") as HTMLElement).hidden = true;
  (document.getElementById("merge-review-list") as HTMLElement).innerHTML = "";
  if (mergeCandidate && mergeAllowed()) (document.getElementById("file-conflict-modal") as HTMLElement).hidden = false;
}

function confirmFileMerge() {
  if (!mergePermitted()) { cancelMergeReview(); return; }
  const cand = mergeCandidate;
  if (!cand || !currentDocument()) { cancelMergeReview(); return; }
  (document.getElementById("merge-review-modal") as HTMLElement).hidden = true;
  (document.getElementById("merge-review-list") as HTMLElement).innerHTML = "";
  fileConflicts().close();

  const diskCopy = cloneState(cand.theirs);
  const prevDocId = (currentDocument() as Pick<MergeReviewDocument, "docId">).docId;
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

export function startLocalMerge(given: MergeReviewPorts) {
  ports = given;
  let disposed = false;
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
