type TagEvent = MouseEvent & { readonly target: HTMLElement & { value: string }; readonly key: string; readonly pointerType: string };
interface EntityPorts {
  readonly rootClick: (e: MouseEvent) => void;
  readonly reviewMode: () => boolean;
  readonly reviewBlocked: () => void;
  readonly renderProduction: () => void;
  readonly saveTagRename: (key: string | null) => void;
  readonly addPersonForTag: (key: string | null) => void;
  readonly setRenaming: (value: string | null) => void;
  readonly setAddingPerson: (value: string | null) => void;
  readonly setTagOwner: (key: string | null, value: string) => void;
  readonly setTagNotes: (key: string | null, value: string) => void;
  readonly queueAutoSave: () => void;
}
export interface TagsPorts extends EntityPorts {
  readonly acceptTagGhost: () => void;
  readonly acceptUntaggedMention: () => void;
  readonly applyTag: () => void;
  readonly armBulkDelete: () => void;
  readonly clearProductionSelection: () => void;
  readonly closeTagComposer: () => void;
  readonly disarmBulkDelete: () => void;
  readonly hideTagGhost: () => void;
  readonly hideUntaggedPrompt: () => void;
  readonly bulkDeleteSelected: () => void;
  readonly bulkAddPerson: () => void;
  readonly closeGearPanel: () => void;
  readonly closeProductionPanel: () => void;
  readonly openProductionPanel: () => void;
  readonly renderGearList: () => void;
  readonly applyGearQuickAdd: () => void;
  readonly closePlainTag: () => void;
  readonly refreshPlainTag: () => void;
  readonly tagAllMentions: (key: string | null) => void;
  readonly renderTagCategories: (key: string | null) => void;
  readonly armPersonDelete: (button: Element, key: string | null) => void;
  readonly armRemoveTag: (button: Element, key: string | null) => void;
  readonly armDeleteTag: (button: Element, key: string | null) => void;
  readonly selectedKeys: () => readonly string[];
  readonly plainTagOpen: () => boolean;
  readonly bulkDeleteArmed: () => boolean;
  readonly isTouch: () => boolean;
  readonly addingPerson: () => string | null;
  readonly expanded: () => string | null;
  readonly productionGroup: () => string;
  readonly setExpanded: (value: string | null) => void;
  readonly setProductionGroup: (value: string | null) => void;
  readonly setGearGroup: (value: string | null) => void;
  readonly setTagStatus: (key: string | null, status: string | null) => void;
  readonly bulkSetOwner: (value: string) => void;
  readonly bulkSetStatus: (value: string) => void;
  readonly handleSelectionClick: (e: MouseEvent, card: Element) => boolean;
  readonly jumpToTag: (row: string | null, key: string | null) => void;
  readonly toggleCardSelection: (key: string | null) => void;
  readonly tagKey: (cat: string | null, name: string | null) => string;
  readonly cssAttr: (value: string | null) => string;
  readonly exportAs: (format: string) => void;
  readonly runExport: (format: string) => void;
  readonly runFromButton: (action: string) => void;
  readonly capture: () => () => boolean;
  readonly installEntity: (id: string) => () => void;
}
export interface TagsRoutes {
  readonly jumpClick: (e: MouseEvent) => boolean;
  readonly click: (e: MouseEvent) => boolean;
  readonly anchorMouseDown: (e: MouseEvent) => void;
  readonly dispose: () => void;
}
function listeners() {
  const releases: (() => void)[] = [];
  function listen(target: EventTarget | null, type: string, fn: (e: TagEvent) => void, capture = false): void {
    if (!target) return;
    const handler = fn as EventListener;
    target.addEventListener(type, handler, capture);
    releases.push(() => target.removeEventListener(type, handler, capture));
  }
  return { listen, releases };
}
function isTagField(t: HTMLElement): boolean {
  return !!t.classList && (t.classList.contains("tag-owner-select") || t.classList.contains("tag-notes-input") ||
  t.classList.contains("tag-rename-input") || t.classList.contains("tag-person-input"));
}
export function mountTagEntityContainer(mount: { window: Window; id: string; ports: EntityPorts }): () => void {
  const doc = mount.window.document;
  const ports = mount.ports;
  const el = doc.getElementById(mount.id);
  const { listen, releases } = listeners();
  listen(el, "click", ports.rootClick);
  listen(el, "keydown", function (e) {
    if (!e.target.classList) return;
    if (ports.reviewMode() && e.key === "Enter" &&
    (e.target.classList.contains("tag-rename-input") || e.target.classList.contains("tag-person-input"))) {
      e.preventDefault();
      ports.reviewBlocked();
      ports.renderProduction();
      return;
    }
    if (e.target.classList.contains("tag-rename-input")) {
      if (e.key === "Enter") { e.preventDefault(); ports.saveTagRename(e.target.getAttribute("data-key")); }
      else if (e.key === "Escape") { e.preventDefault(); ports.setRenaming(null); ports.renderProduction(); }
      return;
    }
    if (e.target.classList.contains("tag-person-input")) {
      if (e.key === "Enter") { e.preventDefault(); ports.addPersonForTag(e.target.getAttribute("data-key")); }
      else if (e.key === "Escape") { e.preventDefault(); ports.setAddingPerson(null); ports.renderProduction(); }
    }
  });
  listen(el, "change", function (e) {
    if (ports.reviewMode()) {
      if (isTagField(e.target)) { ports.reviewBlocked(); ports.renderProduction(); }
      return;
    }
    if (e.target.classList && e.target.classList.contains("tag-owner-select")) {
      ports.setTagOwner(e.target.getAttribute("data-key"), e.target.value);
    }
  });
  listen(el, "input", function (e) {
    if (ports.reviewMode()) {
      if (isTagField(e.target)) { ports.reviewBlocked(); ports.renderProduction(); }
      return;
    }
    if (e.target.classList && e.target.classList.contains("tag-notes-input")) {
      ports.setTagNotes(e.target.getAttribute("data-key"), e.target.value);
    }
  });
  listen(el, "focusout", function (e) {
    if (ports.reviewMode()) return;
    if (e.target.classList && e.target.classList.contains("tag-notes-input")) ports.queueAutoSave();
  });
  return () => { releases.splice(0).reverse().forEach((release) => release()); };
}
export function mountTags(mount: { window: Window; ports: TagsPorts }): TagsRoutes {
  const realm = mount.window as Window & typeof globalThis;
  const doc = realm.document;
  const ports = mount.ports;
  const { listen, releases } = listeners();
  const timers = new Set<number>();
  let open = true;
  const touchPress = { timer: null as number | null, key: null as string | null, fired: false, x: 0, y: 0 };
  function cancelTouchPress(): void {
    if (touchPress.timer !== null) realm.clearTimeout(touchPress.timer);
    touchPress.timer = null;
  }
  const list = doc.getElementById("production-list");
  if (list) {
    listen(list, "pointerdown", function (e) {
      if (e.pointerType === "mouse" || ports.reviewMode()) return;
      const card = e.target.closest(".tag-entity");
      if (!card) return;
      if (e.target.closest(".tag-entity-detail, .tag-rename-input")) return;
      touchPress.key = card.getAttribute("data-key");
      touchPress.fired = false;
      touchPress.x = e.clientX; touchPress.y = e.clientY;
      cancelTouchPress();
      const owns = ports.capture();
      touchPress.timer = realm.setTimeout(function () {
        if (!open || !owns() || !card.isConnected) return;
        touchPress.timer = null;
        touchPress.fired = true;
        ports.toggleCardSelection(touchPress.key || "");
        if (realm.navigator.vibrate) realm.navigator.vibrate(10);
      }, 450);
    });

    listen(list, "pointermove", function (e) {
      if (!touchPress.timer) return;
      if (Math.abs(e.clientX - touchPress.x) > 10 || Math.abs(e.clientY - touchPress.y) > 10) cancelTouchPress();
    });
    listen(list, "pointerup", cancelTouchPress);
    listen(list, "pointercancel", cancelTouchPress);

    listen(list, "click", function (e) {
      if (touchPress.fired) {
        touchPress.fired = false;
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    listen(list, "contextmenu", function (e) {
      if (ports.isTouch() && e.target.closest(".tag-entity")) e.preventDefault();
    });
  }
  const ghostEl = doc.getElementById("tag-ghost");
  if (ghostEl) listen(ghostEl, "pointerdown", function (e) {
    e.preventDefault();
    ports.acceptTagGhost();
  });
  const openHintEl = doc.getElementById("tag-open-hint");
  if (openHintEl) listen(openHintEl, "pointerdown", function (e) {
    e.preventDefault();
    if (ports.plainTagOpen()) ports.closePlainTag();
  });

  listen(realm, "scroll", ports.hideTagGhost, true);
  listen(realm, "resize", ports.hideTagGhost);
  listen(realm, "scroll", ports.hideUntaggedPrompt, true);
  listen(realm, "resize", ports.hideUntaggedPrompt);
  listen(realm, "scroll", ports.refreshPlainTag, true);
  listen(realm, "resize", ports.refreshPlainTag);

  const suggestEl = doc.getElementById("tag-suggest");
  listen(suggestEl, "mousedown", function (e) { e.preventDefault(); });
  listen(suggestEl, "click", function () { ports.acceptUntaggedMention(); });

  listen(doc.getElementById("btn-production"), "click", function () { ports.runFromButton("panel-production"); });
  listen(doc.getElementById("production-close"), "click", ports.closeProductionPanel);
  releases.push(ports.installEntity("production-panel"));
  listen(doc.getElementById("production-panel"), "keydown", function (e) {
    if (!e.target.classList) return;
    if (e.target.id === "bulk-person-input") {
      if (e.key === "Enter" && ports.reviewMode()) { e.preventDefault(); ports.reviewBlocked(); ports.renderProduction(); }
      else if (e.key === "Enter") { e.preventDefault(); ports.bulkAddPerson(); }
      else if (e.key === "Escape") { e.preventDefault(); ports.setAddingPerson(null); ports.renderProduction(); }
      return;
    }
    if (e.target.classList.contains("tag-rename-input") || e.target.classList.contains("tag-person-input")) return;
    if (e.key === "Escape" && ports.selectedKeys().length) {
      e.preventDefault();
      ports.clearProductionSelection();
      ports.renderProduction();
    }
  });
  listen(doc.getElementById("production-panel"), "change", function (e) {
    if (ports.reviewMode()) {
      if (e.target.id === "bulk-owner" || e.target.id === "bulk-status") { ports.reviewBlocked(); ports.renderProduction(); }
      return;
    }
    if (e.target.id === "bulk-owner") {
      if (e.target.value !== "__none__") ports.bulkSetOwner(e.target.value);
      return;
    }
    if (e.target.id === "bulk-status") {
      if (e.target.value !== "__none__") ports.bulkSetStatus(e.target.value);
    }
  });

  listen(doc.getElementById("btn-gear"), "click", function () { ports.runFromButton("panel-gear"); });
  listen(doc.getElementById("gear-close"), "click", ports.closeGearPanel);
  releases.push(ports.installEntity("gear-panel"));
  listen(doc.getElementById("gear-modes"), "click", function (e) {
    const btn = e.target.closest("[data-group]");
    if (!btn) return;
    ports.setGearGroup(btn.getAttribute("data-group"));
    ports.renderGearList();
  });
  listen(doc.getElementById("gear-quickadd-save"), "click", ports.applyGearQuickAdd);

  listen(doc.getElementById("tag-modal"), "click", ports.rootClick);
  listen(doc.getElementById("tag-close"), "click", ports.closeTagComposer);
  listen(doc.getElementById("tag-cancel"), "click", ports.closeTagComposer);
  listen(doc.getElementById("tag-apply"), "click", ports.applyTag);
  listen(doc.getElementById("tag-modal"), "click", function (e) {
    if (e.target.id === "tag-modal") ports.closeTagComposer();
  });
  listen(doc.getElementById("tag-name"), "keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); ports.applyTag(); }
  });
  listen(realm, "keydown", function (e) {
    if (e.key === "Escape" && doc.getElementById("tag-modal")?.hidden === false) ports.closeTagComposer();
  });


  return {
    jumpClick(event): boolean {
      if (!open) return false;
      const e = event as TagEvent;
      const jumpTagBtn = e.target.closest('[data-action="jump-tag"]');
      if (jumpTagBtn) {
        ports.jumpToTag(jumpTagBtn.getAttribute("data-row"), jumpTagBtn.getAttribute("data-key"));
        return true;
      }


      return false;
    },
    click(event): boolean {
      if (!open) return false;
      const e = event as TagEvent;
      const selCard = (e.ctrlKey || e.metaKey || e.shiftKey)
      ? e.target.closest("#production-list .tag-entity") : null;
      if (selCard && ports.handleSelectionClick(e, selCard)) { e.preventDefault(); return true; }

      if (ports.isTouch() && ports.selectedKeys().length) {
        const touchRow = e.target.closest("#production-list .tag-entity-row");
        if (touchRow) {
          ports.toggleCardSelection(touchRow.closest(".tag-entity")?.getAttribute("data-key") || null);
          return true;
        }
      }

      const bulkClear = e.target.closest('[data-action="bulk-clear"]');
      if (bulkClear) { ports.clearProductionSelection(); ports.renderProduction(); return true; }

      const bulkDel = e.target.closest('[data-action="bulk-delete"]');
      if (bulkDel) {
        if (ports.bulkDeleteArmed()) { ports.disarmBulkDelete(); ports.bulkDeleteSelected(); }
        else { ports.armBulkDelete(); ports.renderProduction(); }
        return true;
      }

      const bulkPersonNew = e.target.closest('[data-action="bulk-person-new"]');
      if (bulkPersonNew) {
        ports.setAddingPerson("__bulk__");
        ports.renderProduction();
        const bpi = doc.getElementById("bulk-person-input");
        if (bpi) bpi.focus();
        return true;
      }

      const bulkPersonSave = e.target.closest('[data-action="bulk-person-save"]');
      if (bulkPersonSave) { ports.bulkAddPerson(); return true; }

      const bulkPersonCancel = e.target.closest('[data-action="bulk-person-cancel"]');
      if (bulkPersonCancel) { ports.setAddingPerson(null); ports.renderProduction(); return true; }

      const tagStatusCycle = e.target.closest('[data-action="tag-status-cycle"]');
      if (tagStatusCycle) { ports.setTagStatus(tagStatusCycle.getAttribute("data-key"), null); return true; }

      const tagStatusSet = e.target.closest('[data-action="tag-status-set"]');
      if (tagStatusSet) {
        ports.setTagStatus(tagStatusSet.getAttribute("data-key"), tagStatusSet.getAttribute("data-status"));
        return true;
      }

      const tagExpandBtn = e.target.closest('[data-action="tag-expand"]');
      if (tagExpandBtn) {
        const expandKey = tagExpandBtn.getAttribute("data-key");
        ports.setExpanded(ports.expanded() === expandKey ? null : expandKey);
        ports.setRenaming(null);
        ports.setAddingPerson(null);
        ports.renderProduction();
        return true;
      }

      const personNewBtn = e.target.closest('[data-action="tag-person-new"]');
      if (personNewBtn) {
        ports.setAddingPerson(personNewBtn.getAttribute("data-key"));
        ports.renderProduction();
        const newInput = doc.querySelector<HTMLElement>('.tag-person-input[data-key="' +
        ports.cssAttr(ports.addingPerson()) + '"]');
        if (newInput) newInput.focus();
        return true;
      }

      const personSaveBtn = e.target.closest('[data-action="tag-person-save"]');
      if (personSaveBtn) { ports.addPersonForTag(personSaveBtn.getAttribute("data-key")); return true; }

      const personCancelBtn = e.target.closest('[data-action="tag-person-cancel"]');
      if (personCancelBtn) { ports.setAddingPerson(null); ports.renderProduction(); return true; }

      const personDeleteBtn = e.target.closest('[data-action="person-delete"]');
      if (personDeleteBtn) { ports.armPersonDelete(personDeleteBtn, personDeleteBtn.getAttribute("data-person")); return true; }

      const groupBtn = e.target.closest("#production-modes [data-group]");
      if (groupBtn) {
        ports.setProductionGroup(groupBtn.getAttribute("data-group"));
        if (ports.productionGroup() !== "cat" && ports.productionGroup() !== "person") ports.clearProductionSelection();
        ports.renderProduction();
        return true;
      }

      const breakdownBtn = e.target.closest('[data-action="export-breakdown"]');
      if (breakdownBtn) { ports.exportAs("breakdown"); return true; }

      const packingGearBtn = e.target.closest('[data-action="export-packing-gear"]');
      if (packingGearBtn) { ports.runExport("export-packing-gear"); return true; }

      const tagRenameBtn = e.target.closest('[data-action="tag-rename"]');
      if (tagRenameBtn) { ports.setRenaming(tagRenameBtn.getAttribute("data-key")); ports.renderProduction(); return true; }

      const tagRenameSave = e.target.closest('[data-action="tag-rename-save"]');
      if (tagRenameSave) { ports.saveTagRename(tagRenameSave.getAttribute("data-key")); return true; }

      const tagRenameCancel = e.target.closest('[data-action="tag-rename-cancel"]');
      if (tagRenameCancel) { ports.setRenaming(null); ports.renderProduction(); return true; }

      const tagAllBtn = e.target.closest('[data-action="tag-all-mentions"]');
      if (tagAllBtn) { ports.tagAllMentions(tagAllBtn.getAttribute("data-key")); return true; }

      const tagRemoveBtn = e.target.closest('[data-action="tag-remove"]');
      if (tagRemoveBtn) { ports.armRemoveTag(tagRemoveBtn, tagRemoveBtn.getAttribute("data-key")); return true; }

      const tagDeleteBtn = e.target.closest('[data-action="tag-delete"]');
      if (tagDeleteBtn) { ports.armDeleteTag(tagDeleteBtn, tagDeleteBtn.getAttribute("data-key")); return true; }

      const catBtn = e.target.closest("#tag-cats .tag-cat-btn");
      if (catBtn) { ports.renderTagCategories(catBtn.getAttribute("data-tag-cat")); return true; }


      return false;
    },
    anchorMouseDown(event): void {
      if (!open) return;
      const e = event as TagEvent;
      const tagEl = e.target.closest(".tag-anchor");
      if (tagEl) {
        const key = ports.tagKey(tagEl.getAttribute("data-tag-cat"), tagEl.getAttribute("data-tag-name"));
        if (ports.productionGroup() === "scene") ports.setProductionGroup("cat");
        ports.setExpanded(key);
        const owns = ports.capture();
        const panel = doc.getElementById("production-panel");
        ports.openProductionPanel();
        const timer = realm.setTimeout(function () {
          timers.delete(timer);
          if (!open || !owns() || !panel?.isConnected || doc.getElementById("production-panel") !== panel) return;
          const card = doc.querySelector<HTMLElement>('.tag-entity[data-key="' + ports.cssAttr(key) + '"]');
          if (card) {
            card.scrollIntoView({ behavior: "smooth", block: "center" });
            card.classList.remove("flash");
            void card.offsetWidth;
            card.classList.add("flash");
          }
        }, 30);
        timers.add(timer);
      }
    },
    dispose(): void {
      if (!open) return;
      open = false;
      cancelTouchPress();
      touchPress.fired = false;
      touchPress.key = null;
      timers.forEach((timer) => realm.clearTimeout(timer));
      timers.clear();
      releases.splice(0).reverse().forEach((release) => release());
    }
  };
}
