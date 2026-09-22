import { S } from "./_state.js";
import { PAGE_SHELL, SCHEMA_VERSION } from "./00-prelude.js";
import { DEFAULT_WPM, rowStatus } from "./01-scene-status.js";
import { migrateDocument, mintDocId, normalizeDocId } from "./02b-doc-id.js";
import { mergeBrollShots, mergePeople, mergeProductionTags } from "./03-sync.js";
import {
  plainName,
  plainText,
  safeHref,
  safeId,
  safeImageSrc,
  sanitizeHtml
} from "./04-richtext.js";
import {
  TAG_CATEGORIES,
  TAG_STATUSES,
  collectTagsFromRows,
  missingRegistryTags,
  tagCategory,
  tagStatus
} from "./07-production-tags.js";
import { BROLL_STATUSES, brollStatus } from "./08c-broll.js";
import { seedCheckPasses } from "./20b-onboarding.js";

/* ================= state ================= */

function defaultState() {
  try {
    return JSON.parse(document.getElementById("state-data").textContent);
  } catch (e) {
    return { title: "Untitled Script", rows: [] };
  }
}

/* ---- the state field registry ----------------------------------------
   Every top-level field a document has, in one table: what it defaults to
   when it is missing, and how mergeStates reconciles it.

   `migrateRows` fills the defaults in from here, `mergeStates`
   (03-sync.js) builds its result by walking it, and both project writers
   go through `migrateRows`, so a field listed here cannot be dropped from
   a save either. That is HANDOFF invariant #4 as code rather than as a
   warning: before this table, mergeStates ended in a hand-written object
   literal, and a field missing from that literal was destroyed on every
   merge — which is exactly what happened to `people` and
   `productionTags` once already (#60). Adding a field is now one row.

   `def` is the value a document without the field gets; the entries with
   no `def` are the ones migrateRows has always had bespoke handling for
   (docId is minted, schema is stamped) or that only a server ever sets,
   where a defaulted null would put a key into every local save that has
   never had one.

   `merge` names the strategy; `mergeList` carries the list merge itself,
   wrapped so the table can be built before 03-sync.js's declarations are
   evaluated. The strategies:
     rows / comments / title / doc-id  — computed in mergeStates itself
     list-union-with-base — union both sides, minus what one deleted and
                            the other left alone (#61)
     changed-side-wins    — whoever moved it off base wins, theirs if both
     max-plus-one         — a revision counter
     theirs-wins          — theirs, then mine, then nothing
     constant             — stamped, never reconciled
*/
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
  { key: "schema",         merge: "constant" }
];

/* Which registry fields a state is missing entirely. Used by the suites
   rather than by the app: the point of the table is that this list is
   always empty, and a check is the only thing that keeps it that way. */
export function missingStateFields(s) {
  return STATE_FIELDS.filter(function (f) {
    return f.def && (!s || !(f.key in s));
  }).map(function (f) { return f.key; });
}

