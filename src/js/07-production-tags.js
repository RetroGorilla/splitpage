  /* ================= production tags =================

     A tag is not a separate record - it is a span wrapping the words in the
     script itself. Tags therefore travel with the text through editing,
     merging, restore and export with no bookkeeping of their own, and the
     breakdown is simply what you get when you read the script back. */

  var TAG_CATEGORIES = [
    { id: "prop",     label: "Prop",      plural: "Props & set dressing", color: "#C2703D" },
    { id: "location", label: "Location",  plural: "Locations & shots",    color: "#2F7D6B" },
    { id: "cast",     label: "Cast",      plural: "Cast & wardrobe",      color: "#7A5AA8" },
    { id: "vfx",      label: "VFX",       plural: "VFX & graphics",       color: "#B03A5B" },
    /* Split out of the old combined "VFX/SFX" bucket: music and sound are
       sourced, licensed and cleared by different people than graphics are,
       so they need their own list to hand over. The "vfx" id is unchanged,
       so a file saved before the split keeps every tag it had — nothing is
       silently re-filed; anything already tagged stays under VFX until
       someone moves it deliberately. */
    { id: "sound",    label: "Music/SFX", plural: "Music & SFX",          color: "#3D6DA8" },
    /* Equipment, not set dressing: the camera, the lav mic, the C-stand.
       Kept apart from Prop on purpose — different list, different person
       usually packing it — with its own typing shortcut for the same
       reason [prop]/{location}/~vfx~ have theirs: named enough, common
       enough while writing, to be worth a character. */
    { id: "gear",     label: "Gear",      plural: "Gear",                 color: "#A67C1F" }
  ];

  /* ---- how far along each tracked item is ----

     Assigning an owner answered "whose job is this"; this answers "have they
     done it". Four states, deliberately the same four whatever the category:
     nobody is on it yet, someone is getting it, it is in hand, it has gone
     back. "Returned" reads literally for a hired prop or a costume and
     figuratively for a location or a VFX shot — finished with, off the list —
     which is the only thing a shoot day needs to know either way.

     Per-category wording (Booked / Cast / Delivered…) was considered and
     dropped: five vocabularies for one idea, and the breakdown exports to a
     single flat sheet where one Status column has to mean the same thing in
     every row. Order is meaningful — it is the rank a merge uses, so two
     people editing the same file can never walk an item backwards. */
  var TAG_STATUSES = [
    { id: "needed",   label: "Needed",   color: "var(--text-faint)" },
    { id: "sourcing", label: "Sourcing", color: "var(--audio)" },
    { id: "have",     label: "Have it",  color: "var(--ok)" },
    { id: "returned", label: "Returned", color: "var(--text-dim)" }
  ];

  function tagStatus(id) {
    for (var i = 0; i < TAG_STATUSES.length; i++) {
      if (TAG_STATUSES[i].id === id) return TAG_STATUSES[i];
    }
    return null;
  }

  function tagStatusRank(id) {
    for (var i = 0; i < TAG_STATUSES.length; i++) {
      if (TAG_STATUSES[i].id === id) return i;
    }
    return 0;
  }

  function nextTagStatus(id) {
    return TAG_STATUSES[(tagStatusRank(id) + 1) % TAG_STATUSES.length].id;
  }

  /* Typing shortcuts: closing one of these around a phrase you just typed
     turns it straight into a tag of that category. They're deliberately
     characters nobody reaches for by accident in scripted prose —
     parentheses were ruled out for exactly that reason. Cast and Music/SFX
     have no shortcut on purpose: every remaining prose-safe character is
     spoken for, and both are still one Tab away from the autocomplete once
     one of them exists (see bestTagCompletion). */
  var TAG_SHORTCUTS = [
    { open: "[", close: "]", cat: "prop" },
    { open: "{", close: "}", cat: "location" },
    { open: "~", close: "~", cat: "vfx" },
    { open: "<", close: ">", cat: "gear" }
  ];

  var TAG_SHORTCUT_CHARS = (function () {
    var s = "";
    TAG_SHORTCUTS.forEach(function (r) {
      if (s.indexOf(r.open) === -1) s += r.open;
      if (s.indexOf(r.close) === -1) s += r.close;
    });
    return s;
  })();

  /* character-class test done by hand rather than a regex — "[" and "]" are
     the very characters that would need escaping in one */
  function hasShortcutChar(s) {
    for (var i = 0; i < s.length; i++) {
      if (TAG_SHORTCUT_CHARS.indexOf(s.charAt(i)) !== -1) return true;
    }
    return false;
  }

  function tagCategory(id) {
    for (var i = 0; i < TAG_CATEGORIES.length; i++) {
      if (TAG_CATEGORIES[i].id === id) return TAG_CATEGORIES[i];
    }
    return null;
  }

  function normalizeTagName(name) {
    return String(name == null ? "" : name).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function tagKey(cat, name) {
    return cat + " " + normalizeTagName(name);
  }

  function isInsideTagOrLink(el) {
    return !!(el && el.closest && el.closest(".tag-anchor, a"));
  }

  /* Read every tag span out of a set of rows and group them by category and
     name. Takes `rows` explicitly (rather than reading `state` directly) so
     migrateRows() can also use it to back-fill the production registry
     before `state` itself exists yet — see migrateRows(). */
  /* Parsing a field is the expensive part of every scan — inertBody() spins
     up a whole DOMParser document — and a scan re-reads every field of every
     row. Typing changes exactly one field, so the other N-1 parses are pure
     waste, and a refresh runs several scans back to back.

     The cache is keyed on the field's HTML itself rather than on a document
     version counter. That is the point: a content key cannot go stale. If the
     text changed, the key changed, and there is no mutation site anyone can
     forget to invalidate — the failure mode of a version counter, and the one
     that would quietly show the wrong breakdown. Cleared wholesale when it
     grows past a bound, since editing mints a new key per keystroke. */
  /* Budgeted by CHARACTERS, not by entry count. A field can carry a pasted
     image as a data: URI (walkSanitize allows <img>), so one entry can be
     megabytes — and typing in such a field mints a new key per keystroke.
     Capping at "1200 entries" would have been a memory leak measured in
     gigabytes; capping at ~2M characters is a few MB whatever the mix.
     Keys are the very strings state already holds, so a live entry costs a
     pointer; only superseded versions are extra. */
  var MEMO_CHAR_BUDGET = 2000000;

  function contentMemo(compute) {
    var cache = new Map();
    var chars = 0;
    return function (html) {
      var key = html || "";
      var hit = cache.get(key);
      if (hit !== undefined) return hit;
      var val = compute(key);
      if (chars > MEMO_CHAR_BUDGET) { cache.clear(); chars = 0; }
      cache.set(key, val);
      chars += key.length;
      return val;
    };
  }

  /* The returned array is SHARED with every other caller for the same field
     content — read it, never mutate it. Mentions are built around it. */
  var tagsInField = contentMemo(function (html) {
    var out = [];
    var body = inertBody(html);
    Array.prototype.forEach.call(body.querySelectorAll(".tag-anchor"), function (el) {
      var catId = el.getAttribute("data-tag-cat");
      var name = (el.getAttribute("data-tag-name") || "").trim();
      if (!catId || !name) return;
      out.push({ catId: catId, name: name, text: (el.textContent || "").trim() });
    });
    return out;
  });

  function collectTagsFromRows(rows) {
    var groups = {}, order = [];
    (rows || []).forEach(function (row, rowIndex) {
      ["visualText", "audioText"].forEach(function (field) {
        tagsInField(row[field]).forEach(function (found) {
          var cat = tagCategory(found.catId);
          if (!cat) return;
          var key = tagKey(cat.id, found.name);
          if (!groups[key]) {
            groups[key] = { key: key, cat: cat, name: found.name, mentions: [] };
            order.push(key);
          }
          groups[key].mentions.push({
            rowId: row.id,
            rowIndex: rowIndex,
            field: field,
            text: found.text
          });
        });
      });
    });
    return order.map(function (k) { return groups[k]; });
  }

  function collectTags() {
    return collectTagsFromRows(state.rows);
  }

  /* ---- the production registry ----

     Everything else about tagging is a pure, stateless read of the script —
     see the comment above TAG_CATEGORIES. The *set of things being
     tracked* is the one deliberate exception: real, separate storage in
     state.productionTags (just a list of {cat, name}). A prop the
     production team is already sourcing shouldn't silently vanish from the
     breakdown just because the line of dialogue that mentioned it got cut —
     it should sit there flagged as no longer in the script until someone
     decides to actually delete it. Which scenes an item appears in, and how
     many times, still always comes straight from the live script, same as
     before — only *whether an item is tracked at all* isn't purely derived
     any more. */

  function registryKey(cat, name) {
    return cat + " " + normalizeTagName(name);
  }

  function registryEntry(cat, name) {
    var key = registryKey(cat, name);
    for (var i = 0; i < state.productionTags.length; i++) {
      if (registryKey(state.productionTags[i].cat, state.productionTags[i].name) === key) {
        return state.productionTags[i];
      }
    }
    return null;
  }

  function registerProductionTag(cat, name) {
    if (registryEntry(cat, name)) return;
    state.productionTags.push({ cat: cat, name: name, owner: "", notes: "", status: TAG_STATUSES[0].id });
  }

  /* ---- people ----

     Not users, not accounts, nothing verified — just names typed into a
     list so a breakdown can be grouped and handed to whoever is sourcing
     each thing. Tags point at a person by id rather than by name so that
     renaming someone doesn't quietly orphan every item assigned to them. */

  function personById(id) {
    if (!id) return null;
    for (var i = 0; i < state.people.length; i++) {
      if (state.people[i].id === id) return state.people[i];
    }
    return null;
  }

  function findOrAddPerson(name) {
    var clean = plainText(name).trim().slice(0, 60);
    if (!clean) return "";
    var norm = normalizeTagName(clean);
    for (var i = 0; i < state.people.length; i++) {
      if (normalizeTagName(state.people[i].name) === norm) return state.people[i].id;
    }
    var person = { id: makeId("p"), name: clean };
    state.people.push(person);
    return person.id;
  }

  function deletePerson(id) {
    state.people = state.people.filter(function (p) { return p.id !== id; });
    /* the items they were carrying stay tracked — they just go back to
       unassigned rather than disappearing along with the person */
    state.productionTags.forEach(function (t) { if (t.owner === id) t.owner = ""; });
  }

  function deleteProductionTagEntry(cat, name) {
    var key = registryKey(cat, name);
    var before = state.productionTags.length;
    state.productionTags = state.productionTags.filter(function (t) { return registryKey(t.cat, t.name) !== key; });
    return before !== state.productionTags.length;
  }

  /* Every tracked item, merged with its current live mentions if it has
     any. `orphaned` items are ones the registry remembers but that no
     longer appear anywhere in the script. Also self-heals the reverse case
     (a live tag somehow missing its registry entry) rather than just
     silently dropping it — quietly, without marking the document dirty,
     since nothing the user did actually changed. */
  function productionEntries() {
    var live = collectTags();
    var liveByKey = {};
    live.forEach(function (t) { liveByKey[registryKey(t.cat.id, t.name)] = t; });

    var seen = {}, out = [];
    state.productionTags.forEach(function (t) {
      var cat = tagCategory(t.cat);
      if (!cat) return;
      var key = registryKey(cat.id, t.name);
      if (seen[key]) return;
      seen[key] = true;
      var liveMatch = liveByKey[key];
      out.push({
        key: key,
        cat: cat,
        name: liveMatch ? liveMatch.name : t.name, /* prefer the script's current casing while it's live */
        mentions: liveMatch ? liveMatch.mentions : [],
        orphaned: !liveMatch,
        owner: t.owner || "",
        notes: t.notes || "",
        status: (tagStatus(t.status) || TAG_STATUSES[0]).id
      });
    });
    live.forEach(function (t) {
      var key = registryKey(t.cat.id, t.name);
      if (seen[key]) return;
      seen[key] = true;
      registerProductionTag(t.cat.id, t.name);
      out.push({ key: key, cat: t.cat, name: t.name, mentions: t.mentions,
                 orphaned: false, owner: "", notes: "", status: TAG_STATUSES[0].id });
    });
    return out;
  }

  function tagsByCategory(all) {
    all = all || productionEntries();
    return TAG_CATEGORIES.map(function (cat) {
      var items = all.filter(function (t) { return t.cat.id === cat.id; });
      items.sort(function (a, b) {
        if (!!a.orphaned !== !!b.orphaned) return a.orphaned ? 1 : -1;
        if (b.mentions.length !== a.mentions.length) return b.mentions.length - a.mentions.length;
        return a.name.localeCompare(b.name);
      });
      return { cat: cat, items: items };
    }).filter(function (g) { return g.items.length; });
  }

  /* Both the badge and the panel re-read the whole script to work out what's
     tagged. That is cheap to do once and wasteful to do on every keystroke,
     so typing coalesces them into one pass shortly after you stop. */
  var productionRefreshTimer = null;

  function scheduleProductionRefresh() {
    if (productionRefreshTimer) return;
    productionRefreshTimer = setTimeout(function () {
      productionRefreshTimer = null;
      if (!state) return;
      /* renderProduction() updates both badges from the scan it already
         does; only pay for a separate count when neither panel showing
         those items is open and there is no render to piggyback on. The
         two can never both be open at once (see openSidePanel), but which
         one is is not worth branching on separately. */
      var panel = document.getElementById("production-panel");
      var gearPanel = document.getElementById("gear-panel");
      if ((panel && !panel.hidden) || (gearPanel && !gearPanel.hidden)) renderProduction();
      else updateTagBadges();
      updateScriptStats(); /* the runtime estimate moves with every word typed */
    }, 180);
  }

  function updateProductionBadge(n) {
    var badge = document.getElementById("production-badge");
    if (!badge) return;
    if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
    else badge.hidden = true;
  }

  /* For the callers that only want the badge and have no entries in hand. */
  function updateProductionCount() {
    updateProductionBadge(state ? productionEntries().length : 0);
  }

  /* Both header badges move together whenever a tag is created outside the
     debounced typing path — a shortcut closing, a ghost or an untagged
     mention accepted — where the point is instant feedback, not waiting out
     scheduleProductionRefresh's 180ms. updateGearCount() is defined further
     down, with the rest of the gear panel; hoisting makes the order fine. */
  function updateTagBadges() {
    updateProductionCount();
    updateGearCount();
  }

  /* ---- applying and editing tags ---- */

  function wrapRangeInTag(range, cat, name) {
    var frag = range.extractContents();
    var span = document.createElement("span");
    span.className = "tag-anchor";
    span.setAttribute("data-tag-cat", cat);
    span.setAttribute("data-tag-name", name);
    span.setAttribute("contenteditable", "false"); /* atomic — see the sanitizer's matching branch */
    span.appendChild(frag);
    range.insertNode(span);
    return span;
  }

  var AUTO_TAG_MAX_LEN = 60;

  /* Typing shortcut: closing one of the TAG_SHORTCUTS pairs around a phrase
     you just typed turns it straight into a tag of that category — the same
     span wrapRangeInTag() produces manually. Only live typing of the closing
     character triggers it (never paste, import, or a merge) — see the
     inputType/data guard below — and only within the text node that holds
     the caret, so it can never reach across a <br> or out of the field.
     Done via execCommand (like Enter and Ctrl+B elsewhere in this file) so
     it lands on the native undo stack: one Ctrl+Z removes just the auto-tag
     and leaves the plain "[phrase]" text behind, which is the whole escape
     hatch for anyone who wanted literal brackets. */
  function maybeAutoTagShortcut(e, cellEl) {
    /* insertText is only ever the browser's label for text the user (or their
       IME/keyboard) actually typed — never paste, undo, or a programmatic
       change. Check the data *ends with* the closer rather than *is* it: a
       single keystroke is the common case, but IME composition and some
       mobile keyboards commit several characters — the closer among them —
       as one event. */
    if (e.inputType !== "insertText" || !e.data) return;
    var typed = e.data.charAt(e.data.length - 1);
    var rule = null;
    for (var i = 0; i < TAG_SHORTCUTS.length; i++) {
      if (TAG_SHORTCUTS[i].close === typed) { rule = TAG_SHORTCUTS[i]; break; }
    }
    if (!rule) return;
    var sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var offset = range.startOffset;
    if (node.nodeType !== 3 || offset < 2 || node.data[offset - 1] !== rule.close) return;
    if (isInsideTagOrLink(node.parentNode)) return;

    var openAt = node.data.lastIndexOf(rule.open, offset - 2);
    if (openAt === -1) return;
    /* "~~struck through~~" is markdown emphasis, not a tag. For any rule
       whose opener and closer are the same character, a doubled opener means
       the writer is reaching for that instead — leave it alone. */
    if (rule.open === rule.close && node.data.charAt(openAt - 1) === rule.open) return;
    var phrase = node.data.slice(openAt + 1, offset - 1);
    var trimmed = phrase.trim();
    if (!trimmed || phrase.length > AUTO_TAG_MAX_LEN || hasShortcutChar(phrase)) return;

    var wrapRange = document.createRange();
    wrapRange.setStart(node, openAt);
    wrapRange.setEnd(node, offset);
    sel.removeAllRanges();
    sel.addRange(wrapRange);

    /* contenteditable="false" makes the tag an atomic unit: a browser will
       never place the text caret inside it, however it's approached — typed
       straight through (this insert), clicked back into later, arrowed
       into, anything. That's what actually stops later typing from silently
       growing the tag (or backspacing from silently shrinking it) into no
       longer matching its own stored name — a point-in-time caret nudge
       right after insertion, tried earlier, only ever covered this one
       moment and not, say, clicking back in after a pause to keep writing. */
    var html = '<span class="tag-anchor" data-tag-cat="' + escapeHtml(rule.cat) + '" data-tag-name="' +
      escapeHtml(trimmed) + '" contenteditable="false">' + escapeHtml(trimmed) + '</span>';
    document.execCommand("insertHTML", false, html);

    /* Belt and suspenders: land the caret explicitly right after the tag
       rather than trusting whatever the browser defaulted to. */
    var afterSel = window.getSelection();
    if (afterSel.rangeCount) {
      var landed = afterSel.getRangeAt(0).startContainer;
      var tagEl = (landed.nodeType === 3 ? landed.parentNode : landed).closest(".tag-anchor");
      if (tagEl) {
        var out = document.createRange();
        out.setStartAfter(tagEl);
        out.collapse(true);
        afterSel.removeAllRanges();
        afterSel.addRange(out);
      }
    }

    registerProductionTag(rule.cat, trimmed);
    syncFieldFromDom(cellEl);
    updateTagBadges();
    renderProduction();
  }

  /* ---- Tab-to-autocomplete an existing tag name, Obsidian-style ----

     While the caret sits inside an unclosed "[phrase" in a script cell, look
     for one already-tracked tag (any category) whose name starts with what's
     been typed so far, and show the rest of it as dim inline text right
     after the caret. Tab accepts it: the remainder is inserted, the bracket
     is closed, and the whole thing becomes a real tag span in that tag's own
     category — same mechanics as the "]" shortcut above, just started early
     and pointed at a name that already exists instead of always defaulting
     to Prop. Escape, a click, or an arrow key drops the suggestion; typing
     on just recomputes it, same as any other autocomplete. */
  var tagGhost = null; /* { cellEl, node, openAt, offset, phrase, entry } */

  function tagGhostEl() { return document.getElementById("tag-ghost"); }

  function hideTagGhost() {
    tagGhost = null;
    var el = tagGhostEl();
    if (el) el.classList.remove("is-visible");
  }

  /* Prefer the tag with the most mentions in the script (most likely what
     the writer means), then the shortest name (least left to type), then
     alphabetical, as a stable tiebreak. */
  function tagCompletionBeats(a, b) {
    if (!b) return true;
    if (a.mentions.length !== b.mentions.length) return a.mentions.length > b.mentions.length;
    if (a.name.length !== b.name.length) return a.name.length < b.name.length;
    return a.name.localeCompare(b.name) < 0;
  }

  /* Matches in the category the writer's own bracket implies win outright —
     typing "{kit" should reach for a location. Falling back to other
     categories after that is what keeps Cast and Music/SFX (which have no
     bracket of their own) completable at all, and stops a second, near
     duplicate entry being created in the wrong category. When the fallback
     is what's on offer, the ghost says which category it would land in, so
     accepting it is never a surprise — see updateTagGhost(). */
  function bestTagCompletion(phrase, preferCat) {
    var needle = phrase.toLowerCase();
    var inCat = null, anyCat = null;
    productionEntries().forEach(function (t) {
      if (t.name.toLowerCase().indexOf(needle) !== 0) return;
      if (t.name.length <= phrase.length) return; /* nothing left to complete */
      if (t.cat.id === preferCat && tagCompletionBeats(t, inCat)) inCat = t;
      if (tagCompletionBeats(t, anyCat)) anyCat = t;
    });
    return inCat || anyCat;
  }

  function updateTagGhost(cellEl) {
    hideTagGhost();
    var sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var offset = range.startOffset;
    if (node.nodeType !== 3 || !cellEl.contains(node)) return;
    if (isInsideTagOrLink(node.parentNode)) return;

    /* whichever shortcut opener sits closest behind the caret is the one
       being typed inside right now */
    var rule = null, openAt = -1;
    TAG_SHORTCUTS.forEach(function (r) {
      var at = node.data.lastIndexOf(r.open, offset - 1);
      if (at > openAt) { openAt = at; rule = r; }
    });
    if (!rule || openAt === -1) return;
    var phrase = node.data.slice(openAt + 1, offset);
    if (!phrase || phrase.length > AUTO_TAG_MAX_LEN || hasShortcutChar(phrase)) return;

    var entry = bestTagCompletion(phrase, rule.cat);
    if (!entry) return;

    var rect = range.getClientRects()[0];
    if (!rect) return;
    var el = tagGhostEl();
    if (!el) return;
    var cs = getComputedStyle(cellEl);
    el.style.font = cs.font;
    el.style.left = rect.right + "px";
    el.style.top = rect.top + "px";
    el.style.lineHeight = cs.lineHeight;
    el.innerHTML = escapeHtml(entry.name.slice(phrase.length)) +
      (entry.cat.id === rule.cat ? "" :
        '<span class="tag-ghost-cat">' + escapeHtml(entry.cat.label) + '</span>');
    el.classList.add("is-visible");

    tagGhost = { cellEl: cellEl, node: node, openAt: openAt, offset: offset, phrase: phrase, entry: entry };
  }

  /* Returns true if a suggestion was live and got accepted (caller should
     preventDefault the Tab that triggered it); false means Tab should fall
     through to its normal behavior. */
  function acceptTagGhost() {
    var g = tagGhost;
    if (!g) return false;
    var sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) { hideTagGhost(); return false; }
    var r = sel.getRangeAt(0);
    if (r.startContainer !== g.node || r.startOffset !== g.offset) { hideTagGhost(); return false; }

    var wrapRange = document.createRange();
    wrapRange.setStart(g.node, g.openAt);
    wrapRange.setEnd(g.node, g.offset);
    sel.removeAllRanges();
    sel.addRange(wrapRange);

    var html = '<span class="tag-anchor" data-tag-cat="' + escapeHtml(g.entry.cat.id) + '" data-tag-name="' +
      escapeHtml(g.entry.name) + '" contenteditable="false">' + escapeHtml(g.entry.name) + '</span>';
    document.execCommand("insertHTML", false, html);

    var afterSel = window.getSelection();
    if (afterSel.rangeCount) {
      var landed = afterSel.getRangeAt(0).startContainer;
      var tagEl = (landed.nodeType === 3 ? landed.parentNode : landed).closest(".tag-anchor");
      if (tagEl) {
        var out = document.createRange();
        out.setStartAfter(tagEl);
        out.collapse(true);
        afterSel.removeAllRanges();
        afterSel.addRange(out);
      }
    }

    hideTagGhost();
    registerProductionTag(g.entry.cat.id, g.entry.name);
    syncFieldFromDom(g.cellEl);
    updateTagBadges();
    renderProduction();
    return true;
  }

  /* ---- untagged mentions ----

     The tag ghost above catches what you are typing *now*. This catches what
     you already wrote: a breakdown item mentioned in a visual cell as plain
     text, never labelled. Nothing counts those, so the item's "N mentions"
     and its scene list are both quietly short — and the Shoot view, which is
     built from exactly that, is missing a scene it should have listed.

     The visual column only, deliberately: that column is what is physically
     in front of the camera, which is what the breakdown is a list of. */

  var UNTAGGED_HL = "splitpage-untagged";
  var untaggedList = [];          /* [{ cellEl, range, entry, text }] in document order */
  var untaggedSuggestion = null;  /* the one the prompt is currently offering */
  var untaggedScanTimer = null;
  var untaggedMutedFor = null;    /* a cell Escape dismissed the prompt in */

  function highlightApiOk() {
    return !!(window.CSS && CSS.highlights && window.Highlight);
  }

  /* One alternation regex for the whole registry, longest name first so
     "gaffer tape" wins over a "tape" entry sitting inside it. Rebuilt per
     scan, which is cheap; scanning each cell once per registry entry
     instead would be fifty passes over the document on a fifty-item
     breakdown. */
  function buildUntaggedIndex(entries) {
    /* Object.create(null), not {}: these keys are tag names straight out of
       the document, and an item called "constructor" or "__proto__" would
       otherwise come back as an inherited function and be handed to
       tagCompletionBeats as if it were an entry. */
    var names = [], byName = Object.create(null);
    entries.forEach(function (e) {
      var n = (e.name || "").trim();
      if (!n) return;
      var k = n.toLowerCase();
      /* The same words can be tracked in two categories at once — a
         "kitchen" prop and a "kitchen" location are different things, and
         registryKey() keeps them apart on purpose. Plain text cannot say
         which one it meant, so fall back to the tiebreak the Tab-completion
         ghost already uses for the same ambiguity: whichever is mentioned
         most in the script so far. The prompt names the category either way,
         so accepting it is never a surprise. */
      if (byName[k]) {
        if (tagCompletionBeats(e, byName[k])) byName[k] = e;
        return;
      }
      names.push(n);
      byName[k] = e;
    });
    if (!names.length) return null;
    var alt = names.sort(function (a, b) { return b.length - a.length; })
      .map(function (n) { return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); })
      .join("|");

    /* Word boundaries belong INSIDE the pattern, not in a test afterwards.
       Two bugs came from having them outside:

       Rejecting a match after the fact cannot un-consume it. With the names
       sorted longest-first, "gaffer tape" wins the alternation in "the
       gaffer tapes the cable", fails the trailing-boundary test, and the
       scan resumes past it — so the "gaffer" entry sitting inside what was
       just rejected is never seen at all. Lookarounds make the engine
       backtrack to the shorter alternative at the same position instead.

       And \p{L}\p{N} rather than A-Za-z0-9: with the ASCII class, a cast
       entry "Ana" matched inside "Anaïs", because the accented character
       does not look like a letter to [A-Za-z0-9]. Tab then wrapped half of
       somebody's name in an atomic tag.

       Lookbehind and \p{...} need a modern engine. If this throws, fall
       back to the plain pattern and let collectUntaggedInCell() do the old
       after-the-fact test — fewer matches found, none of them wrong. */
    try {
      return {
        re: new RegExp("(?<![\\p{L}\\p{N}])(" + alt + ")(?![\\p{L}\\p{N}])", "giu"),
        byName: byName,
        boundedInPattern: true
      };
    } catch (e) {
      return { re: new RegExp("(" + alt + ")", "gi"), byName: byName, boundedInPattern: false };
    }
  }

  /* Text a mention is allowed to be found in — the same exclusion the search
     and the tagger use, so a phrase already inside a tag or a link is never
     offered as if it were loose. */
  function eachPlainTextNode(root, fn) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return isInsideTagOrLink(node.parentNode)
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) fn(node);
  }

  function collectUntaggedInCell(cellEl, index, out) {
    eachPlainTextNode(cellEl, function (node) {
      var text = node.nodeValue || "";
      if (!text) return;
      index.re.lastIndex = 0;
      var m;
      while ((m = index.re.exec(text))) {
        var start = m.index, len = m[0].length;
        /* Only when the pattern could not carry its own boundaries (see
           buildUntaggedIndex): whole words, so "tape" never matches inside
           "tapered". Skipped otherwise, or the ASCII class here would undo
           the unicode boundaries the pattern just applied. */
        if (!index.boundedInPattern) {
          var before = start === 0 ? "" : text.charAt(start - 1);
          var after = text.charAt(start + len);
          if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
        }
        var entry = index.byName[m[0].toLowerCase()];
        if (!entry) continue;
        var range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + len);
        out.push({ cellEl: cellEl, range: range, entry: entry, text: m[0] });
      }
    });
  }

  function paintUntagged() {
    if (!highlightApiOk()) return;
    try {
      if (!untaggedList.length) { CSS.highlights.delete(UNTAGGED_HL); return; }
      var hl = new Highlight();
      untaggedList.forEach(function (item) { hl.add(item.range); });
      CSS.highlights.set(UNTAGGED_HL, hl);
    } catch (e) { /* a partial implementation — go without the underline */ }
  }

  function scanUntaggedMentions(entries) {
    if (!state) return;
    untaggedList = [];
    /* the writer covers the split view, and #rows behind it is stale until it
       closes — scanning it would paint ranges nobody can see */
    var index = writerOpen ? null : buildUntaggedIndex(entries || productionEntries());
    if (index) {
      var cells = document.querySelectorAll('#rows .visual-cell .cell-editable');
      Array.prototype.forEach.call(cells, function (cellEl) {
        collectUntaggedInCell(cellEl, index, untaggedList);
      });
    }
    paintUntagged();
    updateUntaggedPrompt();
  }

  /* Same reasoning as scheduleProductionRefresh(): re-reading every visual
     cell is fine once and wasteful once per keystroke. */
  function scheduleUntaggedScan() {
    if (untaggedScanTimer) return;
    untaggedScanTimer = setTimeout(function () {
      untaggedScanTimer = null;
      scanUntaggedMentions();
    }, 220);
  }

  function hideUntaggedPrompt() {
    untaggedSuggestion = null;
    var el = document.getElementById("tag-suggest");
    if (el) el.classList.remove("is-visible");
  }

  function updateUntaggedPrompt() {
    var el = document.getElementById("tag-suggest");
    if (!el) return;
    var active = document.activeElement;
    var cellEl = (active && active.classList && active.classList.contains("cell-editable") &&
      active.getAttribute("data-field") === "visualText" && active.closest("#rows")) ? active : null;
    if (!cellEl || untaggedMutedFor === cellEl) { hideUntaggedPrompt(); return; }

    var here = untaggedList.filter(function (i) { return i.cellEl === cellEl; });
    if (!here.length) { hideUntaggedPrompt(); return; }

    /* Offer the last one starting at or before the caret — that is the one
       just typed. Only when the caret is past all of them does it fall back
       to the first, so arriving in an old cell still shows something. */
    var pick = here[0];
    var sel = window.getSelection();
    if (sel.rangeCount && sel.isCollapsed) {
      var caret = sel.getRangeAt(0);
      for (var i = 0; i < here.length; i++) {
        try {
          if (here[i].range.compareBoundaryPoints(Range.START_TO_START, caret) <= 0) pick = here[i];
        } catch (e) { /* ranges in different trees — leave the default */ }
      }
    }

    var rect = pick.range.getClientRects()[0] || pick.range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { hideUntaggedPrompt(); return; }

    el.innerHTML = 'Tag <b>' + escapeHtml(pick.text) + '</b>' +
      '<span class="tag-suggest-cat">' + escapeHtml(pick.entry.cat.label) + '</span>' +
      '<kbd>Tab</kbd>';
    el.classList.add("is-visible");
    /* measured only once it is displayed, or the width is zero */
    var w = el.offsetWidth, h = el.offsetHeight;
    /* Below the whole CELL, not below the matched line. It is an opaque,
       clickable button: six pixels under a phrase in the middle of a
       paragraph put it squarely on top of the next line of the very text it
       is annotating, hiding the words and swallowing clicks meant for them.
       Horizontally it still lines up with the phrase, so it is obvious what
       it is pointing at. */
    var cellRect = cellEl.getBoundingClientRect();
    var top = cellRect.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, cellRect.top - h - 6);
    el.style.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - w - 8)) + "px";
    el.style.top = top + "px";
    untaggedSuggestion = pick;
  }

  /* Returns true if a suggestion was live and got taken, so the caller can
     preventDefault the Tab that triggered it. */
  function acceptUntaggedMention() {
    var s = untaggedSuggestion;
    if (!s || !s.cellEl.isConnected) { hideUntaggedPrompt(); return false; }
    /* A Range is live: type a character into the middle of the phrase it
       covers and it quietly grows to include it. The rescan that would
       notice is 220ms behind, so between those two moments Tab would wrap
       "gaffX er tape" and label it "gaffer tape". Cheaper to ask the range
       what it is holding now than to try to invalidate it from every edit. */
    if (String(s.range) !== s.text) {
      hideUntaggedPrompt();
      scheduleUntaggedScan();
      return false;
    }
    var sel = window.getSelection();
    try {
      sel.removeAllRanges();
      sel.addRange(s.range);
    } catch (e) { hideUntaggedPrompt(); return false; }

    /* The text keeps the casing it was written in; the registry keeps its
       own. Same split tagFieldOccurrences makes, and it is what stops
       labelling "Gaffer Tape" from forking a second breakdown item.
       execCommand, like every other route to a tag in this file, so one
       Ctrl+Z puts the plain words back. */
    var html = '<span class="tag-anchor" data-tag-cat="' + escapeHtml(s.entry.cat.id) +
      '" data-tag-name="' + escapeHtml(s.entry.name) + '" contenteditable="false">' +
      escapeHtml(s.text) + '</span>';
    document.execCommand("insertHTML", false, html);

    var after = window.getSelection();
    if (after.rangeCount) {
      var landed = after.getRangeAt(0).startContainer;
      var tagEl = (landed.nodeType === 3 ? landed.parentNode : landed).closest(".tag-anchor");
      if (tagEl) {
        var out = document.createRange();
        out.setStartAfter(tagEl);
        out.collapse(true);
        after.removeAllRanges();
        after.addRange(out);
      }
    }

    hideUntaggedPrompt();
    registerProductionTag(s.entry.cat.id, s.entry.name);
    syncFieldFromDom(s.cellEl);
    updateTagBadges();
    renderProduction();
    scanUntaggedMentions();
    return true;
  }

  /* Walk the text nodes of one field, wrapping every whole-word occurrence of
     `phrase`. Text already inside a tag or a link is left alone. */
  function tagFieldOccurrences(html, phrase, cat, name, countOnly) {
    var body = inertBody(html);
    var doc = body.ownerDocument;
    var needle = phrase.toLowerCase();
    var hits = 0;

    function walk(node) {
      var kids = Array.prototype.slice.call(node.childNodes);
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        if (child.nodeType === 1) {
          if (!isInsideTagOrLink(child)) walk(child);
          continue;
        }
        if (child.nodeType !== 3) continue;
        if (isInsideTagOrLink(child.parentNode)) continue;

        var text = child.nodeValue || "";
        var hay = text.toLowerCase();
        var frag = doc.createDocumentFragment();
        var cursor = 0, at = hay.indexOf(needle), matched = false;

        while (at !== -1) {
          var before = at === 0 ? "" : text.charAt(at - 1);
          var after = text.charAt(at + phrase.length);
          if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) {
            hits++;
            matched = true;
            if (!countOnly) {
              if (at > cursor) frag.appendChild(doc.createTextNode(text.slice(cursor, at)));
              var span = doc.createElement("span");
              span.className = "tag-anchor";
              span.setAttribute("data-tag-cat", cat);
              span.setAttribute("data-tag-name", name);
              span.appendChild(doc.createTextNode(text.substr(at, phrase.length)));
              frag.appendChild(span);
            }
            cursor = at + phrase.length;
          }
          at = hay.indexOf(needle, at + phrase.length);
        }

        if (matched && !countOnly) {
          if (cursor < text.length) frag.appendChild(doc.createTextNode(text.slice(cursor)));
          child.parentNode.replaceChild(frag, child);
        }
      }
    }
    walk(body);
    return { hits: hits, html: body.innerHTML };
  }

  function tagAllOccurrences(phrase, cat, name) {
    var needle = String(phrase || "").trim();
    if (!needle) return 0;
    var total = 0;
    state.rows.forEach(function (row) {
      ["visualText", "audioText"].forEach(function (field) {
        var res = tagFieldOccurrences(row[field], needle, cat, name, false);
        if (res.hits) {
          total += res.hits;
          row[field] = sanitizeHtml(res.html);
          stampRow(row);
        }
      });
    });
    return total;
  }

  function countPhraseMatches(phrase) {
    var needle = String(phrase || "").trim();
    if (!needle || !state) return 0;
    var total = 0;
    state.rows.forEach(function (row) {
      ["visualText", "audioText"].forEach(function (field) {
        total += tagFieldOccurrences(row[field], needle, "prop", "x", true).hits;
      });
    });
    return total;
  }

  function eachTagSpan(cat, name, fn) {
    var target = normalizeTagName(name);
    var changed = 0;
    state.rows.forEach(function (row) {
      ["visualText", "audioText"].forEach(function (field) {
        var body = inertBody(row[field]);
        var hit = false;
        Array.prototype.forEach.call(body.querySelectorAll(".tag-anchor"), function (el) {
          if (el.getAttribute("data-tag-cat") !== cat) return;
          if (normalizeTagName(el.getAttribute("data-tag-name")) !== target) return;
          fn(el);
          hit = true;
          changed++;
        });
        if (hit) {
          row[field] = sanitizeHtml(body.innerHTML);
          stampRow(row);
        }
      });
    });
    return changed;
  }

  function renameTag(cat, oldName, newName) {
    var clean = plainText(newName).trim().slice(0, 80);
    if (!clean) return false;
    /* an orphaned item has no live spans to rename, but its registry entry
       still needs the new name so it doesn't fall right back to the old
       one the next time productionEntries() reads it */
    var spanCount = eachTagSpan(cat, oldName, function (el) {
      el.setAttribute("data-tag-name", clean);
    });
    var entry = registryEntry(cat, oldName);
    if (entry) entry.name = clean;
    return spanCount > 0 || !!entry;
  }

  function removeTag(cat, name) {
    return eachTagSpan(cat, name, function (el) {
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.parentNode.removeChild(el);
    });
  }

  /* ---- the tag composer ---- */

  var pendingTag = null;
  var tagRenaming = null;
  var tagDeleteArmId = null;
  var tagDeleteArmTimer = null;
  var productionGroupBy = "cat";   /* "cat" | "person" | "scene" */
  var tagExpanded = null;          /* key of the one card showing its details */
  var tagAddingPersonFor = null;   /* key of the card with the "new person" field open */

  /* ---- selecting several items at once ----

     Ctrl+click (Cmd on a Mac, where Ctrl+click is the context menu) toggles a
     card in and out of the selection; Shift+click takes the run between the
     last one touched and this one. There is no checkbox and no "select mode"
     button — a modifier is what this gesture is everywhere else, and an
     always-on checkbox column would cost every card space to serve the rare
     occasion you are doing bulk work.

     A plain click still just opens the card and deliberately does NOT clear
     the selection. Standard file-manager behaviour would, but the cost of
     being wrong is lopsided: one stray click throwing away a dozen careful
     Ctrl+clicks is far worse than a selection sitting there a moment longer
     than needed — and it is never invisible, since selected cards are tinted
     and the action bar states the count. Escape and the bar's × clear it. */
  var productionSelection = {};    /* key -> true */
  var selectionAnchorKey = null;   /* where a Shift+click range starts from */
  var bulkDeleteArmed = false;

  function selectedKeys() { return Object.keys(productionSelection); }

  function clearProductionSelection() {
    productionSelection = {};
    selectionAnchorKey = null;
    bulkDeleteArmed = false;
  }

  /* Keys can vanish under us — an item gets renamed, deleted, or the script
     changes so it is no longer tracked. Drop anything that no longer exists
     rather than letting a bulk action fire at a ghost. */
  function pruneProductionSelection(entries) {
    var live = {};
    entries.forEach(function (e) { live[e.key] = true; });
    var dropped = false;
    selectedKeys().forEach(function (k) {
      if (!live[k]) { delete productionSelection[k]; dropped = true; }
    });
    if (dropped) bulkDeleteArmed = false;
    if (selectionAnchorKey && !live[selectionAnchorKey]) selectionAnchorKey = null;
  }

  /* Everything the panel remembers about *which* item you were working on.
     Cleared whenever the document underneath is replaced. */
  function resetProductionPanelState() {
    tagRenaming = null;
    tagExpanded = null;
    tagAddingPersonFor = null;
    productionGroupBy = "cat";
    clearTimeout(tagDeleteArmTimer);
    tagDeleteArmId = null;
    clearProductionSelection();
  }

  function renderTagCategories(selected) {
    document.getElementById("tag-cats").innerHTML = TAG_CATEGORIES.map(function (c) {
      return '<button type="button" class="tag-cat-btn' + (c.id === selected ? ' is-active' : '') +
        '" style="--dot:' + c.color + '" data-tag-cat="' + c.id + '" role="radio" aria-checked="' +
        (c.id === selected ? 'true' : 'false') + '">' +
        '<span class="tag-cat-dot"></span>' + escapeHtml(c.label) + '</button>';
    }).join("");
  }

  function refreshTagNameList() {
    var names = {};
    productionEntries().forEach(function (t) { names[t.name] = true; });
    document.getElementById("tag-name-list").innerHTML =
      Object.keys(names).sort().map(function (n) {
        return '<option value="' + escapeHtml(n) + '"></option>';
      }).join("");
  }

  function updateTagHint() {
    var hint = document.getElementById("tag-hint");
    if (!pendingTag) { hint.textContent = ""; return; }
    var n = countPhraseMatches(pendingTag.quotedText);
    var box = document.getElementById("tag-all");
    if (n > 1) {
      box.disabled = false;
      hint.textContent = '"' + pendingTag.quotedText + '" appears ' + n + " times in the script.";
    } else {
      box.disabled = true;
      box.checked = false;
      hint.textContent = "";
    }
  }

  function openTagComposer(ctx) {
    pendingTag = ctx;
    document.getElementById("tag-quote").textContent = ctx.quotedText;
    var nameInput = document.getElementById("tag-name");
    nameInput.value = ctx.quotedText.slice(0, 80);
    renderTagCategories(ctx.cat || "prop");
    refreshTagNameList();
    document.getElementById("tag-all").checked = false;
    updateTagHint();
    document.getElementById("tag-modal").hidden = false;
    setTimeout(function () { nameInput.focus(); nameInput.select(); }, 0);
  }

  function closeTagComposer() {
    document.getElementById("tag-modal").hidden = true;
    pendingTag = null;
  }

  function selectedTagCategory() {
    var active = document.querySelector("#tag-cats .tag-cat-btn.is-active");
    return active ? active.getAttribute("data-tag-cat") : "prop";
  }

  function applyTag() {
    if (!pendingTag) return;
    var cat = selectedTagCategory();
    var name = plainText(document.getElementById("tag-name").value).trim().slice(0, 80);
    if (!name) { showToast("Give the label a name first.", "warn"); return; }

    var all = document.getElementById("tag-all").checked;
    var phrase = pendingTag.quotedText;
    var ctx = pendingTag;
    closeTagComposer();

    if (all) {
      var n = tagAllOccurrences(phrase, cat, name);
      registerProductionTag(cat, name);
      markDirty();
      render();
      queueAutoSave();
      showToast("Labelled " + n + " mention" + (n === 1 ? "" : "s") + " of " + name, "ok");
      return;
    }

    /* single mention: re-select the range we captured and wrap it */
    var cellEl = document.querySelector('#rows .row[data-id="' + safeId(ctx.rowId, "r") +
      '"] .' + (ctx.field === "visualText" ? "visual" : "audio") + '-cell .cell-editable');
    if (!cellEl) { showToast("That row is no longer here.", "warn"); return; }

    var res = tagFieldOccurrences(cellEl.innerHTML, phrase, cat, name, false);
    if (!res.hits) { showToast("Could not find that text any more.", "warn"); return; }
    /* only the first occurrence in this cell was intended */
    var body = inertBody(res.html);
    var spans = body.querySelectorAll('.tag-anchor[data-tag-name="' + cssAttr(name) + '"]');
    if (spans.length > 1) {
      for (var i = 1; i < spans.length; i++) {
        var el = spans[i];
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.parentNode.removeChild(el);
      }
    }
    var idx = findRowIndex(ctx.rowId);
    if (idx === -1) return;
    state.rows[idx][ctx.field] = sanitizeHtml(body.innerHTML);
    stampRow(state.rows[idx]);
    registerProductionTag(cat, name);
    markDirty();
    render();
    queueAutoSave();
    showToast("Labelled as " + name, "ok");
  }
