import { S } from "./_state.js";
import { PAGE_SHELL, SCHEMA_VERSION } from "./00-prelude.js";
import { rowStatus } from "./01-scene-status.js";
import { migrateDocument, mintDocId, normalizeDocId } from "./02b-doc-id.js";
import { internDataUrl, queuePersist, recordFor } from "./02c-blobs.js";
import { migrateGallery } from "./02d-gallery.js";
import { isSha256Hex, normalizeImageRef } from "../../shared/blob-policy.js";
import { mergeBrollShots, mergePeople, mergeProductionTags } from "./03-sync.js";
import {
  buildVideoCardEl,
  plainName,
  plainText,
  safeHref,
  safeId,
  safeImageSrc,
  sanitizeHtml,
  storedImageHtml
} from "./04-richtext.js";
import { mediaCommentId } from "../core/document/ids.ts";
import { normalizePersonColors } from "../core/document/person-colors.ts";
import { escapeHtml, legacyMdToHtml } from "../core/document/text-policy.ts";
import { DEFAULT_WPM, normalizeSceneLength, normalizeTargetLength } from "../core/document/timing.ts";
import {
  TAG_CATEGORIES,
  TAG_STATUSES,
  collectTagsFromRows,
  ensureTagIds,
  missingRegistryTags,
  tagCategory,
  tagStatus
} from "./07-production-tags.js";
import { fromHtml, syncCommentAnchors, toHtml } from "./04c-doc-model.js";
import { BROLL_STATUSES, brollStatus, normalizeBrollProps } from "./08c-broll.js";
import { seedCheckPasses } from "./20b-onboarding.js";
export { makeId } from "../adapters/identity/ids.ts";
export { escapeHtml, legacyMdToHtml, mediaCommentId };

function defaultState() {
  try {
    return JSON.parse(document.getElementById("state-data").textContent);
  } catch (e) {
    return { title: "Untitled Script", rows: [] };
  }
}

export var STATE_FIELDS = [
  { key: "title",          merge: "title",  def: function () { return ""; } },
  { key: "docId",          merge: "doc-id" },
  { key: "rows",           merge: "rows",     def: function () { return []; } },
  { key: "comments",       merge: "comments", def: function () { return []; } },
  { key: "people",         merge: "list-union-with-base", def: function () { return []; },
    mergeList: function (b, m, t) { return mergePeople(b, m, t); } },
  { key: "productionTags", merge: "list-union-with-base", def: function () { return []; },
    mergeList: function (b, m, t) { return mergeProductionTags(b, m, t); } },
  { key: "brollShots",     merge: "list-union-with-base", def: function () { return []; },
    mergeList: function (b, m, t) { return mergeBrollShots(b, m, t); } },
  { key: "wordsPerMinute", merge: "changed-side-wins", def: function () { return DEFAULT_WPM; } },
  { key: "rev",            merge: "max-plus-one", def: function () { return 0; } },
  { key: "lastEditedBy",   merge: "theirs-wins" },
  { key: "lastEditedAt",   merge: "theirs-wins" },
  { key: "personColors",   merge: "person-colors" },
  { key: "targetSeconds",  merge: "target-length" },
  { key: "schema",         merge: "constant" }
];

export function missingStateFields(s) {
  return STATE_FIELDS.filter(function (f) {
    return f.def && (!s || !(f.key in s));
  }).map(function (f) { return f.key; });
}

var MEDIA_COMMENT_NOTE = {
  visualText: "This was in the scene's visual column. Pictures and videos go in comments now:",
  audioText: "This was in the scene's audio column. Pictures and videos go in comments now:"
};

function moveMediaOutOfCell(row, field) {
  var found = [];
  var cell = fromHtml(row[field], { onMedia: function (m) { found.push(m); } });
  row[field] = toHtml(cell);
  var out = [];
  var seen = Object.create(null);
  found.forEach(function (m) {
    var key, media;
    if (m.kind === "image") {
      var sha = m.ref && m.ref.sha256;
      if (!isSha256Hex(sha)) return;
      key = "img:" + sha;
      var rec = recordFor(sha) || normalizeImageRef(m.ref);
      media = rec ? storedImageHtml(rec) : '<img class="comment-img" data-blob="' + sha + '">';
    } else {
      var href = safeHref(m.href || "");
      if (!href) return;
      key = "video:" + href;
      media = buildVideoCardEl(href).outerHTML;
    }
    var id = mediaCommentId(row.id, field, key);
    if (seen[id]) return;
    seen[id] = true;
    out.push({
      id: id,
      rowId: row.id,
      field: field,
      anchorId: null,
      quotedText: "",
      author: "Splitpage",
      body: MEDIA_COMMENT_NOTE[field] + "<br>" + media,
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      assignee: "",
      createdAt: row.updatedAt || "",
      updatedAt: row.updatedAt || "",
      kind: "anchor",
      replies: []
    });
  });
  return out;
}