export function makeId(prefix) {
  return (prefix || "r") + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* one-time upgrade path for rows saved before rich text: plain markdown-ish
   text (no tags) gets turned into the equivalent HTML.
   There used to be an early return here for text that "already looks like
   HTML" (contained a '<'). A schema<SCHEMA_VERSION row predates rich text
   by definition, so it can never legitimately contain real markup — that
   check only ever fired on plain text that happened to contain a bracketed
   note (e.g. "<insert B-roll here>"), and silently deleted it once
   sanitizeHtml's DOMParser tried to parse the bracket as an unknown tag.
   Removed: every legacy row is now always escaped-then-transformed, so a
   stray '<' survives as visible text the way the rest of this function
   already treats every other character. */
export function legacyMdToHtml(text) {
  if (typeof text !== "string") return "";
  var out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  /* The other four things htmlToMarkdown() can emit. Without these, a
     Markdown table cell edited outside Splitpage and reconciled back in
     (20d-formats.js) lost every strikethrough, underline and highlight in
     it, and every line break inside the cell came back as the literal
     text "<br>". They run against the already-escaped string, so the
     markup here is reintroduced deliberately, one closed pair at a time,
     and sanitizeHtml() still has the last word at every call site. */
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  out = out.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/gi, "<u>$1</u>");
  out = out.replace(/&lt;mark&gt;([\s\S]*?)&lt;\/mark&gt;/gi, "<mark>$1</mark>");
  out = out.replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
    /* `url` was captured out of `out`, which escapeHtml() already ran over
       once — it is already correctly entity-encoded for an HTML attribute
       (e.g. a literal "&" is already "&amp;"). Escaping `safe` again here
       used to double-encode it ("&amp;amp;"), corrupting the query string
       of any link containing '&'. safeHref() only validates a scheme
       prefix; it does not decode, so passing the already-escaped string
       straight through is correct, not a bypass. */
    var safe = safeHref(url);
    return safe ? '<a href="' + safe + '" target="_blank" rel="noopener">' + label + '</a>' : m;
  });
  out = out.replace(/\n/g, "<br>");
  return out;
}

/* Everything that arrives from outside this page — a file on disk, a version
   someone else published, a restored snapshot — is untrusted. Normalise and
   sanitize it here, once, on the way in. `schema` marks content that has
   already been through this so plain text is never re-escaped on later loads. */
