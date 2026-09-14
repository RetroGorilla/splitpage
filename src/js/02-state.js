  /* ================= state ================= */

  function defaultState() {
    try {
      return JSON.parse(document.getElementById("state-data").textContent);
    } catch (e) {
      return { title: "Untitled Script", rows: [] };
    }
  }

  function makeId(prefix) {
    return (prefix || "r") + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
  }

  function escapeHtml(s) {
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
  function legacyMdToHtml(text) {
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
  function migrateRows(s) {
    if (!s || typeof s !== "object") s = { title: "Untitled Script", rows: [], comments: [] };
    /* "!== SCHEMA_VERSION" used to fire for ANY schema that wasn't exactly
       today's constant — including a NEWER one (e.g. saved by a future
       build, or just hand-set to a bogus number). That re-ran the lossy
       legacyMdToHtml conversion on ordinary, already-migrated content the
       moment SCHEMA_VERSION is next bumped for an unrelated reason. This is
       an "older than current" test instead: missing/non-numeric reads as
       the oldest possible schema (legacy), anything current or newer is not. */
    var legacy = typeof s.schema !== "number" || s.schema < SCHEMA_VERSION;

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
    });

    /* The production registry — see the comment above productionEntries()
       for why this exists as real, separate storage rather than being read
       straight off the script like the rest of tagging is. A file saved
       before this existed has no such list yet: back-fill it from whatever
       is tagged in the script right now, so opening an old file doesn't
       just silently start tracking nothing. */
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

    if (!Array.isArray(s.productionTags)) {
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

  async function loadInitialState() {
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
      docIdWrittenOut = false;
      return migrateRows(defaultState());
    }
    docIdWrittenOut = true;
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
  function buildPublishHtml(stateJson) {
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