export function migrateRows(s) {
  if (!s || typeof s !== "object") s = { title: "Untitled Script", rows: [], comments: [] };
  var legacy = typeof s.schema !== "number" || s.schema < SCHEMA_VERSION;

  var hadTagRegistry = "productionTags" in s;

  STATE_FIELDS.forEach(function (f) {
    if (f.def && s[f.key] === undefined) s[f.key] = f.def();
  });

  if (!Array.isArray(s.rows)) s.rows = [];
  s.rows = s.rows.filter(function (r) { return r && typeof r === "object"; });
  var movedMedia = [];
  s.rows.forEach(function (r) {
    r.id = safeId(r.id, "r");
    r.status = rowStatus(r.status) ? r.status : "todo";
    var setLength = normalizeSceneLength(r.lengthSeconds);
    if (setLength === undefined) delete r.lengthSeconds; else r.lengthSeconds = setLength;
    r.visualText = sanitizeHtml(legacy ? legacyMdToHtml(r.visualText || "") : (r.visualText || ""));
    r.audioText = sanitizeHtml(legacy ? legacyMdToHtml(r.audioText || "") : (r.audioText || ""));
    var legacyImage = safeImageSrc(r.visualImage);
    var interned = legacyImage ? internDataUrl(legacyImage) : null;
    if (interned) queuePersist([interned.sha256]);
    r.imageRef = interned || normalizeImageRef(r.imageRef) || null;
    delete r.visualImage;
    migrateGallery(r);
    if (!r.updatedAt) r.updatedAt = "";
    r.updatedBy = r.updatedBy ? plainName(r.updatedBy) : null;
    ["visualText", "audioText"].forEach(function (field) {
      if (/<img|video-embed-card/.test(r[field])) movedMedia = movedMedia.concat(moveMediaOutOfCell(r, field));
    });
  });

  if (!Array.isArray(s.comments)) s.comments = [];
  s.comments = s.comments.filter(function (c) { return c && typeof c === "object"; });
  if (movedMedia.length) {
    var haveComment = Object.create(null);
    s.comments.forEach(function (c) { haveComment[safeId(c.id, "c")] = true; });
    movedMedia.forEach(function (c) {
      if (haveComment[c.id]) return;
      haveComment[c.id] = true;
      s.comments.push(c);
    });
  }
  s.comments.forEach(function (c) {
    c.id = safeId(c.id, "c");
    if (c.field === "title") {
      c.rowId = null;
      c.anchorId = null;
    } else {
      c.rowId = safeId(c.rowId, "r");
      c.anchorId = safeId(c.anchorId || c.id, "c");
      c.field = (c.field === "visualText" || c.field === "visualImage") ? c.field : "audioText";
    }
    if (!Array.isArray(c.replies)) c.replies = [];
    c.replies = c.replies.filter(function (rep) { return rep && typeof rep === "object"; });
    c.replies.forEach(function (rep) {
      rep.id = safeId(rep.id, "rp");
      rep.body = sanitizeHtml(rep.body || "");
      rep.author = plainName(rep.author);
    });
    c.body = sanitizeHtml(c.body || "");
    c.quotedText = plainText(c.quotedText);
    if (typeof c.resolved !== "boolean") c.resolved = false;
    c.author = plainName(c.author);
    if (!c.updatedAt) c.updatedAt = c.createdAt || null;
    if (c.kind !== "conflict") c.kind = "anchor";
    if (c.kind === "conflict" && c.field === "visualImage") {
      var bodyImg = /<img\b[^>]*\sdata-blob="([0-9a-f]{64})"/.exec(c.body);
      var bodyRec = bodyImg ? recordFor(bodyImg[1]) : null;
      c.imageValue = bodyRec || normalizeImageRef(c.imageValue) || null;
      c.body = c.imageValue ? storedImageHtml(c.imageValue) : "";
    } else if ("imageValue" in c) {
      delete c.imageValue;
    }
    if (!c.resolved) {
      c.resolvedBy = null;
      c.resolvedAt = null;
    } else {
      var resolvedByClean = c.resolvedBy ? plainText(c.resolvedBy).trim().slice(0, 80) : "";
      c.resolvedBy = resolvedByClean || null;
      c.resolvedAt = (c.resolvedBy && typeof c.resolvedAt === "string" && c.resolvedAt) ? c.resolvedAt : null;
    }
    c.assignee = c.assignee ? plainText(c.assignee).trim().slice(0, 80) : "";
  });
  syncCommentAnchors(s);

  if (!Array.isArray(s.people)) s.people = [];
  s.people = s.people.filter(function (p) { return p && typeof p === "object"; });
  s.people.forEach(function (p) {
    p.id = safeId(p.id, "p");
    p.name = plainText(p.name).trim().slice(0, 60);
  });
  s.people = s.people.filter(function (p) { return p.name; });
  var knownPeople = Object.create(null);
  s.people.forEach(function (p) { knownPeople[p.id] = true; });

  if (!hadTagRegistry || !Array.isArray(s.productionTags)) {
    s.productionTags = collectTagsFromRows(s.rows).map(function (t) {
      return { cat: t.cat.id, name: t.name };
    });
  }
  s.productionTags = s.productionTags.filter(function (t) { return t && typeof t === "object"; });
  s.productionTags.forEach(function (t) {
    t.cat = (tagCategory(t.cat) || TAG_CATEGORIES[0]).id;
    t.name = plainText(t.name).trim().slice(0, 80);
    t.status = (tagStatus(t.status) || TAG_STATUSES[0]).id;
    t.owner = knownPeople[t.owner] ? t.owner : "";
    t.notes = plainText(t.notes).slice(0, 2000);
  });
  s.productionTags = s.productionTags.filter(function (t) { return t.name; });
  missingRegistryTags(s.rows, s.productionTags).forEach(function (t) {
    s.productionTags.push(t);
  });
  ensureTagIds(s.productionTags);

  if (!Array.isArray(s.brollShots)) s.brollShots = [];
  s.brollShots = s.brollShots.filter(function (b) { return b && typeof b === "object"; });
  s.brollShots.forEach(function (b) {
    b.id = safeId(b.id, "bs");
    b.name = plainText(b.name).trim().slice(0, 200);
    b.desc = plainText(b.desc).slice(0, 2000);
    b.status = (brollStatus(b.status) || BROLL_STATUSES[0]).id;
    b.reshoot = b.reshoot === true;
    b.notes = plainText(b.notes).slice(0, 2000);
    b.audioRef = plainText(b.audioRef).slice(0, 2000);
    b.location = plainText(b.location).trim().slice(0, 80);
    b.owner = knownPeople[b.owner] ? b.owner : "";
    b.origin = b.origin === "list" ? "list" : "script";
    b.props = normalizeBrollProps(b.props, s.productionTags);
  });
  s.brollShots = s.brollShots.filter(function (b) { return b.name; });

  var wpm = Number(s.wordsPerMinute);
  s.wordsPerMinute = (isFinite(wpm) && wpm >= 60 && wpm <= 400) ? Math.round(wpm) : DEFAULT_WPM;

  if ("personColors" in s) {
    var personColors = normalizePersonColors(s.personColors);
    if (personColors) s.personColors = personColors;
    else delete s.personColors;
  }

  if ("targetSeconds" in s) {
    var target = normalizeTargetLength(s.targetSeconds);
    if (target === undefined) delete s.targetSeconds;
    else s.targetSeconds = target;
  }

  s.title = plainText(s.title).slice(0, 300);
  if (typeof s.rev !== "number") s.rev = 0;
  s.docId = normalizeDocId(s.docId) || mintDocId();
  s.schema = SCHEMA_VERSION;
  return s;
}

export async function loadInitialState() {
  var raw = null;
  var pristine = seedCheckPasses();
  if (!pristine) {
    try { raw = JSON.parse(document.getElementById("state-data").textContent); } catch (e) { raw = null; }
  }
  if (pristine || !raw || typeof raw !== "object" || (!raw.rev && !raw.lastEditedBy)) {
    S.docIdWrittenOut = false;
    return migrateRows(defaultState());
  }
  S.docIdWrittenOut = true;
  return migrateDocument(raw, { kind: "file" });
}

export function buildPublishHtml(stateJson) {
  var CLOSE_SCRIPT = "<" + "/script>";
  var openTag = '<script id="state-data" type="application/json">';
  var start = PAGE_SHELL.indexOf(openTag);
  if (start === -1) throw new Error("state-data anchor missing from the page shell");
  var openEnd = start + openTag.length;
  var close = PAGE_SHELL.indexOf(CLOSE_SCRIPT, openEnd);
  if (close === -1) throw new Error("state-data closing tag missing from the page shell");
  var safeJson = String(stateJson).replace(/<\//g, "<\\/");
  return PAGE_SHELL.slice(0, openEnd) + "\n" + safeJson + "\n" + PAGE_SHELL.slice(close);
}

export function __init() {}