export function migrateRows(s) {
  if (!s || typeof s !== "object") s = { title: "Untitled Script", rows: [], comments: [] };
  /* "!== SCHEMA_VERSION" used to fire for ANY schema that wasn't exactly
     today's constant — including a NEWER one (e.g. saved by a future
     build, or just hand-set to a bogus number). That re-ran the lossy
     legacyMdToHtml conversion on ordinary, already-migrated content the
     moment SCHEMA_VERSION is next bumped for an unrelated reason. This is
     an "older than current" test instead: missing/non-numeric reads as
     the oldest possible schema (legacy), anything current or newer is not. */
  var legacy = typeof s.schema !== "number" || s.schema < SCHEMA_VERSION;

  /* Asked BEFORE the defaults pass below, which is the whole point: that
     pass gives productionTags its `[]`, after which "never had a registry"
     and "has an empty one" are indistinguishable. The back-fill further
     down needs to tell them apart — see #92, where it silently stopped
     firing for exactly the files it exists for. */
  var hadTagRegistry = "productionTags" in s;

  /* Defaults first, from the one table (#60), so a field added there is
     present on every document without a second edit here. The bespoke
     normalisation below still has the last word — a default only fills a
     key that is absent, and says nothing about a key holding rubbish. */
  STATE_FIELDS.forEach(function (f) {
    if (f.def && s[f.key] === undefined) s[f.key] = f.def();
  });

  if (!Array.isArray(s.rows)) s.rows = [];
  /* Untrusted input (see the file comment above this function) can contain
     a non-object element — a bad merge, a hand-edited save, a truncated
     file. Every field access below assumes an object; filter first so one
     stray null/primitive doesn't throw and take the whole load down with
     it, the same protection `people` already gets a few lines down. */
  s.rows = s.rows.filter(function (r) { return r && typeof r === "object"; });
  s.rows.forEach(function (r) {
    r.id = safeId(r.id, "r");
    r.status = rowStatus(r.status) ? r.status : "todo";
    r.visualText = sanitizeHtml(legacy ? legacyMdToHtml(r.visualText || "") : (r.visualText || ""));
    r.audioText = sanitizeHtml(legacy ? legacyMdToHtml(r.audioText || "") : (r.audioText || ""));
    r.visualImage = safeImageSrc(r.visualImage) || null;
    /* "" rather than null: formatTimestamp(iso) blanks out on an Invalid
       Date, and new Date(null) is a VALID date (the Unix epoch) while
       new Date("") is not — null here used to render as a fabricated
       "Jan 1, 12:00 AM" for any row that was never actually stamped. */
    if (!r.updatedAt) r.updatedAt = "";
    r.updatedBy = r.updatedBy ? plainName(r.updatedBy) : null;
  });

  if (!Array.isArray(s.comments)) s.comments = [];
  s.comments = s.comments.filter(function (c) { return c && typeof c === "object"; });
  s.comments.forEach(function (c) {
    c.id = safeId(c.id, "c");
    if (c.field === "title") {
      /* A document-level conflict card (mergeStates' title-merge
         fallback) — not anchored to any row, unlike every other comment.
         Forcing rowId through safeId() would fabricate a fake row id out
         of null (safeId's fallback is makeId(), not passthrough), and
         folding field into visualText/audioText below would silently
         turn it into an ordinary row comment pointing at that fake row. */
      c.rowId = null;
      c.anchorId = null;
    } else {
      c.rowId = safeId(c.rowId, "r");
      /* Falls back to the comment's own id, not null — deleteComment()
         looks up the anchor span by anchorId (unwrapAnchorInState), and
         every comment this app creates already sets anchorId === id
         (05-render.js). A loaded document whose comments lack the field
         (an older save, a hand-edited/foreign JSON) used to get
         anchorId: null, which never matches any real span's data-cmt —
         deleting such a comment would silently fail to unwrap its
         anchor, leaving a dangling .cmt-anchor wrapper in the row with
         no comment behind it forever. */
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
    /* resolvedBy/resolvedAt/assignee (#29). Free text, like author and
       updatedBy — there are no accounts here, nothing to verify against.
       Unresolving always clears both resolve fields, which is also what
       keeps a hand-edited file or an old merge from ever showing a
       resolver next to a comment that isn't actually resolved. A comment
       saved before this existed just has neither field, which reads the
       same way as "resolved, but nobody recorded who". */
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

  /* Who's responsible for each tracked item. Deliberately just names the
     user typed — there are no accounts here and nothing is verified; it's
     a crew list for sorting a breakdown by, not an identity system. */
  if (!Array.isArray(s.people)) s.people = [];
  s.people = s.people.filter(function (p) { return p && typeof p === "object"; });
  s.people.forEach(function (p) {
    p.id = safeId(p.id, "p");
    p.name = plainText(p.name).trim().slice(0, 60);
  });
  s.people = s.people.filter(function (p) { return p.name; });
  /* Object.create(null) — a plain {} inherits Object.prototype, so an
     owner id that happens to collide with an inherited member name
     (e.g. "constructor", "hasOwnProperty") would resolve truthy below
     even with no matching person, leaving a dangling owner id instead
     of clearing it to "" as intended. */
  var knownPeople = Object.create(null);
  s.people.forEach(function (p) { knownPeople[p.id] = true; });

  /* The production registry — see the comment above productionEntries()
     for why this exists as real, separate storage rather than being read
     straight off the script like the rest of tagging is. A file saved
     before this existed has no such list yet: back-fill it from whatever
     is tagged in the script right now, so opening an old file doesn't
     just silently start tracking nothing.

     `hadTagRegistry`, not an emptiness test: a registry the user emptied
     on purpose must stay empty, or every load would resurrect every tag
     they just deleted. The Array.isArray half still catches a key holding
     rubbish — null, a string — from a bad merge or a hand-edited save. */
  if (!hadTagRegistry || !Array.isArray(s.productionTags)) {
    s.productionTags = collectTagsFromRows(s.rows).map(function (t) {
      return { cat: t.cat.id, name: t.name };
    });
  }
  s.productionTags = s.productionTags.filter(function (t) { return t && typeof t === "object"; });
  s.productionTags.forEach(function (t) {
    t.cat = (tagCategory(t.cat) || TAG_CATEGORIES[0]).id;
    t.name = plainText(t.name).trim().slice(0, 80);
    /* a file saved before per-item status existed has none: everything in
       it starts at the beginning, which is true — nobody had recorded
       getting any of it yet */
    t.status = (tagStatus(t.status) || TAG_STATUSES[0]).id;
    /* an owner pointing at a person who is no longer on the list reads as
       unassigned rather than as a dangling id nothing can resolve */
    t.owner = knownPeople[t.owner] ? t.owner : "";
    t.notes = plainText(t.notes).slice(0, 2000);
  });
  s.productionTags = s.productionTags.filter(function (t) { return t.name; });
  /* ...and a registry the document already has gains an entry for any tag
     live in its script that it lacks. This is the registry self-heal as a
     migration step (#84): productionEntries() used to write these entries
     itself, as a side effect of the first read after a load, so every
     document already looked this way the moment it was on screen. Doing it
     here keeps that, and keeps reads pure. It never resurrects anything a
     user deleted — deleting a live item strips its labels from the script
     too (removeTag), which is what makes it not live. */
  missingRegistryTags(s.rows, s.productionTags).forEach(function (t) {
    s.productionTags.push(t);
  });

  /* The b-roll list (08c-broll.js). Like the production registry it is
     real storage rather than a pure read of the script, and for one more
     reason on top of that one: the audio reference and the location are
     seeded from the scene and then edited, so they exist nowhere else. A
     file saved before this existed has no list; the markers in it are
     picked up by the first scan and matched by name from then on, so
     there is nothing to back-fill here. */
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
  });
  /* A nameless entry renders as a blank card nobody can identify. If its
     marker is still in the script the next scan mints it again, with the
     same id off the marker itself — so nothing live is lost by dropping
     it here. */
  s.brollShots = s.brollShots.filter(function (b) { return b.name; });

  /* Reading speed is a property of the person, not the script, but it has
     to travel with the file so the estimate means the same thing to
     whoever opens it next. Clamped to a range a human can actually read at. */
  var wpm = Number(s.wordsPerMinute);
  s.wordsPerMinute = (isFinite(wpm) && wpm >= 60 && wpm <= 400) ? Math.round(wpm) : DEFAULT_WPM;

  s.title = plainText(s.title).slice(0, 300);
  if (typeof s.rev !== "number") s.rev = 0;
  /* The document's identity (02b-doc-id.js). A missing or hostile id must
     fail UNIQUE, never shared: two documents that end up with one id share
     one version history, and "restore an earlier version" would then hand
     you somebody else's script. So anything that is not a canonical id is
     replaced with a random one here, and the ingress paths that can do
     better (a legacy file's content, a server document's id) override it
     afterwards in migrateDocument(). */
  s.docId = normalizeDocId(s.docId) || mintDocId();
  s.schema = SCHEMA_VERSION;
  return s;
}

export async function loadInitialState() {
  /* The #state-data script tag embedded in this very page IS the saved
     document — see buildPublishHtml(). (An earlier version of this app
     kept state in a side file, "data/state.json", saved with the files
     form of publish(); that form is not available to this artifact —
     every such save silently failed with capability_disabled — so that
     path has been removed rather than left as a trap.)

     Identity: the pristine seed, an unreadable block, or a page nobody
     ever saved gets a random id that has never left this page
     (docIdWrittenOut false). A legacy .html page that WAS saved is a real
     document on disk, so it goes through migrateDocument and a page
     without an embedded id gets the same content-derived id on every
     open instead of a new random one each launch. */
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

/* Build the complete replacement page for a save: splice the new document
   into PAGE_SHELL's #state-data script tag. "</" is escaped to "<\/"
   wherever it appears in the JSON — valid JSON (an alternate encoding of
   "/") and the only way to guarantee a stray closing-script-tag sequence
   inside someone's dialogue can't prematurely close the tag and break
   the page. (Note: that same sequence can never be written literally in
   THIS script block either — the HTML parser would stop reading this
   script right there — so it is always built from split pieces below.) */
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

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
