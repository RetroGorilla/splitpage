  /* ---- the production panel ---- */

  function openProductionPanel() {
    if (!state) return;
    openSidePanel("production-panel");
    renderProduction();
  }

  function closeProductionPanel() {
    document.getElementById("production-panel").hidden = true;
    syncPanelClass();
  }

  /* ---- the gear panel ----

     A thinner, single-category sibling of the production panel rather than
     a second copy of it: cards, status, owner, notes, rename, remove/delete
     are all tagEntityHtml() and the same handlers the production panel
     already uses (wired onto #gear-panel by wireTagEntityContainer() in
     init() — see the note there). The only things genuinely new here are
     the quick-add box and the packing-list export. */

  var gearGroupBy = "flat";   /* "flat" | "scene" */

  function gearEntries() {
    return productionEntries().filter(function (e) { return e.cat.id === "gear"; });
  }

  function openGearPanel() {
    if (!state) return;
    openSidePanel("gear-panel");
    fillGearQuickAdd();
    renderProduction();
  }

  function closeGearPanel() {
    document.getElementById("gear-panel").hidden = true;
    syncPanelClass();
  }

  function updateGearBadge(n) {
    var badge = document.getElementById("gear-badge");
    if (!badge) return;
    if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
    else badge.hidden = true;
  }

  function updateGearCount() {
    updateGearBadge(state ? gearEntries().length : 0);
  }

  function renderGearList() {
    var panel = document.getElementById("gear-panel");
    if (!panel || panel.hidden || !state) return;
    var listEl = document.getElementById("gear-list");
    var entries = gearEntries();
    updateGearBadge(entries.length);

    document.querySelectorAll("#gear-modes [data-group]").forEach(function (b) {
      var on = b.getAttribute("data-group") === gearGroupBy;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });

    if (!entries.length) {
      listEl.innerHTML = '<div class="comments-empty">No gear tracked yet.<br><br>' +
        'Type <code>&lt;a lens&gt;</code> straight into the script, select words and ' +
        'press <strong>Tag</strong>, or just list it above — gear doesn’t have to be ' +
        'written into a scene to be tracked.</div>';
      return;
    }

    if (gearGroupBy === "scene") {
      var untracked = entries.filter(function (e) { return e.orphaned; }).length;
      listEl.innerHTML = renderProductionByScene(entries.filter(function (e) { return !e.orphaned; })) +
        (untracked ? '<div class="tag-orphan-note">' + untracked +
          (untracked === 1 ? " item isn't" : " items aren't") +
          ' mentioned in any scene — switch to List to see ' +
          (untracked === 1 ? "it" : "them") + '.</div>' : '');
      return;
    }

    listEl.innerHTML = entries.map(tagEntityHtml).join("");
  }

  /* The textarea always opens showing what's actually tracked, sorted the
     way a packed list reads best — alphabetically, not script order, since
     half of what's in here may have no place in the script at all. */
  function fillGearQuickAdd() {
    var box = document.getElementById("gear-quickadd-input");
    if (!box || document.activeElement === box) return;
    var names = gearEntries().map(function (e) { return e.name; })
      .sort(function (a, b) { return a.localeCompare(b); });
    box.value = names.join("\n");
  }

  /* One line, one item. Reconciles rather than only adding: a name typed in
     becomes tracked whether or not it's ever mentioned in the script (see
     registerProductionTag), and a name taken back OUT is untracked again —
     but only if nothing in the script still tags it. An item that's live in
     the script can't actually be lost this way: it comes straight back the
     next render via productionEntries()'s own self-heal, so this never
     silently drops anything the script itself is still pointing at — it
     only ever forgets the entries that lived here and nowhere else. */
  function applyGearQuickAdd() {
    var raw = document.getElementById("gear-quickadd-input").value || "";
    var wanted = {}, order = [];
    raw.split(/\r\n|\r|\n/).forEach(function (line) {
      var name = plainText(line).trim().slice(0, 80);
      if (!name) return;
      var key = normalizeTagName(name);
      if (wanted[key]) return;
      wanted[key] = name;
      order.push(key);
    });

    var removed = 0;
    gearEntries().forEach(function (item) {
      if (wanted[normalizeTagName(item.name)] !== undefined) return;
      if (!item.orphaned) return; /* still tagged live — never silently dropped */
      if (deleteProductionTagEntry("gear", item.name)) removed++;
    });

    var added = 0;
    order.forEach(function (key) {
      if (!registryEntry("gear", wanted[key])) added++;
      registerProductionTag("gear", wanted[key]);
    });

    if (!added && !removed) { fillGearQuickAdd(); return; }
    markDirty();
    renderProduction();
    fillGearQuickAdd();
    queueAutoSave();
    var parts = [];
    if (added) parts.push("added " + added);
    if (removed) parts.push("removed " + removed);
    showToast("Gear list updated — " + parts.join(", ") + ".", "ok");
  }

  /* one chip per scene AND column, so "twice in scene 1" is distinguishable
     from "once in the visual and once in the audio" */
  function sceneChipsHtml(item) {
    var seen = {}, order = [];
    item.mentions.forEach(function (m) {
      var k = m.rowIndex + "|" + m.field;
      if (seen[k]) { seen[k].n++; return; }
      seen[k] = { n: 1, m: m };
      order.push(k);
    });
    return order.map(function (k) {
      var entry = seen[k];
      var extra = entry.n > 1 ? " x" + entry.n : "";
      return '<button type="button" class="tag-scene" data-action="jump-tag" data-row="' +
        escapeHtml(entry.m.rowId) + '" data-key="' + escapeHtml(item.key) + '">' +
        pad2(entry.m.rowIndex + 1) + (entry.m.field === "visualText" ? " Visual" : " Audio") +
        extra + '</button>';
    }).join("");
  }

  /* The owner picker, notes box and the destructive actions all live behind
     a click on the card — the list stays scannable when you're reading it as
     a breakdown, and the editing controls are there when you're working on
     one item. Renaming forces the card open, since its input lives in here. */
  function tagEntityDetailHtml(item, renaming) {
    var k = escapeHtml(item.key);
    var stId = (tagStatus(item.status) || TAG_STATUSES[0]).id;
    return '<div class="tag-entity-detail">' +
      '<div class="tag-detail-label">Status</div>' +
      '<div class="tag-status-seg">' +
        TAG_STATUSES.map(function (s) {
          return '<button type="button" data-action="tag-status-set" data-key="' + k +
            '" data-status="' + escapeHtml(s.id) + '" style="--st:' + s.color + '"' +
            (s.id === stId ? ' class="is-active" aria-checked="true"' : ' aria-checked="false"') +
            ' role="radio">' + escapeHtml(s.label) + '</button>';
        }).join("") +
      '</div>' +
      '<div class="tag-detail-label">Assigned to</div>' +
      '<div class="tag-owner-row">' +
        '<select class="tag-owner-select" data-key="' + k + '">' +
          '<option value=""' + (item.owner ? '' : ' selected') + '>Unassigned</option>' +
          state.people.map(function (p) {
            return '<option value="' + escapeHtml(p.id) + '"' +
              (p.id === item.owner ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
          }).join("") +
        '</select>' +
        '<button type="button" class="tag-person-add" data-action="tag-person-new" data-key="' + k +
          '" title="Add someone to the crew list">+ Person</button>' +
      '</div>' +
      (tagAddingPersonFor === item.key
        ? '<div class="tag-owner-row">' +
            '<input type="text" class="tag-person-input" data-key="' + k +
              '" placeholder="Their name" maxlength="60">' +
            '<button type="button" data-action="tag-person-save" data-key="' + k + '">Add</button>' +
            '<button type="button" data-action="tag-person-cancel">Cancel</button>' +
          '</div>'
        : '') +
      '<div class="tag-detail-label">Notes &amp; links</div>' +
      '<textarea class="tag-notes-input" data-key="' + k + '" rows="3" ' +
        'placeholder="Reference link, file path, spec, where it&#39;s coming from…">' +
        escapeHtml(item.notes) + '</textarea>' +
      '<div class="tag-entity-actions">' +
        (renaming
          ? '<button type="button" data-action="tag-rename-save" data-key="' + k + '">Save</button>' +
            '<button type="button" data-action="tag-rename-cancel">Cancel</button>'
          : '<button type="button" data-action="tag-rename" data-key="' + k + '">Rename</button>' +
            (item.orphaned
              ? '<button type="button" class="danger" data-action="tag-delete" data-key="' + k + '">Delete from list</button>'
              : '<button type="button" class="danger" data-action="tag-remove" data-key="' + k + '">Remove label</button>')) +
      '</div>' +
    '</div>';
  }

  function tagEntityHtml(item) {
    var renaming = tagRenaming === item.key;
    var expanded = tagExpanded === item.key || renaming;
    var owner = personById(item.owner);
    var st = tagStatus(item.status) || TAG_STATUSES[0];
    var nextSt = tagStatus(nextTagStatus(st.id)) || TAG_STATUSES[0];
    var k = escapeHtml(item.key);
    var meta = (owner ? '<span class="tag-owner-chip">' + escapeHtml(owner.name) + '</span>' : '') +
      (item.notes ? '<span class="tag-note-flag" title="Has notes">Notes</span>' : '');
    return '<div class="tag-entity' + (item.orphaned ? ' is-orphaned' : '') +
        (expanded ? ' is-expanded' : '') +
        (productionSelection[item.key] ? ' is-selected' : '') +
        '" style="--dot:' + item.cat.color + '" data-key="' + k +
        '" aria-selected="' + (productionSelection[item.key] ? 'true' : 'false') + '">' +
      '<div class="tag-entity-head" data-action="tag-expand" data-key="' + k + '">' +
        '<span class="tag-entity-name">' + escapeHtml(item.name) + '</span>' +
        '<span class="tag-entity-head-right">' +
          /* nested inside the expander, so its own handler has to be checked
             first in the click delegation — see the tag-status-cycle branch */
          '<button type="button" class="tag-status-pill" data-action="tag-status-cycle" ' +
            'data-key="' + k + '" style="--st:' + st.color + '" title="' +
            escapeHtml(st.label + " — click for " + nextSt.label) + '">' +
            escapeHtml(st.label) + '</button>' +
          (item.orphaned
            ? '<span class="tag-orphan-badge">Not in script</span>'
            : '<span class="tag-entity-count">' + item.mentions.length + ' mention' +
                (item.mentions.length === 1 ? '' : 's') + '</span>') +
        '</span>' +
      '</div>' +
      (meta ? '<div class="tag-entity-meta">' + meta + '</div>' : '') +
      (renaming
        ? '<input type="text" class="tag-rename-input" value="' + escapeHtml(item.name) +
            '" data-key="' + k + '">'
        : item.orphaned
          ? '<div class="tag-orphan-note">' + escapeHtml(item.cat.label) +
              ' no longer appears anywhere in the script.</div>'
          : '<div class="tag-scenes">' + sceneChipsHtml(item) + '</div>') +
      (expanded ? tagEntityDetailHtml(item, renaming) : '') +
    '</div>';
  }

  function renderProductionByScene(all) {
    var byRow = {};
    all.forEach(function (item) {
      item.mentions.forEach(function (m) {
        if (!byRow[m.rowIndex]) byRow[m.rowIndex] = {};
        byRow[m.rowIndex][item.key] = item;
      });
    });
    var indexes = Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; });
    return indexes.map(function (idx) {
      var items = Object.keys(byRow[idx]).map(function (k) { return byRow[idx][k]; });
      return '<div class="tag-scene-group">' +
        '<div class="tag-scene-group-head">Scene ' + pad2(idx + 1) + '</div>' +
        items.map(function (item) {
          return '<span class="tag-pill" style="border-color:' + item.cat.color + '">' +
            '<span class="tag-cat-dot" style="--dot:' + item.cat.color + '"></span>' +
            escapeHtml(item.name) + '</span>';
        }).join("") +
      '</div>';
    }).join("");
  }

  /* Everyone on the crew list gets a group even with nothing assigned yet —
     an empty column is the useful signal that someone has no work on them,
     and it gives you somewhere to drop the first item. Unassigned sorts
     last, since it's the pile you're trying to empty. */
  function renderProductionByPerson(all) {
    var buckets = {}, order = [];
    function bucket(id, label) {
      if (!buckets[id]) { buckets[id] = { id: id, label: label, items: [] }; order.push(id); }
      return buckets[id];
    }
    state.people.forEach(function (p) { bucket(p.id, p.name); });
    all.forEach(function (item) {
      var p = personById(item.owner);
      bucket(p ? p.id : "", p ? p.name : "Unassigned").items.push(item);
    });
    order.sort(function (a, b) { return (a === "" ? 1 : 0) - (b === "" ? 1 : 0); });

    return order.map(function (id) {
      var g = buckets[id];
      return '<div class="tag-group-head tag-person-head">' +
          '<span class="tag-person-name">' + escapeHtml(g.label) + '</span>' +
          '<span class="tag-group-count">' + g.items.length + '</span>' +
          (id ? '<button type="button" class="tag-person-remove" data-action="person-delete" ' +
                  'data-person="' + escapeHtml(id) + '" title="Remove from the crew list">×</button>' : '') +
        '</div>' +
        (g.items.length
          ? g.items.map(tagEntityHtml).join("")
          : '<div class="tag-orphan-note">Nothing assigned yet.</div>');
    }).join("");
  }

  /* Shooting order: the script reorganised the way a shoot day actually runs.
     Scenes are grouped by the location tagged in them, so everything at one
     place can be shot in one block, and each block lists what has to be
     there — every non-location item tagged in those scenes, with who is
     responsible for it. A scene with no location tagged still has to be shot,
     so it gets its own group rather than being quietly dropped. */
  function renderProductionByShoot(entries) {
    /* productionEntries(), not collectTags(): the raw script read has only
       {cat, name, mentions} on it, so the owner and status this view prints
       against each item would silently be undefined. Orphans carry no
       mentions, so they contribute nothing here and need no filtering out. */
    var live = entries || productionEntries();
    var byRow = {};   /* rowIndex -> [item] */
    live.forEach(function (item) {
      item.mentions.forEach(function (m) {
        (byRow[m.rowIndex] = byRow[m.rowIndex] || []).push(item);
      });
    });

    var groups = {}, order = [];
    function group(key, name) {
      if (!groups[key]) { groups[key] = { name: name, rows: [], needs: {}, needOrder: [] }; order.push(key); }
      return groups[key];
    }

    state.rows.forEach(function (row, i) {
      var here = byRow[i] || [];
      var locs = here.filter(function (t) { return t.cat.id === "location"; });
      var targets = locs.length
        ? locs.map(function (t) { return { key: t.key, name: t.name }; })
        : [{ key: "", name: "No location set" }];
      targets.forEach(function (t) {
        var g = group(t.key, t.name);
        if (g.rows.indexOf(i) === -1) g.rows.push(i);
        here.forEach(function (item) {
          if (item.cat.id === "location") return;
          if (g.needs[item.key]) return;
          g.needs[item.key] = item;
          g.needOrder.push(item.key);
        });
      });
    });

    if (!order.length) return '<div class="comments-empty">Nothing to schedule yet.</div>';
    /* untagged scenes last — they're the leftovers, not the plan */
    order.sort(function (a, b) { return (a === "" ? 1 : 0) - (b === "" ? 1 : 0); });

    return order.map(function (key) {
      var g = groups[key];
      var shot = g.rows.filter(function (i) { return state.rows[i].status === "shot"; }).length;
      var secs = g.rows.reduce(function (n, i) { return n + rowSeconds(state.rows[i]); }, 0);
      var done = shot === g.rows.length;
      return '<div class="shoot-group" style="--dot:' + (key ? TAG_CATEGORIES[1].color : "var(--border)") + '">' +
        '<div class="shoot-head">' +
          '<span class="shoot-name">' + escapeHtml(g.name) + '</span>' +
          '<span class="shoot-progress' + (done ? ' is-done' : '') + '">' +
            shot + '/' + g.rows.length + ' shot · ' + formatDuration(secs) + '</span>' +
        '</div>' +
        '<div class="shoot-sub">Scenes</div>' +
        '<div class="tag-scenes">' +
          g.rows.map(function (i) {
            var st = rowStatus(state.rows[i].status) || ROW_STATUSES[0];
            return '<button type="button" class="tag-scene" data-action="jump-row" data-row="' +
              escapeHtml(state.rows[i].id) + '" title="' + escapeHtml(st.label) + '">' +
              pad2(i + 1) + (state.rows[i].status === "shot" ? ' ✓' : '') + '</button>';
          }).join("") +
        '</div>' +
        (g.needOrder.length
          ? '<div class="shoot-sub">Needs on the day</div>' +
            '<div class="shoot-needs">' +
              g.needOrder.map(function (k) {
                var item = g.needs[k];
                var owner = personById(item.owner);
                var nst = tagStatus(item.status) || TAG_STATUSES[0];
                return '<span class="shoot-need">' +
                  '<span class="tag-cat-dot" style="--dot:' + item.cat.color + '"></span>' +
                  escapeHtml(item.name) +
                  '<span class="shoot-need-status" style="--st:' + nst.color + '">' +
                    escapeHtml(nst.label) + '</span>' +
                  (owner ? '<span class="shoot-need-owner">' + escapeHtml(owner.name) + '</span>' : '') +
                '</span>';
              }).join("") +
            '</div>'
          : '') +
      '</div>';
    }).join("");
  }

  /* Every caller that changes tagged data — a status cycle, a rename, an
     edit to the script itself — refreshes by calling renderProduction().
     There are now two panels that can show that data: split so BOTH refresh
     from one call, the same way updateFileChip() covers the header's chip
     and the writer's. Neither caller has to know the other panel exists. */
  function renderProduction() {
    renderProductionPanel();
    renderGearList();
  }

  /* One scan, threaded through everything that needs it. Pruning, the list,
     the badge and the bulk bar all used to call productionEntries()
     separately — four reads of the same document in one synchronous pass.
     Threading rather than caching on a version counter keeps it obviously
     correct: it is the same array, so it cannot disagree with itself. */
  function renderProductionPanel() {
    var panel = document.getElementById("production-panel");
    if (!panel || panel.hidden || !state) return;
    var entries = productionEntries();
    if (selectedKeys().length) pruneProductionSelection(entries);
    renderProductionList(entries);
    renderBulkBar(entries);
    updateProductionBadge(entries.length);
  }

  function renderProductionList(entries) {
    var listEl = document.getElementById("production-list");
    var panel = document.getElementById("production-panel");
    if (!listEl || !panel || panel.hidden || !state) return;
    entries = entries || productionEntries();

    document.querySelectorAll("#production-modes [data-group]").forEach(function (b) {
      var on = b.getAttribute("data-group") === productionGroupBy;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });

    /* the shoot view is organised around scenes, so it still has something
       useful to say even when nothing has been tagged yet */
    if (productionGroupBy === "shoot") {
      listEl.innerHTML = renderProductionByShoot(entries);
      return;
    }

    var groups = tagsByCategory(entries);
    if (!groups.length) {
      listEl.innerHTML = '<div class="comments-empty">Nothing labelled yet.<br><br>' +
        'Type <code>[a prop]</code>, <code>{a location}</code> or <code>~an effect~</code> ' +
        'straight into the script, or select any words and press <strong>Tag</strong>. ' +
        'Everything you label shows up here with every scene it appears in — and you can ' +
        'assign who is responsible for it, track it from Needed through to Returned, ' +
        'and keep notes and links against it.</div>';
      return;
    }

    if (productionGroupBy === "scene") {
      var orphanCount = groups.reduce(function (n, g) {
        return n + g.items.filter(function (i) { return i.orphaned; }).length;
      }, 0);
      /* live items only — the scene view groups by where a tag appears, and
         an orphan appears nowhere; they are counted separately below */
      listEl.innerHTML = renderProductionByScene(entries.filter(function (e) { return !e.orphaned; })) +
        (orphanCount ? '<div class="tag-orphan-note">' + orphanCount +
          (orphanCount === 1 ? " item doesn't" : " items don't") +
          ' appear in any scene — group by category or person to see ' +
          (orphanCount === 1 ? "it" : "them") + '.</div>' : '');
      return;
    }

    if (productionGroupBy === "person") {
      listEl.innerHTML = renderProductionByPerson(entries);
      return;
    }

    listEl.innerHTML = groups.map(function (g) {
      return '<div class="tag-group-head" style="--dot:' + g.cat.color + '">' +
          '<span class="tag-cat-dot" style="--dot:' + g.cat.color + '"></span>' +
          escapeHtml(g.cat.plural) +
          '<span class="tag-group-count">' + g.items.length + '</span>' +
        '</div>' +
        g.items.map(tagEntityHtml).join("");
    }).join("");
  }

  function findTagByKey(key) {
    var all = productionEntries();
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    return null;
  }

  function jumpToTag(rowId, key) {
    var row = document.querySelector('#rows .row[data-id="' + safeId(rowId, "r") + '"]');
    if (!row) { showToast("That scene is no longer here.", "warn"); return; }
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    var item = findTagByKey(key);
    if (!item) return;
    Array.prototype.forEach.call(row.querySelectorAll(".tag-anchor"), function (el) {
      if (normalizeTagName(el.getAttribute("data-tag-name")) !== normalizeTagName(item.name)) return;
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    });
  }

  function armRemoveTag(btn, key) {
    if (tagDeleteArmId === key) {
      clearTimeout(tagDeleteArmTimer);
      tagDeleteArmId = null;
      var item = findTagByKey(key);
      if (!item) return;
      var n = removeTag(item.cat.id, item.name);
      markDirty();
      render();
      queueAutoSave();
      showToast("Removed " + item.name + " from " + n + " mention" + (n === 1 ? "" : "s"), "ok");
      return;
    }
    tagDeleteArmId = key;
    btn.textContent = "Confirm?";
    btn.classList.add("armed");
    clearTimeout(tagDeleteArmTimer);
    tagDeleteArmTimer = setTimeout(function () {
      tagDeleteArmId = null;
      btn.textContent = "Remove label";
      btn.classList.remove("armed");
    }, 2800);
  }

  /* Deletes the tracked entry itself — only offered once an item is already
     orphaned (see tagEntityHtml). Shares the same arm/confirm state as
     armRemoveTag; the two buttons are never both on screen for one entity,
     so there's no collision. */
  function armDeleteTag(btn, key) {
    if (tagDeleteArmId === key) {
      clearTimeout(tagDeleteArmTimer);
      tagDeleteArmId = null;
      var item = findTagByKey(key);
      if (!item) return;
      deleteProductionTagEntry(item.cat.id, item.name);
      markDirty();
      render();
      queueAutoSave();
      showToast("Deleted " + item.name + " from the production list", "ok");
      return;
    }
    tagDeleteArmId = key;
    btn.textContent = "Confirm?";
    btn.classList.add("armed");
    clearTimeout(tagDeleteArmTimer);
    tagDeleteArmTimer = setTimeout(function () {
      tagDeleteArmId = null;
      btn.textContent = "Delete from list";
      btn.classList.remove("armed");
    }, 2800);
  }

  /* ---- the multi-select gesture and what it can do ---- */

  /* True on phones and tablets — a device with no hover has no modifier
     keys either, so the whole Ctrl/Shift+click scheme needs a touch
     translation: long-press a card to start selecting, then taps on card
     heads toggle until the selection is cleared. matchMedia rather than a
     user-agent sniff: it is the actual capability that matters. */
  var IS_TOUCH = window.matchMedia && window.matchMedia("(hover: none)").matches;

  function toggleCardSelection(key) {
    if (productionSelection[key]) delete productionSelection[key];
    else productionSelection[key] = true;
    selectionAnchorKey = key;
    bulkDeleteArmed = false;
    renderProduction();
  }

  /* Long-press on a breakdown card (touch only). Delegated on the list
     container, which survives re-renders; the cards themselves do not. */
  var touchPress = { timer: null, key: null, fired: false, x: 0, y: 0 };

  function cancelTouchPress() {
    if (touchPress.timer) { clearTimeout(touchPress.timer); touchPress.timer = null; }
  }

  function wireTouchSelection() {
    var list = document.getElementById("production-list");
    if (!list) return;

    list.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      var card = e.target.closest(".tag-entity");
      if (!card) return;
      /* not from inside the open card's own inputs — a long-press in the
         notes box is the OS text-selection gesture, leave it alone */
      if (e.target.closest(".tag-entity-detail, .tag-rename-input")) return;
      touchPress.key = card.getAttribute("data-key");
      touchPress.fired = false;
      touchPress.x = e.clientX; touchPress.y = e.clientY;
      cancelTouchPress();
      touchPress.timer = setTimeout(function () {
        touchPress.timer = null;
        touchPress.fired = true;   /* swallow the click that follows the release */
        toggleCardSelection(touchPress.key);
        if (navigator.vibrate) navigator.vibrate(10);
      }, 450);
    });

    /* finger drifting = scrolling, not pressing */
    list.addEventListener("pointermove", function (e) {
      if (!touchPress.timer) return;
      if (Math.abs(e.clientX - touchPress.x) > 10 || Math.abs(e.clientY - touchPress.y) > 10) cancelTouchPress();
    });
    list.addEventListener("pointerup", cancelTouchPress);
    list.addEventListener("pointercancel", cancelTouchPress);

    /* the browser fires a click after the pointer sequence regardless;
       if the long-press already acted, that click must die here */
    list.addEventListener("click", function (e) {
      if (touchPress.fired) {
        touchPress.fired = false;
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    /* Android's long-press context menu on the cards would race the gesture */
    list.addEventListener("contextmenu", function (e) {
      if (IS_TOUCH && e.target.closest(".tag-entity")) e.preventDefault();
    });
  }

  /* Consumes a modifier-click on a card. Returns true if it handled it, so
     the caller knows not to fall through to expanding the card. */
  function handleSelectionClick(e, card) {
    var key = card.getAttribute("data-key");
    if (!key) return false;
    /* visual order, read live — it is the order the range runs along, and it
       differs between the Category and Person groupings */
    var order = Array.prototype.map.call(
      document.querySelectorAll("#production-list .tag-entity"),
      function (el) { return el.getAttribute("data-key"); });
    var here = order.indexOf(key);
    if (here === -1) return false;

    var anchor = selectionAnchorKey ? order.indexOf(selectionAnchorKey) : -1;
    if (e.shiftKey && anchor !== -1) {
      var lo = Math.min(anchor, here), hi = Math.max(anchor, here);
      for (var i = lo; i <= hi; i++) productionSelection[order[i]] = true;
    } else {
      if (productionSelection[key]) delete productionSelection[key];
      else productionSelection[key] = true;
      selectionAnchorKey = key;
    }

    /* a Ctrl/Shift+click leaves a stray text selection across the card */
    var sel = window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    bulkDeleteArmed = false;
    renderProduction();
    return true;
  }

  /* Every bulk action resolves keys to registry entries first and skips any
     that no longer resolve, so a stale key can never write to the wrong item. */
  function selectedEntries(entries) {
    var byKey = {};
    (entries || productionEntries()).forEach(function (e) { byKey[e.key] = e; });
    return selectedKeys().map(function (k) { return byKey[k]; }).filter(Boolean);
  }

  function bulkSetOwner(personId) {
    var items = selectedEntries();
    if (!items.length) return;
    var owner = personById(personId) ? personId : "";
    var n = 0;
    items.forEach(function (item) {
      var entry = registryEntry(item.cat.id, item.name);
      if (!entry || entry.owner === owner) return;
      entry.owner = owner;
      n++;
    });
    if (!n) { renderProduction(); return; }
    markDirty();
    renderProduction();
    queueAutoSave();
    var who = personById(personId);
    showToast(who ? ("Assigned " + n + " item" + (n === 1 ? "" : "s") + " to " + who.name)
                  : ("Unassigned " + n + " item" + (n === 1 ? "" : "s")), "ok");
  }

  function bulkSetStatus(statusId) {
    var items = selectedEntries();
    if (!items.length) return;
    var want = (tagStatus(statusId) || TAG_STATUSES[0]);
    var n = 0;
    items.forEach(function (item) {
      var entry = registryEntry(item.cat.id, item.name);
      if (!entry || entry.status === want.id) return;
      entry.status = want.id;
      n++;
    });
    if (!n) { renderProduction(); return; }
    markDirty();
    renderProduction();
    queueAutoSave();
    showToast("Marked " + n + " item" + (n === 1 ? "" : "s") + " " + want.label, "ok");
  }

  function bulkAddPerson() {
    var input = document.getElementById("bulk-person-input");
    if (!input) return;
    var id = findOrAddPerson(input.value);
    tagAddingPersonFor = null;
    if (!id) { renderProduction(); return; }
    bulkSetOwner(id);
  }

  /* One Delete rather than the card's two-step Remove label / Delete from
     list, because in bulk the two-step is the wrong shape: a selection is
     usually a mix of live and orphaned items, and removing only the registry
     entry of a live one is a no-op — productionEntries() self-heals it
     straight back from the script. So this strips the labels too, and the
     armed button says how many of the script's labels are about to go. */
  function bulkDeleteSelected() {
    var items = selectedEntries();
    if (!items.length) return;
    var unlabelled = 0;
    items.forEach(function (item) {
      if (!item.orphaned) unlabelled += removeTag(item.cat.id, item.name);
      deleteProductionTagEntry(item.cat.id, item.name);
    });
    var n = items.length;
    clearProductionSelection();
    markDirty();
    render();
    queueAutoSave();
    showToast("Deleted " + n + " item" + (n === 1 ? "" : "s") +
      (unlabelled ? " and removed " + unlabelled + " label" + (unlabelled === 1 ? "" : "s") +
        " from the script" : ""), "ok");
  }

  function bulkCountsLabel(items) {
    var live = 0;
    items.forEach(function (i) { if (!i.orphaned) live += i.mentions.length; });
    return live;
  }

  /* The bar exists only while a selection does, and only in the two groupings
     that draw cards — Scene shows pills and Shoot shows the day's needs, and
     neither has anything to select. */
  function renderBulkBar(entries) {
    var bar = document.getElementById("production-bulk");
    if (!bar) return;
    var items = selectedEntries(entries);
    var cardView = productionGroupBy === "cat" || productionGroupBy === "person";
    if (!items.length || !cardView) { bar.hidden = true; bar.innerHTML = ""; return; }

    var n = items.length;
    var liveMentions = bulkCountsLabel(items);
    bar.hidden = false;
    bar.innerHTML =
      '<div class="bulk-row">' +
        '<span class="bulk-count">' + n + ' selected</span>' +
        '<select class="bulk-select" id="bulk-owner" aria-label="Assign the selected items to">' +
          '<option value="__none__" selected>Assign to…</option>' +
          '<option value="">Unassigned</option>' +
          state.people.map(function (p) {
            return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>';
          }).join("") +
        '</select>' +
        '<button type="button" class="bulk-btn" data-action="bulk-person-new" ' +
          'title="Add someone to the crew list and assign these to them">+ Person</button>' +
        '<select class="bulk-select" id="bulk-status" aria-label="Set the status of the selected items">' +
          '<option value="__none__" selected>Status…</option>' +
          TAG_STATUSES.map(function (s) {
            return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.label) + '</option>';
          }).join("") +
        '</select>' +
        '<button type="button" class="bulk-btn danger' + (bulkDeleteArmed ? ' armed' : '') + '" ' +
          'data-action="bulk-delete">' +
          (bulkDeleteArmed
            ? 'Delete ' + n + (liveMentions ? ' + ' + liveMentions + ' label' +
                (liveMentions === 1 ? '' : 's') : '') + '?'
            : 'Delete') +
        '</button>' +
        '<button type="button" class="bulk-clear" data-action="bulk-clear" ' +
          'title="Clear the selection (Esc)" aria-label="Clear the selection">×</button>' +
      '</div>' +
      (tagAddingPersonFor === "__bulk__"
        ? '<div class="bulk-row bulk-person-row">' +
            '<input type="text" id="bulk-person-input" placeholder="Their name" maxlength="60">' +
            '<button type="button" class="bulk-btn" data-action="bulk-person-save">Add</button>' +
            '<button type="button" class="bulk-btn" data-action="bulk-person-cancel">Cancel</button>' +
          '</div>'
        : '') +
      (bulkDeleteArmed
        ? '<div class="bulk-note">Removes ' + n + ' item' + (n === 1 ? '' : 's') +
            ' from the breakdown' +
            (liveMentions ? ', and their labels from the script — the words stay, the labels go' : '') +
            '. Click again to confirm.</div>'
        : '<div class="bulk-note">' + (IS_TOUCH
            ? 'Tap a card to add or drop it · long-press started this'
            : 'Ctrl+click a card to add or drop it · Shift+click for a run') + '</div>');
  }

  /* ---- assigning people and keeping notes ---- */

  /* `statusId` null means "advance one step" — the pill in the card head —
     otherwise it is the exact state the segmented control asked for. Both go
     through here so there is one place that writes it. */
  function setTagStatus(key, statusId) {
    var item = findTagByKey(key);
    if (!item) return;
    var entry = registryEntry(item.cat.id, item.name);
    if (!entry) return;
    var want = statusId === null
      ? nextTagStatus(entry.status)
      : (tagStatus(statusId) || TAG_STATUSES[0]).id;
    if (entry.status === want) return;
    entry.status = want;
    markDirty();
    renderProduction();
    queueAutoSave();
  }

  function setTagOwner(key, personId) {
    var item = findTagByKey(key);
    if (!item) return;
    var entry = registryEntry(item.cat.id, item.name);
    if (!entry) return;
    entry.owner = personById(personId) ? personId : "";
    markDirty();
    renderProduction();
    queueAutoSave();
  }

  /* Called on every keystroke in the notes box, so it deliberately does NOT
     re-render — that would blow the textarea away mid-sentence. The panel
     redraws on its own the next time something else changes it. */
  function setTagNotes(key, text) {
    var item = findTagByKey(key);
    if (!item) return;
    var entry = registryEntry(item.cat.id, item.name);
    if (!entry) return;
    var clean = plainText(text).slice(0, 2000);
    if (entry.notes === clean) return;
    entry.notes = clean;
    markDirty();
  }

  function addPersonForTag(key) {
    var input = document.querySelector('.tag-person-input[data-key="' + cssAttr(key) + '"]');
    if (!input) return;
    var id = findOrAddPerson(input.value);
    tagAddingPersonFor = null;
    if (!id) { renderProduction(); return; }
    var item = findTagByKey(key);
    var entry = item && registryEntry(item.cat.id, item.name);
    if (entry) entry.owner = id;
    markDirty();
    renderProduction();
    queueAutoSave();
  }

  function armPersonDelete(btn, personId) {
    if (tagDeleteArmId === "person:" + personId) {
      clearTimeout(tagDeleteArmTimer);
      tagDeleteArmId = null;
      var person = personById(personId);
      deletePerson(personId);
      markDirty();
      renderProduction();
      queueAutoSave();
      showToast("Removed " + (person ? person.name : "that person") +
        " — their items are now unassigned", "ok");
      return;
    }
    tagDeleteArmId = "person:" + personId;
    btn.textContent = "Confirm?";
    btn.classList.add("armed");
    clearTimeout(tagDeleteArmTimer);
    tagDeleteArmTimer = setTimeout(function () {
      tagDeleteArmId = null;
      btn.textContent = "×";
      btn.classList.remove("armed");
    }, 2800);
  }

  function saveTagRename(key) {
    var input = document.querySelector('.tag-rename-input[data-key="' + cssAttr(key) + '"]');
    var item = findTagByKey(key);
    if (!input || !item) { tagRenaming = null; renderProduction(); return; }
    var changed = renameTag(item.cat.id, item.name, input.value);
    tagRenaming = null;
    if (changed) {
      markDirty();
      render();
      queueAutoSave();
      showToast("Renamed to " + plainText(input.value).trim(), "ok");
    } else {
      renderProduction();
    }
  }

  /* ---- the breakdown, for exports ---- */

  function breakdownRows() {
    var out = [];
    tagsByCategory().forEach(function (g) {
      g.items.forEach(function (item) {
        var scenes = [];
        var seen = {};
        item.mentions.forEach(function (m) {
          if (seen[m.rowIndex]) return;
          seen[m.rowIndex] = true;
          scenes.push(pad2(m.rowIndex + 1));
        });
        var owner = personById(item.owner);
        var st = tagStatus(item.status) || TAG_STATUSES[0];
        out.push({
          category: g.cat.plural,
          categoryLabel: g.cat.label,
          name: item.name,
          mentions: item.mentions.length,
          owner: owner ? owner.name : "",
          status: st.id,
          statusLabel: st.label,
          notes: item.notes || "",
          inScript: item.orphaned ? "no" : "yes",
          /* still worth exporting rather than silently dropping — a props
             master reading this later should see it was tracked, not just
             lose it — but flagged rather than left looking like a scene list */
          scenes: item.orphaned ? ["not in script"] : scenes
        });
      });
    });
    return out;
  }

  /* One flat sheet with a Category column rather than a file per list: it
     filters or pivots into a props list, a graphics list or one person's
     pull list in a couple of clicks, and stays a single thing to send. */
  function buildBreakdownCsv() {
    var lines = [["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "In script", "Notes"].join(",")];
    breakdownRows().forEach(function (r) {
      lines.push([
        csvEscape(r.categoryLabel),
        csvEscape(r.name),
        csvEscape(r.statusLabel),
        csvEscape(r.owner),
        csvEscape(r.mentions),
        csvEscape(r.scenes.join(" ")),
        csvEscape(r.inScript),
        csvEscape(r.notes)
      ].join(","));
    });
    if (lines.length === 1) lines.push(csvEscape("(nothing labelled yet)"));
    return "﻿" + lines.join("\r\n");
  }
