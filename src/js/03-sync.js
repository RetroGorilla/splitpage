  /* ================= sync: identity, snapshots, merge =================

     There is no shared realtime channel available to this page, so
     collaboration rides on the publish/reload cycle:

       * every save is a compare-and-set against the version this view loaded;
       * if someone published first the call rejects `conflict` and the shell
         reloads this view to THEIR version — in-memory edits would vanish;
       * a successful save reloads this view too (the whole page is replaced),
         so the only way to keep local work is to stash it BEFORE publishing
         and merge it back into whatever we reload into.

     Everything below exists so that no edit is ever silently dropped. */

  var STASH_KEY = "splitpage-conflict-stash";
  var SNAPSHOT_KEY = "splitpage-snapshots";
  var RELOAD_GUARD_KEY = "splitpage-conflict-reloaded";
  var MAX_SNAPSHOTS = 12;
  var snapshotWarningShown = false;
  var MAX_SNAPSHOT_BYTES = 1200000;

  /* the version this view loaded (or last successfully published) — the
     common ancestor for every three-way merge */
  var baseState = null;

  function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

  function getEditorName() {
    return getSavedAuthorName() || "Anonymous";
  }

  function stampRow(row) {
    row.updatedAt = nowIso();
    row.updatedBy = getEditorName();
  }

  /* ---- local snapshot history (per viewer, survives reloads) ---- */

  function readSnapshots() {
    try {
      var raw = localStorage.getItem(SNAPSHOT_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  /* Keep the newest snapshots that actually fit. Browsers count UTF-16 code
     units, so the character budget is deliberately well under the usual 5 MB. */
  function writeSnapshots(list) {
    var working = list.slice();
    while (working.length) {
      var payload = JSON.stringify(working);
      if (payload.length <= MAX_SNAPSHOT_BYTES) {
        try {
          localStorage.setItem(SNAPSHOT_KEY, payload);
          /* mirror the pruning back to the caller's list */
          list.length = 0;
          Array.prototype.push.apply(list, working);
          return true;
        } catch (e) { /* over quota despite the budget — shed and retry */ }
      }
      working.shift();
    }
    /* Not even the single newest entry fits under the budget on its own —
       refuse to touch what's already on disk rather than wiping every
       OLDER snapshot that WAS small enough to keep (this used to call
       localStorage.removeItem() here, erasing the entire local version
       history over one oversized push). Leave storage as it was and hand
       the caller back exactly what's still there. */
    list.length = 0;
    Array.prototype.push.apply(list, readSnapshots());
    return false;
  }

  function pushSnapshot(label, snapshotState) {
    var src = snapshotState || state;
    if (!src) return;
    var list = readSnapshots();
    var entry = {
      id: makeId("s"),
      label: label,
      at: nowIso(),
      by: getEditorName(),
      rows: src.rows.length,
      state: cloneState(src)
    };
    list.push(entry);
    while (list.length > MAX_SNAPSHOTS) list.shift();
    var ok = writeSnapshots(list);
    if (!ok && !snapshotWarningShown) {
      snapshotWarningShown = true;
      showToast("This document is too large to snapshot — version history is unavailable.", "warn");
    }
    renderHistory();
    return ok;
  }

  function restoreSnapshot(id) {
    var list = readSnapshots();
    var entry = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) entry = list[i];
    if (!entry) return;
    pushSnapshot("Before restoring an earlier version");
    state = migrateRows(cloneState(entry.state));
    resetProductionPanelState(); /* same reason as openSplitpageFile — different document underneath */
    markDirty();
    render();
    closeHistoryPanel();
    showToast("Restored the version from " + formatTimestamp(entry.at), "ok");
    queueAutoSave();
  }

  /* ---- three-way merge ---- */

  function byId(list) {
    var map = {};
    (list || []).forEach(function (item) { map[item.id] = item; });
    return map;
  }

  var ROW_FIELDS = ["visualText", "visualImage", "audioText"];

  function rowContentEqual(a, b) {
    if (!a || !b) return false;
    return ROW_FIELDS.every(function (f) { return (a[f] || null) === (b[f] || null); });
  }

  /* The comment-level equivalent of rowContentEqual, used the same way: to
     tell "the other side left this untouched since base" (safe to honor a
     delete) apart from "the other side genuinely changed it" (a reply or a
     resolve must survive even if I deleted my copy). */
  function commentContentEqual(a, b) {
    if (!a || !b) return false;
    if ((a.body || "") !== (b.body || "")) return false;
    if (!!a.resolved !== !!b.resolved) return false;
    if (JSON.stringify(a.replies || []) !== JSON.stringify(b.replies || [])) return false;
    return true;
  }

  /* Merge `mine` and `theirs`, both descended from `base`.
     Anything that cannot be reconciled is preserved, never dropped.

     imagesStripped: true when `mine`/`base` came from stashLocalWork()'s
     oversized-document fallback, which replaces every visualImage with a
     sentinel that migrateRows() (correctly — safeImageSrc only ever allows a
     real data: URI through) turns back into null. That null is indistinguishable
     from "no image", so the normal equality-based fast paths below would
     silently conclude "unchanged" for a row that may well have had a real
     image swapped in locally right before the stash — see mergeRow(). */
  function mergeStates(base, mine, theirs, imagesStripped) {
    var conflicts = [];
    var stats = { rowsFromThem: 0, rowsFromMe: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 };

    var baseRows = byId(base && base.rows), mineRows = byId(mine.rows), theirRows = byId(theirs.rows);
    var merged = [];
    var placed = {};

    function mergeRow(b, m, t) {
      /* present on both sides — reconcile field by field */
      var out = JSON.parse(JSON.stringify(t));
      var tookMine = false;
      ROW_FIELDS.forEach(function (f) {
        var mv = m[f] || null, tv = t[f] || null, bv = b ? (b[f] || null) : null;
        /* A stripped-and-restored visualImage is null whether or not it
           really had an image — mv/bv equality here would be comparing two
           unknowns, not two agreements. Skip straight to "can't reconcile"
           whenever there's something on their side worth not silently
           losing; if theirs is empty too, there is nothing to protect
           either way, so let it fall through as an ordinary non-conflict. */
        if (f === "visualImage" && imagesStripped && tv) {
          out[f] = tv;
          conflicts.push({ rowId: t.id, field: f, mine: null, theirs: tv });
          return;
        }
        if (mv === tv) return;
        if (b && mv === bv) { out[f] = tv; return; }          /* only they changed it */
        if (b && tv === bv) { out[f] = mv; tookMine = true; return; }  /* only I changed it */
        /* both changed the same field: keep theirs live, keep mine intact */
        out[f] = tv;
        conflicts.push({ rowId: t.id, field: f, mine: mv, theirs: tv });
      });
      /* Status isn't text to reconcile, it's progress to accumulate: if
         either of us has marked a scene shot, it has been shot. Taking the
         furthest-along value can never un-shoot something someone filmed. */
      var rank = { todo: 0, ready: 1, shot: 2 };
      out.status = (rank[m.status] || 0) >= (rank[t.status] || 0) ? m.status : t.status;
      if (tookMine) {
        out.updatedAt = nowIso();
        out.updatedBy = getEditorName();
        stats.rowsFromMe++;
      } else if (!rowContentEqual(b || {}, t)) {
        stats.rowsFromThem++;
      }
      return out;
    }

    /* start from their ordering — it is the published truth */
    theirs.rows.forEach(function (t) {
      var b = baseRows[t.id], m = mineRows[t.id];
      if (!m) {
        if (b && rowContentEqual(b, t)) return;  /* I deleted it and they left it alone */
        merged.push(JSON.parse(JSON.stringify(t)));  /* they edited it — an edit outranks my delete */
        placed[t.id] = true;
        return;
      }
      merged.push(mergeRow(b, m, t));
      placed[t.id] = true;
    });

    /* rows only I have: ones I added, or ones they deleted but I edited */
    mine.rows.forEach(function (m, idxInMine) {
      if (placed[m.id] || theirRows[m.id]) return;
      var b = baseRows[m.id];
      if (b && rowContentEqual(b, m)) return;   /* they deleted it, I never touched it */
      if (!b) stats.rowsAddedByMe++;
      /* slot it back in after whichever of my neighbours survived */
      var anchorIdx = -1;
      for (var k = idxInMine - 1; k >= 0; k--) {
        var prevId = mine.rows[k].id;
        for (var j = 0; j < merged.length; j++) {
          if (merged[j].id === prevId) { anchorIdx = j; break; }
        }
        if (anchorIdx !== -1) break;
      }
      var copy = JSON.parse(JSON.stringify(m));
      if (anchorIdx === -1) merged.unshift(copy);
      else merged.splice(anchorIdx + 1, 0, copy);
      placed[m.id] = true;
    });

    theirs.rows.forEach(function (t) { if (!baseRows[t.id] && !mineRows[t.id]) stats.rowsAddedByThem++; });

    /* comments: union by id, newest wins, replies unioned */
    var baseC = byId(base && base.comments), mineC = byId(mine.comments), theirC = byId(theirs.comments);
    var mergedComments = [];
    var seen = {};
    function newer(a, b2) {
      return (a.updatedAt || a.createdAt || "") >= (b2.updatedAt || b2.createdAt || "") ? a : b2;
    }
    Object.keys(theirC).concat(Object.keys(mineC)).forEach(function (id) {
      if (seen[id]) return;
      seen[id] = true;
      var m = mineC[id], t = theirC[id], b = baseC[id];
      var pick;
      if (m && t) {
        pick = JSON.parse(JSON.stringify(newer(m, t)));
        /* `resolved` is forward progress, the same rule this file already
           applies to row/tag status ("a merge can never un-shoot/un-buy
           something") — so it is merged independently rather than riding
           along with whichever whole side "newer" happened to pick. Without
           this, an unrelated action that bumps updatedAt on one side (e.g. a
           reply) can silently revert a resolve/unresolve that happened
           earlier in wall-clock time on the other side. */
        pick.resolved = !!(m.resolved || t.resolved);
      }
      /* An edit outranks a delete for comments the same way it already does
         for rows a few lines up: only a comment BOTH honor as unchanged
         since base is safe to drop when the other side deleted it. */
      else if (t && !m) { if (b && commentContentEqual(b, t)) return; pick = JSON.parse(JSON.stringify(t)); }   /* I deleted it */
      else { if (b && commentContentEqual(b, m)) return; pick = JSON.parse(JSON.stringify(m)); }                /* they deleted it */
      if (m && t) {
        var replies = byId(m.replies);
        (t.replies || []).forEach(function (r) { replies[r.id] = r; });
        pick.replies = Object.keys(replies).map(function (k) { return replies[k]; })
          .sort(function (x, y) { return (x.createdAt || "").localeCompare(y.createdAt || ""); });
      }
      mergedComments.push(pick);
    });

    /* Row fields raise a conflict comment the instant both sides touch the
       same field — the title never did: it just kept theirs, silently,
       whenever both sides had changed it (or base wasn't available at
       all, e.g. resumeServerDoc() with no stash.base). Route it through
       the same conflicts array instead (pushed before the forEach below
       builds comments from it), with rowId: null marking it as a title
       conflict rather than a row one (findAnchorLocationLabel,
       restoreConflictValue and the label just below all special-case
       field === "title" to handle that). */
    var mergedTitle = theirs.title;
    if (base && mine.title !== base.title && theirs.title === base.title) {
      mergedTitle = mine.title;
    } else if (mine.title !== theirs.title && (!base || (mine.title !== base.title && theirs.title !== base.title))) {
      if (mine.title) conflicts.push({ rowId: null, field: "title", mine: mine.title, theirs: theirs.title });
    }

    /* every unreconcilable field becomes a comment holding my version */
    conflicts.forEach(function (c) {
      var label = c.field === "audioText" ? "Audio" : c.field === "visualText" ? "Visual" :
        c.field === "title" ? "Title" : "Visual image";
      var isEmpty = !c.mine;
      var bodyHtml = c.field === "visualImage"
        ? (safeImageSrc(c.mine) ? '<img class="comment-img" src="' + escapeHtml(c.mine) + '">' : "")
        : c.field === "title" ? escapeHtml(c.mine || "")
        : (c.mine || "");
      mergedComments.push({
        id: makeId("c"),
        rowId: c.rowId,
        field: c.field,
        anchorId: null,
        quotedText: "",
        author: getEditorName(),
        body: bodyHtml,
        resolved: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        kind: "conflict",
        conflictField: label,
        emptyValue: isEmpty,
        /* plain text, kept alongside the escaped display body so restoring
           it doesn't need to round-trip back out of HTML */
        titleValue: c.field === "title" ? (c.mine || "") : undefined,
        replies: []
      });
    });

    return {
      merged: migrateRows({
        title: mergedTitle,
        rows: merged,
        comments: mergedComments,
        people: mergePeople(mine.people, theirs.people),
        productionTags: mergeProductionTags(mine.productionTags, theirs.productionTags),
        wordsPerMinute: theirs.wordsPerMinute || mine.wordsPerMinute || DEFAULT_WPM,
        rev: Math.max(theirs.rev || 0, mine.rev || 0) + 1,
        lastEditedBy: theirs.lastEditedBy || mine.lastEditedBy || null,
        lastEditedAt: theirs.lastEditedAt || mine.lastEditedAt || null,
        schema: SCHEMA_VERSION
      }),
      conflicts: conflicts,
      stats: stats
    };
  }

  /* The crew list and the production registry are both append-mostly lists
     that nobody "owns" — dropping either side's would quietly lose work that
     no row diff can reconstruct (an assignment, a note, an item deliberately
     kept after being cut from the script). Union them instead. */
  function mergePeople(minePeople, theirPeople) {
    var out = [], seenId = {}, seenName = {};
    (theirPeople || []).concat(minePeople || []).forEach(function (p) {
      if (!p || !p.name) return;
      var norm = normalizeTagName(p.name);
      if (seenId[p.id] || seenName[norm]) return;
      seenId[p.id] = true;
      seenName[norm] = true;
      out.push({ id: p.id, name: p.name });
    });
    return out;
  }

  function mergeProductionTags(mineTags, theirTags) {
    var out = [], byKey = {};
    (theirTags || []).forEach(function (t) {
      if (!t || !t.name) return;
      var k = registryKey(t.cat, t.name);
      if (byKey[k]) return;
      byKey[k] = { cat: t.cat, name: t.name, owner: t.owner || "", notes: t.notes || "",
                   status: (tagStatus(t.status) || TAG_STATUSES[0]).id };
      out.push(byKey[k]);
    });
    (mineTags || []).forEach(function (t) {
      if (!t || !t.name) return;
      var k = registryKey(t.cat, t.name);
      var existing = byKey[k];
      if (!existing) {
        byKey[k] = { cat: t.cat, name: t.name, owner: t.owner || "", notes: t.notes || "",
                     status: (tagStatus(t.status) || TAG_STATUSES[0]).id };
        out.push(byKey[k]);
        return;
      }
      /* same item on both sides: never let an empty field overwrite a filled
         one — an assignment or a note only I made still survives the merge */
      if (!existing.owner && t.owner) existing.owner = t.owner;
      if (!existing.notes && t.notes) existing.notes = t.notes;
      /* status merges by rank, the same way a scene's does: whoever got
         further wins. A merge can never un-buy a prop somebody bought. */
      if (tagStatusRank(t.status) > tagStatusRank(existing.status)) {
        existing.status = (tagStatus(t.status) || TAG_STATUSES[0]).id;
      }
    });
    return out;
  }

  /* ---- conflict stash (survives the reload the shell forces on us) ---- */

  function stripImages(doc) {
    if (!doc) return doc;
    var copy = cloneState(doc);
    copy.rows.forEach(function (r) { r.visualImage = r.visualImage ? "__IMAGE__" : null; });
    return copy;
  }

  /* Returns true only if the work is genuinely persisted. The caller MUST NOT
     force a reload on false — that would throw the work away. */
  function stashLocalWork() {
    if (!state) return false;
    function attempt(payload) {
      try {
        sessionStorage.setItem(STASH_KEY, JSON.stringify(payload));
        return true;
      } catch (e) { return false; }
    }
    var meta = { at: nowIso(), by: getEditorName() };
    if (attempt({ at: meta.at, by: meta.by, base: baseState, mine: state })) return true;
    /* too big for sessionStorage — drop the images, which are the bulk, and
       keep the text. Image fields then merge as "unknown" rather than being lost. */
    if (attempt({ at: meta.at, by: meta.by, base: stripImages(baseState),
                  mine: stripImages(state), imagesStripped: true })) return true;
    return false;
  }

  function clearStash() {
    try { sessionStorage.removeItem(STASH_KEY); } catch (e) {}
  }

  function readStash() {
    try {
      var raw = sessionStorage.getItem(STASH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ---- identity ---- */

  function updateIdentityChip() {
    var name = getSavedAuthorName();
    document.getElementById("identity-name").textContent = name || "Set your name";
    document.getElementById("identity-chip").classList.toggle("unnamed", !name);
  }

  function promptForName() {
    var current = getSavedAuthorName();
    var host = document.getElementById("identity-chip");
    var existing = document.getElementById("identity-editor");
    if (existing) { existing.remove(); return; }
    var wrap = document.createElement("span");
    wrap.id = "identity-editor";
    wrap.className = "link-popover";
    wrap.style.position = "absolute";
    wrap.style.zIndex = "170";
    wrap.style.background = "var(--surface)";
    wrap.style.border = "1px solid var(--border)";
    wrap.style.borderRadius = "8px";
    wrap.style.padding = "8px";
    wrap.style.boxShadow = "var(--shadow)";
    wrap.innerHTML =
      '<input type="text" id="identity-input" placeholder="Your name" value="' + escapeHtml(current) + '">' +
      '<button type="button" id="identity-save">Save</button>';
    host.parentNode.insertBefore(wrap, host.nextSibling);
    var input = document.getElementById("identity-input");
    input.focus();
    input.select();
    function commit() {
      var v = (input.value || "").trim();
      if (v) saveAuthorName(v);
      wrap.remove();
      updateIdentityChip();
      render();
    }
    document.getElementById("identity-save").addEventListener("click", commit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); wrap.remove(); }
    });
  }

  /* Reading speed lives on the document (see migrateRows), so the estimate
     reads the same for whoever opens the file next. Same inline-popover
     pattern as promptForName. */
  function promptForWpm() {
    if (!state) return;
    var host = document.getElementById("runtime-chip");
    var existing = document.getElementById("wpm-editor");
    if (existing) { existing.remove(); return; }
    var wrap = document.createElement("span");
    wrap.id = "wpm-editor";
    wrap.className = "link-popover";
    wrap.style.position = "absolute";
    wrap.style.zIndex = "170";
    wrap.style.background = "var(--surface)";
    wrap.style.border = "1px solid var(--border)";
    wrap.style.borderRadius = "8px";
    wrap.style.padding = "8px";
    wrap.style.boxShadow = "var(--shadow)";
    wrap.innerHTML =
      '<input type="number" id="wpm-input" min="60" max="400" step="5" value="' +
        escapeHtml(String(state.wordsPerMinute || DEFAULT_WPM)) + '" aria-label="Words per minute">' +
      '<button type="button" id="wpm-save">Set</button>';
    host.parentNode.insertBefore(wrap, host.nextSibling);
    var input = document.getElementById("wpm-input");
    input.focus();
    input.select();
    function commit() {
      var v = Math.round(Number(input.value));
      if (isFinite(v) && v >= 60 && v <= 400 && v !== state.wordsPerMinute) {
        state.wordsPerMinute = v;
        markDirty();
        render();
        queueAutoSave();
      }
      wrap.remove();
    }
    document.getElementById("wpm-save").addEventListener("click", commit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); wrap.remove(); }
    });
  }

  /* ---- version history panel ---- */

  var SIDE_PANEL_IDS = ["comments-panel", "production-panel", "history-panel", "gear-panel"];

  /* All the side panels are fixed over the same right-hand strip, so only
     one can be open at a time — opening one always closes the others first,
     otherwise they silently stack on top of each other (whichever is later
     in the DOM wins the pixels) and closing the top one leaves the one
     underneath still "open" with nothing accounting for its layout space. */
  function openSidePanel(id) {
    SIDE_PANEL_IDS.forEach(function (pid) {
      if (pid !== id) {
        var el = document.getElementById(pid);
        if (el) el.hidden = true;
      }
    });
    document.getElementById(id).hidden = false;
    syncPanelClass();
  }

  function openHistoryPanel() {
    openSidePanel("history-panel");
    renderHistory();
  }
  function closeHistoryPanel() {
    var p = document.getElementById("history-panel");
    if (p) p.hidden = true;
    syncPanelClass();
  }

  /* a side panel is fixed over the right edge — shift the document so it never
     covers the toolbar that opened it */
  function syncPanelClass() {
    var open = SIDE_PANEL_IDS.some(function (pid) {
      var el = document.getElementById(pid);
      return el && !el.hidden;
    });
    document.body.classList.toggle("panel-open", open);
  }

  function renderHistory() {
    var listEl = document.getElementById("history-list");
    var panel = document.getElementById("history-panel");
    if (!listEl || !panel || panel.hidden) return;
    var list = readSnapshots().slice().reverse();
    if (!list.length) {
      listEl.innerHTML = '<div class="comments-empty">No snapshots yet. Splitpage saves one automatically before anything that could overwrite your work — opening a document, replacing rows, or merging someone else\'s changes.</div>';
      return;
    }
    listEl.innerHTML = list.map(function (s) {
      return '<div class="history-card">' +
        '<div class="history-card-label">' + escapeHtml(s.label) + '</div>' +
        '<div class="history-card-meta">' + formatTimestamp(s.at) + ' · ' + escapeHtml(s.by) +
        ' · ' + s.rows + ' row' + (s.rows === 1 ? "" : "s") + '</div>' +
        '<button type="button" data-action="restore-snapshot" data-id="' + escapeHtml(safeId(s.id, "s")) + '">Restore this version</button>' +
        '</div>';
    }).join("");
  }

  /* ---- merge reporting ---- */

  var lastMergeUndo = null;
  var undoArmed = false;
  var undoArmTimer = null;

  /* `opts.alreadySaved` is for the hosted path, where the merge happened
     *during* a save and the merged result is already on the server by the
     time we report it. Without it the report marks the document dirty and
     queues another write of identical content — and every needless rev bump
     pushes every other viewer into a 409 and a merge they did not need. */
  function reportMerge(result, opts) {
    opts = opts || {};
    var s = result.stats;
    var bits = [];
    if (s.rowsFromMe) bits.push(s.rowsFromMe + " row" + (s.rowsFromMe === 1 ? "" : "s") + " you edited");
    if (s.rowsAddedByMe) bits.push(s.rowsAddedByMe + " row" + (s.rowsAddedByMe === 1 ? "" : "s") + " you added");
    if (s.rowsFromThem) bits.push(s.rowsFromThem + " changed by someone else");
    if (s.rowsAddedByThem) bits.push(s.rowsAddedByThem + " added by someone else");

    /* nothing actually differed — don't make a ceremony of it */
    if (!bits.length && !result.conflicts.length) {
      if (!opts.alreadySaved) { markDirty(); queueAutoSave(); }
      return;
    }

    var summary = bits.length ? "Kept " + bits.join(", ") + "." : "Nothing was lost.";
    if (result.conflicts.length) {
      summary += " " + result.conflicts.length + " edit" + (result.conflicts.length === 1 ? " was" : "s were") +
        " changed on both sides — your version is saved as a comment.";
    }

    document.getElementById("merge-summary").textContent = " " + summary;
    document.getElementById("merge-review").hidden = !result.conflicts.length;
    var banner = document.getElementById("merge-banner");
    /* .notice-merge.notice-warn (app.css) flags a merge as urgent — red
       border/background instead of the plain green — but nothing ever
       added the class, so a merge that actually lost data on one side
       (real conflicts, saved as comments below) looked exactly like an
       ordinary clean merge. */
    banner.classList.toggle("notice-warn", !!result.conflicts.length);
    banner.hidden = false;

    /* flash the rows that came from the merge */
    result.conflicts.forEach(function (c) {
      var el = document.querySelector('#rows .row[data-id="' + safeId(c.rowId, "r") + '"]');
      if (el) el.classList.add("just-merged");
    });

    if (!opts.alreadySaved) { markDirty(); queueAutoSave(); }
  }

  /* Reverts to the version that was live before the merge — i.e. discards the
     work the merge just rescued. Destructive enough to need a confirm, and
     recoverable afterwards because restoreSnapshot snapshots first. */
  function undoMerge(btn) {
    if (!lastMergeUndo) { showToast("No merge snapshot to undo.", "warn"); return; }
    if (undoArmed) {
      clearTimeout(undoArmTimer);
      undoArmed = false;
      restoreSnapshot(lastMergeUndo);
      return;
    }
    undoArmed = true;
    btn.textContent = "Discard my edits?";
    btn.classList.add("armed");
    clearTimeout(undoArmTimer);
    undoArmTimer = setTimeout(function () {
      undoArmed = false;
      btn.textContent = "Undo merge";
      btn.classList.remove("armed");
    }, 3000);
  }

  function findRowIndex(id) {
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].id === id) return i;
    }
    return -1;
  }
