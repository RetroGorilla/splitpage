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
     text (no tags) gets turned into the equivalent HTML; anything that
     already looks like HTML is left alone */
  function legacyMdToHtml(text) {
    if (typeof text !== "string") return "";
    if (text.indexOf("<") !== -1) return text;
    var out = escapeHtml(text);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var safe = safeHref(url);
      return safe ? '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener">' + label + '</a>' : m;
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
    var legacy = s.schema !== SCHEMA_VERSION;

    if (!Array.isArray(s.rows)) s.rows = [];
    s.rows.forEach(function (r) {
      r.id = safeId(r.id, "r");
      r.status = rowStatus(r.status) ? r.status : "todo";
      r.visualText = sanitizeHtml(legacy ? legacyMdToHtml(r.visualText || "") : (r.visualText || ""));
      r.audioText = sanitizeHtml(legacy ? legacyMdToHtml(r.audioText || "") : (r.audioText || ""));
      r.visualImage = safeImageSrc(r.visualImage) || null;
      if (!r.updatedAt) r.updatedAt = null;
      r.updatedBy = r.updatedBy ? plainName(r.updatedBy) : null;
    });

    if (!Array.isArray(s.comments)) s.comments = [];
    s.comments.forEach(function (c) {
      c.id = safeId(c.id, "c");
      c.rowId = safeId(c.rowId, "r");
      c.anchorId = c.anchorId ? safeId(c.anchorId, "c") : null;
      c.field = (c.field === "visualText" || c.field === "visualImage") ? c.field : "audioText";
      if (!Array.isArray(c.replies)) c.replies = [];
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
    var knownPeople = {};
    s.people.forEach(function (p) { knownPeople[p.id] = true; });

    if (!Array.isArray(s.productionTags)) {
      s.productionTags = collectTagsFromRows(s.rows).map(function (t) {
        return { cat: t.cat.id, name: t.name };
      });
    }
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
    s.schema = SCHEMA_VERSION;
    return s;
  }

  async function loadInitialState() {
    /* The #state-data script tag embedded in this very page IS the saved
       document — see buildPublishHtml(). (An earlier version of this app
       kept state in a side file, "data/state.json", saved with the files
       form of publish(); that form is not available to this artifact —
       every such save silently failed with capability_disabled — so that
       path has been removed rather than left as a trap.) */
    return migrateRows(defaultState());
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

