  /* ================= the b-roll list =================

     A separate system from production tags, deliberately. A tag wraps words
     inside a sentence and is identified BY those words, so two mentions of
     "gaffer tape" are one item. B-roll is the opposite on both counts: it
     owns a whole block rather than a phrase, and two identical shots really
     are two shots to go and get. Sharing TAG_CATEGORIES would have meant
     bending both of those rules, plus running a second status vocabulary
     through a breakdown sheet whose Status column has to mean one thing.

     What the script holds is only the marker — a "B-roll:" starting a line
     in a visual cell. Everything a shooter needs that the script can't
     carry (shot or not, a reshoot note, who's getting it, the line of audio
     it cuts against, where it is) lives on a record in state.brollShots,
     tied to the marker by an id the marker carries. */

  var BROLL_STATUSES = [
    { id: "unshot", label: "Not shot", color: "var(--text-dim)" },
    /* The same word scenes already use for their own status, on purpose: a
       scene being Shot and a B-roll item being Shot are differently sized
       claims, but "shot" is the word anyone on a set actually says. */
    { id: "shot",   label: "Shot",     color: "var(--ok)" }
  ];

  function brollStatus(id) {
    for (var i = 0; i < BROLL_STATUSES.length; i++) {
      if (BROLL_STATUSES[i].id === id) return BROLL_STATUSES[i];
    }
    return null;
  }

  /* Every spelling anybody actually types, closed by a colon, hyphen, en or
     em dash. Anchored: a marker has to START its line, so "cut to B-roll:
     the bin" mid-sentence is prose and stays prose. */
  var BROLL_MARKER_RE = /^[ \t]*(b[ \t]?-?[ \t]?roll)[ \t]*([:—–-])[ \t]*/i;
  var BROLL_CLOSERS = ":—–-";

  var BROLL_NAME_MAX = 200;
  var BROLL_TEXT_MAX = 2000;

  /* ---- reading the markers back out of the script ----

     A sanitized field is a flat run of inline nodes separated by <br>, so a
     "line" is what sits between two of them. A marker line opens an item;
     every line after it belongs to that item until the next marker or the
     end of the cell. The first line is the item's name — what the list and
     the printed sheet show — and the rest is its description. */
  function brollFieldLines(body) {
    hoistNestedBrs(body);
    var kids = Array.prototype.slice.call(body.childNodes);
    var lines = [], start = 0;
    kids.forEach(function (n, i) {
      if (n.nodeType === 1 && n.tagName === "BR") {
        lines.push({ nodes: kids.slice(start, i), br: n });
        start = i + 1;
      }
    });
    lines.push({ nodes: kids.slice(start), br: null });
    return lines;
  }

  /* "Flat run of inline nodes separated by <br>" is a claim about the
     FIELD, not about execCommand: a real Enter pressed while the caret is
     still inside a run of bold (or italic, underline…) leaves the browser's
     own <br> a CHILD of that formatting element, not of the field — brollAtLineStart()
     rightly treats that as a line start (see its own comment), but this
     function only ever looked at the field's own direct children, so a
     marker on that second line was invisible to it: not merely markerless,
     gone, as if the line never existed. Splitting the formatting element in
     two around the <br> — the same shape a plain Enter with no formatting
     active already produces — restores the invariant instead of asking
     every caller to know about the exception. Runs on the disposable body
     inertBody() just parsed, so mutating it in place costs nothing and
     touches nothing live. */
  function hoistNestedBrs(body) {
    var guard = 0;
    while (guard++ < 1000) {
      var brs = body.getElementsByTagName("br");
      var br = null;
      for (var i = 0; i < brs.length; i++) {
        if (brs[i].parentNode !== body) { br = brs[i]; break; }
      }
      if (!br) return;
      var parent = br.parentNode;
      var grand = parent.parentNode;
      if (!grand) return;
      var tail = parent.cloneNode(false); // same tag AND attributes, no children
      while (br.nextSibling) tail.appendChild(br.nextSibling);
      parent.removeChild(br);
      var ref = parent.nextSibling;
      grand.insertBefore(br, ref);
      if (tail.childNodes.length) grand.insertBefore(tail, ref);
    }
  }

  function brollLineText(nodes) {
    return nodes.map(function (n) { return n.textContent || ""; }).join("");
  }

  /* Is this line a marker, and if so what opens it? Returns the key span
     when the marker has already been wrapped (and therefore carries an id),
     or a plain text match when it hasn't — a line written before this
     existed, pasted in, or round-tripped through Markdown, which drops the
     span and leaves the words behind. Those still count: they are matched
     back to their record by name until an edit gives them an id. */
  function brollLineMarker(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType === 3 && !(n.nodeValue || "").trim()) continue;
      if (n.nodeType === 1 && n.classList && n.classList.contains("broll-key")) {
        return { id: n.getAttribute("data-broll-id") || "", el: n, rest: nodes.slice(i + 1) };
      }
      break;
    }
    var m = BROLL_MARKER_RE.exec(brollLineText(nodes));
    return m ? { id: "", el: null, rest: null, strip: m[0].length } : null;
  }

  /* SHARED with every other caller for the same field content — read it,
     never mutate it. Same contract, and the same reason, as tagsInField. */
  var brollInField = contentMemo(function (html) {
    var out = [], open = null;
    brollFieldLines(inertBody(html)).forEach(function (line) {
      var marker = brollLineMarker(line.nodes);
      if (marker) {
        var name = marker.rest
          ? brollLineText(marker.rest)
          : brollLineText(line.nodes).slice(marker.strip);
        open = { id: marker.id, name: name.trim().slice(0, BROLL_NAME_MAX), desc: [] };
        out.push(open);
        return;
      }
      if (open) open.desc.push(brollLineText(line.nodes));
    });
    out.forEach(function (item) {
      item.desc = item.desc.join("\n").replace(/\s+$/, "").slice(0, BROLL_TEXT_MAX);
    });
    return out;
  });

  /* Visual cells only — the audio column is what gets read aloud, and a
     shot list has no business in it. */
  function collectBrollFromRows(rows) {
    var out = [];
    (rows || []).forEach(function (row, rowIndex) {
      brollInField(row.visualText).forEach(function (found, ordinal) {
        out.push({
          id: found.id, name: found.name, desc: found.desc,
          rowId: row.id, rowIndex: rowIndex, ordinal: ordinal
        });
      });
    });
    return out;
  }

  function brollRow(rowId) {
    var i = rowId ? findRowIndex(rowId) : -1;
    return i === -1 ? null : state.rows[i];
  }

  /* ---- what a new item inherits from the scene it was written in ----

     Both of these are seeded ONCE, here, and are the item's own from then
     on. Rewriting the scene's audio later doesn't reach back into a
     reference somebody has since corrected, and a shot that gets moved to
     another location doesn't snap back to the scene's tag every time the
     list re-reads the script. The cost is that a seeded reference can go
     stale; that is the trade that makes it editable at all. */
  function brollSeedRef(row) {
    return row ? htmlToPlainText(row.audioText).trim().slice(0, BROLL_TEXT_MAX) : "";
  }

  function brollSeedLocation(row) {
    if (!row) return "";
    var found = "";
    ["visualText", "audioText"].forEach(function (field) {
      tagsInField(row[field]).forEach(function (t) {
        if (!found && t.catId === "location") found = t.name;
      });
    });
    return found.slice(0, 80);
  }

  /* ---- the registry ---- */

  function brollRecord(id) {
    if (!id) return null;
    for (var i = 0; i < state.brollShots.length; i++) {
      if (state.brollShots[i].id === id) return state.brollShots[i];
    }
    return null;
  }

  function newBrollRecord(fields) {
    var rec = {
      id: makeId("bs"),
      name: "", desc: "",
      status: BROLL_STATUSES[0].id,
      reshoot: false,
      notes: "",
      owner: "",
      audioRef: "",
      location: "",
      /* A "script" item can go orphaned when its line is deleted — that is
         a surprise worth flagging. One typed straight into the list never
         had a line to lose, so it just sits there as itself. */
      origin: "script"
    };
    Object.keys(fields || {}).forEach(function (k) { rec[k] = fields[k]; });
    state.brollShots.push(rec);
    return rec;
  }

  function deleteBrollRecord(id) {
    var before = state.brollShots.length;
    state.brollShots = state.brollShots.filter(function (r) { return r.id !== id; });
    return before !== state.brollShots.length;
  }

  /* Every tracked shot, reconciled against what the script says right now.

     Matching is by id first — that is what makes renaming a marker keep its
     status and notes, and what keeps two identical lines two items. A
     marker with no id (see brollLineMarker) falls back to matching an
     unclaimed record by name, so a Markdown round-trip recovers the item
     rather than orphaning it and minting a duplicate beside it. */
  function brollEntries() {
    var live = collectBrollFromRows(state.rows);
    var claimed = Object.create(null);
    var byId = Object.create(null);
    state.brollShots.forEach(function (r) { byId[r.id] = r; });
    var out = [];

    live.forEach(function (found) {
      var rec = found.id ? byId[found.id] : null;
      if (rec && claimed[rec.id]) rec = null;
      if (!rec) {
        var norm = normalizeTagName(found.name);
        for (var i = 0; i < state.brollShots.length && norm; i++) {
          var cand = state.brollShots[i];
          if (claimed[cand.id]) continue;
          if (normalizeTagName(cand.name) !== norm) continue;
          rec = cand;
          break;
        }
      }
      if (!rec) {
        var row = brollRow(found.rowId);
        rec = newBrollRecord({
          id: found.id || makeId("bs"),
          name: found.name,
          desc: found.desc,
          audioRef: brollSeedRef(row),
          location: brollSeedLocation(row)
        });
      }
      claimed[rec.id] = true;
      /* While a marker is live the script owns the words; the record keeps
         its own copy only so the item still reads like something once the
         line is gone. */
      rec.name = found.name;
      rec.desc = found.desc;
      out.push(brollEntryFrom(rec, found));
    });

    state.brollShots.forEach(function (rec) {
      if (!claimed[rec.id]) out.push(brollEntryFrom(rec, null));
    });

    return out;
  }

  function brollEntryFrom(rec, found) {
    return {
      rec: rec,
      id: rec.id,
      name: found ? found.name : rec.name,
      desc: found ? found.desc : (rec.desc || ""),
      rowId: found ? found.rowId : null,
      rowIndex: found ? found.rowIndex : -1,
      ordinal: found ? found.ordinal : -1,
      markerless: !!found && !found.id,
      orphaned: !found && rec.origin === "script",
      status: brollStatus(rec.status) ? rec.status : BROLL_STATUSES[0].id,
      reshoot: !!rec.reshoot,
      notes: rec.notes || "",
      owner: rec.owner || "",
      audioRef: rec.audioRef || "",
      location: rec.location || "",
      origin: rec.origin
    };
  }

  function brollUnshotCount() {
    if (!state || !state.brollShots) return 0;
    return brollEntries().filter(function (e) { return e.status !== "shot"; }).length;
  }

  /* ---- capturing a marker as it is typed ----

     Same shape as maybeAutoTagShortcut: only ever fires on live typing of
     the closing character, and goes in through execCommand so one Ctrl+Z
     takes the marker back off and leaves the words "B-roll:" behind — the
     escape hatch for anyone who meant to write that literally. */
  function brollAtLineStart(node) {
    /* A text node that begins the field, or that follows a <br>, IS the
       start of a line — bold, italic, underline and the rest are styling,
       not position, so a line can start INSIDE one of those same as in
       plain text. What is mid-line by definition is text after a tag or
       inside a link: isInsideTagOrLink() is the guard for that, checked
       separately by the caller, so this only has to walk up through plain
       inline formatting to find out whether anything with content sits
       before the caret. */
    if (node.nodeType !== 3) return false;
    var cell = node.parentNode && node.parentNode.closest
      ? node.parentNode.closest(".cell-editable") : null;
    if (!cell) return false;

    var n = node;
    while (true) {
      var prev = n.previousSibling;
      while (prev && prev.nodeType === 3 && !(prev.nodeValue || "").trim()) prev = prev.previousSibling;
      if (prev) return prev.nodeType === 1 && prev.tagName === "BR";
      var parent = n.parentNode;
      if (parent === cell) return true;
      if (!parent || parent.nodeType !== 1) return false;
      n = parent;
    }
  }

  function maybeCaptureBroll(e, cellEl) {
    if (e.inputType !== "insertText" || !e.data) return;
    if (cellEl.getAttribute("data-field") !== "visualText") return;
    if (BROLL_CLOSERS.indexOf(e.data.charAt(e.data.length - 1)) === -1) return;
    var sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var offset = range.startOffset;
    if (!brollAtLineStart(node)) return;
    if (isInsideTagOrLink(node.parentNode)) return;
    var head = node.data.slice(0, offset);
    var m = BROLL_MARKER_RE.exec(head);
    /* Everything typed on the line so far has to BE the marker; if there
       were words in front of it, this is prose that happens to end in a
       colon. */
    if (!m || m[0].length !== head.length) return;

    var wrapRange = document.createRange();
    wrapRange.setStart(node, 0);
    wrapRange.setEnd(node, offset);
    sel.removeAllRanges();
    sel.addRange(wrapRange);
    document.execCommand("insertHTML", false, brollKeyHtml(makeId("bs"), m[1] + m[2]) + " ");

    /* Land the caret explicitly after the marker. The browser leaves it
       INSIDE the span it just inserted, and the span is contenteditable
       ="false" — so without this every character of the shot's description
       is typed into something that refuses to take it, and silently goes
       nowhere. The tag shortcut does the same thing for the same reason. */
    var afterSel = window.getSelection();
    if (afterSel.rangeCount) {
      var landed = afterSel.getRangeAt(0).startContainer;
      var keyEl = (landed.nodeType === 3 ? landed.parentNode : landed).closest(".broll-key");
      if (keyEl) {
        var out = document.createRange();
        out.setStartAfter(keyEl);
        out.collapse(true);
        afterSel.removeAllRanges();
        afterSel.addRange(out);
      }
    }

    syncFieldFromDom(cellEl);
    scheduleBrollRefresh();
  }

  /* contenteditable="false" for the same reason a tag is atomic: the caret
     can never land inside the marker and grow or shrink it into no longer
     being one, whichever way it is approached. */
  function brollKeyHtml(id, text) {
    return '<span class="broll-key" data-broll-id="' + escapeHtml(id) +
      '" contenteditable="false">' + escapeHtml(text) + '</span>';
  }

  /* ---- writing an edit back into the script ----

     The list is not a second document. Renaming a shot there rewrites its
     marker line, so there is one set of words and they live where they were
     written. An item whose marker never carried an id gets one here, which
     is also how a pasted or round-tripped line rejoins its record for good. */
  function renameBrollInScript(entry, newName) {
    var row = brollRow(entry.rowId);
    if (!row) return false;
    var body = inertBody(row.visualText);
    var lines = brollFieldLines(body);
    var ordinal = -1, target = null;
    for (var i = 0; i < lines.length && !target; i++) {
      if (!brollLineMarker(lines[i].nodes)) continue;
      ordinal++;
      if (ordinal === entry.ordinal) target = lines[i];
    }
    if (!target) return false;

    var marker = brollLineMarker(target.nodes);
    var keyText = marker.el ? (marker.el.textContent || "B-roll:") : "B-roll:";
    var holder = document.createElement("div");
    holder.innerHTML = brollKeyHtml(entry.id, keyText) + " " + escapeHtml(newName);

    /* Replace the whole line in place: everything between the previous <br>
       and this line's own <br> goes, the rebuilt marker takes its position. */
    var anchor = target.br;
    target.nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
      body.insertBefore(n, anchor);
    });

    row.visualText = sanitizeHtml(body.innerHTML);
    return true;
  }

  /* ---- the panel ---- */

  var brollGroupBy = "flat";      /* "flat" | "scene" | "location" */
  var brollExpanded = null;       /* id of the open card */
  var brollRenaming = null;
  var brollAddingPersonFor = null;
  var brollRefreshTimer = null;

  function openBrollPanel() {
    if (!state) return;
    openSidePanel("broll-panel");
    renderBroll();
  }

  function closeBrollPanel() {
    var p = document.getElementById("broll-panel");
    if (p) p.hidden = true;
    syncPanelClass();
  }

  function updateBrollBadge() {
    var badge = document.getElementById("broll-badge");
    if (!badge || !state) return;
    var n = brollUnshotCount();
    if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
    else badge.hidden = true;
  }

  /* Reading the markers back means parsing every visual field in the script:
     cheap once, wasteful on every keystroke. Same coalescing the production
     panel uses, and for the same reason. */
  function scheduleBrollRefresh() {
    if (brollRefreshTimer) clearTimeout(brollRefreshTimer);
    brollRefreshTimer = setTimeout(function () {
      brollRefreshTimer = null;
      updateBrollBadge();
      renderBroll();
    }, 400);
  }

  function brollStatusPillHtml(entry) {
    var st = brollStatus(entry.status) || BROLL_STATUSES[0];
    return '<button type="button" class="tag-status-pill" data-action="broll-status-toggle" ' +
      'data-id="' + escapeHtml(entry.id) + '" style="--st:' + st.color + '" title="' +
      escapeHtml(st.label + " — click to mark " + (entry.status === "shot" ? "not shot" : "shot")) +
      '">' + escapeHtml(st.label) + '</button>';
  }

  function brollCardHtml(entry) {
    var id = escapeHtml(entry.id);
    var renaming = brollRenaming === entry.id;
    var expanded = brollExpanded === entry.id || renaming;
    var owner = personById(entry.owner);
    var meta = (entry.location ? '<span class="broll-loc-chip">' + escapeHtml(entry.location) + '</span>' : '') +
      (owner ? '<span class="tag-owner-chip">' + escapeHtml(owner.name) + '</span>' : '') +
      (entry.notes ? '<span class="tag-note-flag" title="Has notes">Notes</span>' : '');

    return '<div class="tag-entity broll-entity' +
        (entry.orphaned ? ' is-orphaned' : '') +
        (expanded ? ' is-expanded' : '') +
        (entry.reshoot ? ' is-reshoot' : '') +
        '" data-id="' + id + '">' +
      '<div class="tag-entity-head" data-action="broll-expand" data-id="' + id + '">' +
        '<span class="tag-entity-name">' + escapeHtml(entry.name || "Untitled shot") + '</span>' +
        '<span class="tag-entity-head-right">' +
          brollStatusPillHtml(entry) +
          (entry.orphaned ? '<span class="tag-orphan-badge">Not in script</span>' : '') +
        '</span>' +
      '</div>' +
      (entry.reshoot ? '<div class="broll-flagline"><span class="broll-flag-mark">Needs attention</span>' +
        (entry.notes ? '<span>' + escapeHtml(entry.notes) + '</span>' : '') + '</div>' : '') +
      (meta ? '<div class="tag-entity-meta">' + meta + '</div>' : '') +
      (renaming
        ? '<input type="text" class="broll-rename-input" value="' + escapeHtml(entry.name) +
            '" data-id="' + id + '" maxlength="200">'
        : entry.orphaned
          ? '<div class="tag-orphan-note">The line this came from is no longer in the script.</div>'
          : entry.rowId
            ? '<div class="tag-scenes"><button type="button" class="tag-scene" ' +
                'data-action="broll-jump" data-id="' + id + '">Scene ' +
                (entry.rowIndex + 1) + '</button></div>'
            : '') +
      (entry.desc ? '<div class="broll-desc">' + escapeHtml(entry.desc) + '</div>' : '') +
      (entry.audioRef
        ? '<div class="broll-ref">' + escapeHtml(entry.audioRef) + '</div>'
        : '<div class="broll-ref is-empty">No audio reference.</div>') +
      (expanded ? brollDetailHtml(entry, renaming) : '') +
    '</div>';
  }

  function brollDetailHtml(entry, renaming) {
    var id = escapeHtml(entry.id);
    return '<div class="tag-entity-detail">' +
      '<div class="tag-detail-label">Status</div>' +
      '<div class="tag-status-seg">' +
        BROLL_STATUSES.map(function (s) {
          return '<button type="button" data-action="broll-status-set" data-id="' + id +
            '" data-status="' + escapeHtml(s.id) + '" style="--st:' + s.color + '"' +
            (s.id === entry.status ? ' class="is-active" aria-checked="true"' : ' aria-checked="false"') +
            ' role="radio">' + escapeHtml(s.label) + '</button>';
        }).join("") +
      '</div>' +
      /* Its own row, not a third button in that group: this is a flag that
         can sit on either status, and a shot that needs another look is
         still a shot. Lined up with the statuses it would have to reject. */
      '<div class="broll-flag-row">' +
        '<button type="button" class="broll-flag-btn' + (entry.reshoot ? ' is-active' : '') +
          '" data-action="broll-reshoot-toggle" data-id="' + id +
          '" aria-pressed="' + (entry.reshoot ? 'true' : 'false') +
          '" title="Flag this for a reshoot, or anything else that needs looking at">' +
          (entry.reshoot ? '● Needs attention' : 'Needs attention') + '</button>' +
        '<span class="broll-flag-hint">' +
          (entry.reshoot ? 'Say why in the notes below.' : 'A reshoot, or anything else worth a second look.') +
        '</span>' +
      '</div>' +
      '<div class="tag-detail-label">Assigned to</div>' +
      '<div class="tag-owner-row">' +
        '<select class="broll-owner-select" data-id="' + id + '">' +
          '<option value=""' + (entry.owner ? '' : ' selected') + '>Unassigned</option>' +
          state.people.map(function (p) {
            return '<option value="' + escapeHtml(p.id) + '"' +
              (p.id === entry.owner ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
          }).join("") +
        '</select>' +
        '<button type="button" class="tag-person-add" data-action="broll-person-new" data-id="' + id +
          '" title="Add someone to the crew list">+ Person</button>' +
      '</div>' +
      (brollAddingPersonFor === entry.id
        ? '<div class="tag-owner-row">' +
            '<input type="text" class="broll-person-input" data-id="' + id +
              '" placeholder="Their name" maxlength="60">' +
            '<button type="button" data-action="broll-person-save" data-id="' + id + '">Add</button>' +
            '<button type="button" data-action="broll-person-cancel">Cancel</button>' +
          '</div>'
        : '') +
      '<div class="tag-detail-label">Location</div>' +
      '<input type="text" class="broll-location-input" data-id="' + id +
        '" maxlength="80" placeholder="Where it gets shot" value="' + escapeHtml(entry.location) + '">' +
      '<div class="tag-detail-label">Audio reference</div>' +
      '<textarea class="broll-ref-input" data-id="' + id + '" rows="2" ' +
        'placeholder="The line this cuts against — seeded from the scene, yours to edit">' +
        escapeHtml(entry.audioRef) + '</textarea>' +
      '<div class="tag-detail-label">Notes</div>' +
      '<textarea class="broll-notes-input" data-id="' + id + '" rows="3" ' +
        'placeholder="Why it needs attention, a reference link, where the footage lives…">' +
        escapeHtml(entry.notes) + '</textarea>' +
      '<div class="tag-entity-actions">' +
        (renaming
          ? '<button type="button" data-action="broll-rename-save" data-id="' + id + '">Save</button>' +
            '<button type="button" data-action="broll-rename-cancel">Cancel</button>'
          : (entry.rowId
              ? '<button type="button" data-action="broll-rename" data-id="' + id + '">Rename</button>'
              : '') +
            '<button type="button" class="danger" data-action="broll-delete" data-id="' + id +
              '">Delete from list</button>') +
      '</div>' +
    '</div>';
  }

  function brollSortedForList(entries) {
    /* Script order, because that is shooting order as far as the script
       knows. Anything with no line of its own — added here, or orphaned by
       a deleted line — sits at the end rather than at the top, where a
       rowIndex of -1 would otherwise put it. */
    return entries.slice().sort(function (a, b) {
      var an = a.rowIndex === -1, bn = b.rowIndex === -1;
      if (an !== bn) return an ? 1 : -1;
      if (an) return (a.name || "").localeCompare(b.name || "");
      if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex;
      return a.ordinal - b.ordinal;
    });
  }

  function brollGroupsHtml(entries, keyOf, emptyLabel) {
    var groups = {}, order = [];
    brollSortedForList(entries).forEach(function (e) {
      var label = keyOf(e) || emptyLabel;
      if (!groups[label]) { groups[label] = []; order.push(label); }
      groups[label].push(e);
    });
    return order.map(function (label) {
      return '<div class="tag-group-head">' + escapeHtml(label) +
          '<span class="tag-group-count">' + groups[label].length + '</span></div>' +
        groups[label].map(brollCardHtml).join("");
    }).join("");
  }

  function renderBroll() {
    updateBrollBadge();
    var panel = document.getElementById("broll-panel");
    if (!panel || panel.hidden || !state) return;
    var listEl = document.getElementById("broll-list");
    var entries = brollEntries();

    document.querySelectorAll("#broll-modes [data-group]").forEach(function (b) {
      var on = b.getAttribute("data-group") === brollGroupBy;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });

    if (!entries.length) {
      listEl.innerHTML = '<div class="comments-empty">No b-roll yet.<br><br>' +
        'Start a line in the visual column with <code>B-roll:</code> and whatever ' +
        'follows it becomes a shot to track — or add one below.</div>';
      return;
    }

    if (brollGroupBy === "scene") {
      listEl.innerHTML = brollGroupsHtml(entries, function (e) {
        return e.rowIndex === -1 ? "" : "Scene " + (e.rowIndex + 1);
      }, "Not in the script");
      return;
    }
    if (brollGroupBy === "location") {
      listEl.innerHTML = brollGroupsHtml(entries, function (e) { return e.location; }, "No location");
      return;
    }
    listEl.innerHTML = brollSortedForList(entries).map(brollCardHtml).join("");
  }

  function brollEntryById(id) {
    var all = brollEntries();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  /* Every edit in the panel lands on the record, marks the document dirty
     and re-renders — the one exception being a rename, which has to reach
     the script itself first (see renameBrollInScript). */
  function updateBrollRecord(id, fields) {
    var rec = brollRecord(id);
    if (!rec) return null;
    Object.keys(fields).forEach(function (k) { rec[k] = fields[k]; });
    markDirty();
    renderBroll();
    queueAutoSave();
    return rec;
  }

  function addBrollFromPanel() {
    var input = document.getElementById("broll-add-input");
    if (!input) return;
    var name = plainText(input.value).trim().slice(0, BROLL_NAME_MAX);
    if (!name) return;
    /* No line in the script, and no flag for it either: a shot nobody has
       written a scene for yet is an ordinary thing to want on the list. */
    var rec = newBrollRecord({ name: name, origin: "list" });
    input.value = "";
    brollExpanded = rec.id;
    markDirty();
    renderBroll();
    queueAutoSave();
    showToast("Added to the b-roll list.", "ok");
  }

  function jumpToBroll(entry) {
    if (!entry || !entry.rowId) return;
    focusRowField(entry.rowId, "visualText");
  }

  function wireBrollPanel() {
    var panel = document.getElementById("broll-panel");
    if (!panel) return;

    panel.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      var action = btn.getAttribute("data-action");
      var id = btn.getAttribute("data-id");
      var entry = id ? brollEntryById(id) : null;

      if (action === "broll-status-toggle" && entry) {
        e.stopPropagation();
        updateBrollRecord(id, { status: entry.status === "shot" ? "unshot" : "shot" });
      } else if (action === "broll-status-set" && entry) {
        updateBrollRecord(id, { status: brollStatus(btn.getAttribute("data-status")) ? btn.getAttribute("data-status") : "unshot" });
      } else if (action === "broll-reshoot-toggle" && entry) {
        var raising = !entry.reshoot;
        updateBrollRecord(id, { reshoot: raising });
        /* Raising the flag asks why: the note is the useful half of it, and
           the moment you raise it is the only moment you know the answer. */
        if (raising) {
          brollExpanded = id;
          renderBroll();
          var notes = panel.querySelector('.broll-notes-input[data-id="' + cssAttr(id) + '"]');
          if (notes) notes.focus();
        }
      } else if (action === "broll-expand") {
        brollExpanded = brollExpanded === id ? null : id;
        brollRenaming = null;
        renderBroll();
      } else if (action === "broll-jump" && entry) {
        jumpToBroll(entry);
      } else if (action === "broll-rename") {
        brollRenaming = id;
        brollExpanded = id;
        renderBroll();
        var input = panel.querySelector('.broll-rename-input[data-id="' + cssAttr(id) + '"]');
        if (input) { input.focus(); input.select(); }
      } else if (action === "broll-rename-save" && entry) {
        var box = panel.querySelector('.broll-rename-input[data-id="' + cssAttr(id) + '"]');
        var next = box ? plainText(box.value).trim().slice(0, BROLL_NAME_MAX) : "";
        brollRenaming = null;
        if (next && next !== entry.name) {
          if (renameBrollInScript(entry, next)) {
            render();
            markDirty();
            queueAutoSave();
          }
        }
        renderBroll();
      } else if (action === "broll-rename-cancel") {
        brollRenaming = null;
        renderBroll();
      } else if (action === "broll-delete" && entry) {
        /* Deleting here only ever forgets the record. The words stay where
           they were written — taking somebody's line out of their script
           from a side panel is not this button's business. */
        deleteBrollRecord(id);
        if (brollExpanded === id) brollExpanded = null;
        markDirty();
        renderBroll();
        queueAutoSave();
        showToast(entry.rowId
          ? "Removed from the list — the line stays in the script."
          : "Removed from the list.", "ok");
      } else if (action === "broll-person-new") {
        brollAddingPersonFor = id;
        renderBroll();
        var pi = panel.querySelector('.broll-person-input[data-id="' + cssAttr(id) + '"]');
        if (pi) pi.focus();
      } else if (action === "broll-person-save") {
        var nameBox = panel.querySelector('.broll-person-input[data-id="' + cssAttr(id) + '"]');
        var personId = nameBox ? findOrAddPerson(nameBox.value) : "";
        brollAddingPersonFor = null;
        if (personId) updateBrollRecord(id, { owner: personId });
        else renderBroll();
      } else if (action === "broll-person-cancel") {
        brollAddingPersonFor = null;
        renderBroll();
      }
    });

    panel.addEventListener("change", function (e) {
      var sel = e.target.closest(".broll-owner-select");
      if (!sel) return;
      updateBrollRecord(sel.getAttribute("data-id"), { owner: sel.value });
    });

    /* Typed fields commit on the way out rather than per keystroke: a
       re-render on every character would take the caret with it. */
    panel.addEventListener("focusout", function (e) {
      var el = e.target;
      var id = el.getAttribute && el.getAttribute("data-id");
      if (!id) return;
      var rec = brollRecord(id);
      if (!rec) return;
      if (el.classList.contains("broll-notes-input") && rec.notes !== el.value) {
        rec.notes = plainText(el.value).slice(0, BROLL_TEXT_MAX);
        markDirty(); queueAutoSave(); renderBroll();
      } else if (el.classList.contains("broll-ref-input") && rec.audioRef !== el.value) {
        rec.audioRef = plainText(el.value).slice(0, BROLL_TEXT_MAX);
        markDirty(); queueAutoSave(); renderBroll();
      } else if (el.classList.contains("broll-location-input") && rec.location !== el.value) {
        rec.location = plainText(el.value).trim().slice(0, 80);
        markDirty(); queueAutoSave(); renderBroll();
      }
    });

    panel.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      if (e.target.id === "broll-add-input") { e.preventDefault(); addBrollFromPanel(); }
      else if (e.target.classList.contains("broll-rename-input")) {
        e.preventDefault();
        var save = panel.querySelector('[data-action="broll-rename-save"][data-id="' +
          cssAttr(e.target.getAttribute("data-id")) + '"]');
        if (save) save.click();
      } else if (e.target.classList.contains("broll-person-input")) {
        e.preventDefault();
        var add = panel.querySelector('[data-action="broll-person-save"][data-id="' +
          cssAttr(e.target.getAttribute("data-id")) + '"]');
        if (add) add.click();
      }
    });

    document.querySelectorAll("#broll-modes [data-group]").forEach(function (b) {
      b.addEventListener("click", function () {
        brollGroupBy = b.getAttribute("data-group");
        renderBroll();
      });
    });

    var addBtn = document.getElementById("broll-add-save");
    if (addBtn) addBtn.addEventListener("click", addBrollFromPanel);
    var closeBtn = document.getElementById("broll-close");
    if (closeBtn) closeBtn.addEventListener("click", closeBrollPanel);
    var openBtn = document.getElementById("btn-broll");
    if (openBtn) openBtn.addEventListener("click", function () {
      var p = document.getElementById("broll-panel");
      if (p && !p.hidden) closeBrollPanel(); else openBrollPanel();
    });
  }
