import type { ButtonActions } from "../../application/actions.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";
import { prepContext } from "./outline.ts";

type TagEvent = MouseEvent & { readonly target: HTMLElement & { value: string }; readonly key: string; readonly pointerType: string };
interface EntityPorts {
  readonly rootClick: (e: MouseEvent) => void;
  readonly renderProduction: () => void;
  readonly saveTagRename: (key: string | null, value: string) => string | null | undefined;
  readonly addPersonForTag: (key: string | null, value: string) => void;
  readonly setRenaming: (value: string | null) => void;
  readonly setAddingPerson: (value: string | null) => void;
  readonly setTagOwner: (key: string | null, value: string) => void;
  readonly setTagNotes: (key: string | null, value: string) => void;
  readonly queueAutoSave: () => void;
}
export interface TagsPorts extends EntityPorts, Pick<ButtonActions, "runFromButton"> {
  readonly clickProductionOutline: (e: MouseEvent) => boolean;
  readonly changeProductionOutline: (target: HTMLElement) => void;
  readonly revealProductionItem: (rowId: string | null, key: string) => void;
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
  readonly capture: () => () => boolean;
  readonly installEntity: (id: string) => () => void;
}
export interface TagsRoutes {
  readonly jumpClick: (e: MouseEvent) => boolean;
  readonly click: (e: MouseEvent) => boolean;
  readonly anchorMouseDown: (e: MouseEvent) => void;
  readonly dispose: () => void;
}

function cardFocus(origin: Element): (selector: string, key?: string | null) => void {
  const panel = origin.closest("#production-panel, #gear-panel");
  const originalCard = origin.closest(".tag-entity");
  const scene = origin.closest("[data-scene-group]")?.getAttribute("data-scene-group");
  const context = originalCard?.getAttribute("data-prep-context");
  const originalKey = originalCard?.getAttribute("data-key");
  return (selector, key) => {
    if (!panel || !originalCard) return;
    const target = key ?? originalKey;
    const wanted = context && target ? retargetPrepContext(context, target) : context;
    const scope = scene ? Array.from(panel.querySelectorAll("[data-scene-group]")).find(el => el.getAttribute("data-scene-group") === scene) : panel;
    const card = Array.from(scope?.querySelectorAll(".tag-entity") ?? []).find(el =>
      el.getAttribute("data-key") === target && (!wanted || el.getAttribute("data-prep-context") === wanted));
    card?.querySelector<HTMLElement>(selector)?.focus();
  };
}

function retargetPrepContext(context: string, key: string): string {
  const [container] = JSON.parse(context) as [string];
  return prepContext(container, key);
}

export function mountTagEntityContainer(mount: { window: Window; id: string; ports: EntityPorts }): () => void {
  const doc = mount.window.document;
  const ports = mount.ports;
  const el = doc.getElementById(mount.id);
  const life = createViewLifetime(mount.window, () => true);
  const { listen } = life;
  listen(el, "click", ports.rootClick);
  listen(el, "keydown", function (e) {
    if (!e.target.classList) return;
    if (e.target.classList.contains("tag-rename-input")) {
      if (e.key === "Enter") {
        e.preventDefault();
        const refocus = cardFocus(e.target);
        const key = ports.saveTagRename(e.target.getAttribute("data-key"), e.target.value);
        refocus('.tag-entity-head, [data-prep="notes"]', key);
      }
      else if (e.key === "Escape") { e.preventDefault(); ports.setRenaming(null); ports.renderProduction(); }
      return;
    }
    if (e.target.classList.contains("tag-person-input")) {
      if (e.key === "Enter") { e.preventDefault(); const refocus = cardFocus(e.target); ports.addPersonForTag(e.target.getAttribute("data-key"), e.target.value); refocus('[data-action="tag-person-new"]'); }
      else if (e.key === "Escape") { e.preventDefault(); const refocus = cardFocus(e.target); ports.setAddingPerson(null); ports.renderProduction(); refocus('[data-action="tag-person-new"]'); }
    }
  });
  listen(el, "change", function (e) {
    if (e.target.classList && e.target.classList.contains("tag-owner-select")) {
      ports.setTagOwner(e.target.getAttribute("data-key"), e.target.value);
    }
  });
  listen(el, "input", function (e) {
    if (e.target.classList && e.target.classList.contains("tag-notes-input")) {
      ports.setTagNotes(e.target.getAttribute("data-key"), e.target.value);
    }
  });
  listen(el, "focusout", function (e) {
    if (e.target.classList && e.target.classList.contains("tag-notes-input")) ports.queueAutoSave();
  });
  return life.dispose;
}
export function mountTags(mount: { window: Window; ports: TagsPorts }): TagsRoutes {
  const realm = mount.window as Window & typeof globalThis;
  const doc = realm.document;
  const ports = mount.ports;
  const life = createViewLifetime(mount.window, () => true);
  const { listen } = life;
  const timers = new Set<number>();
  const touchPress = { timer: null as number | null, key: null as string | null, fired: false, x: 0, y: 0 };
  function cancelTouchPress(): void {
    if (touchPress.timer !== null) realm.clearTimeout(touchPress.timer);
    touchPress.timer = null;
  }
  const list = doc.getElementById("production-list");
  if (list) {
    listen(list, "pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      const card = e.target.closest(".tag-entity");
      if (!card) return;
      if (e.target.closest(".tag-entity-detail, .prep-resource-detail, .tag-rename-input")) return;
      touchPress.key = card.getAttribute("data-key");
      touchPress.fired = false;
      touchPress.x = e.clientX; touchPress.y = e.clientY;
      cancelTouchPress();
      const owns = ports.capture();
      touchPress.timer = realm.setTimeout(function () {
        if (!life.active() || !owns() || !card.isConnected) return;
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
  life.release(ports.installEntity("production-panel"));
  listen(doc.getElementById("production-panel"), "keydown", function (e) {
    if (!e.target.classList) return;
    if (e.target.id === "bulk-person-input") {
      if (e.key === "Enter") { e.preventDefault(); ports.bulkAddPerson(); }
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
    ports.changeProductionOutline(e.target);
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
  life.release(ports.installEntity("gear-panel"));
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
      if (!life.active()) return false;
      const e = event as TagEvent;
      const jumpTagBtn = e.target.closest('[data-action="jump-tag"]');
      if (jumpTagBtn) {
        ports.jumpToTag(jumpTagBtn.getAttribute("data-row"), jumpTagBtn.getAttribute("data-key"));
        return true;
      }


      return false;
    },
    click(event): boolean {
      if (!life.active()) return false;
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

      if (ports.clickProductionOutline(e)) return true;

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
        const scene = personNewBtn.closest("[data-scene-group]")?.getAttribute("data-scene-group");
        const panel = personNewBtn.closest("#production-panel, #gear-panel");
        ports.setAddingPerson(personNewBtn.getAttribute("data-key"));
        ports.renderProduction();
        const scope = scene ? panel?.querySelector('[data-scene-group="' + ports.cssAttr(scene) + '"]') : panel;
        const newInput = scope?.querySelector<HTMLElement>('.tag-person-input[data-key="' +
        ports.cssAttr(ports.addingPerson()) + '"]');
        if (newInput) newInput.focus();
        return true;
      }

      const personSaveBtn = e.target.closest('[data-action="tag-person-save"]');
      if (personSaveBtn) {
        const input = personSaveBtn.closest(".tag-entity")?.querySelector<HTMLInputElement>(".tag-person-input");
        if (input) { const refocus = cardFocus(personSaveBtn); ports.addPersonForTag(personSaveBtn.getAttribute("data-key"), input.value); refocus('[data-action="tag-person-new"]'); }
        return true;
      }

      const personCancelBtn = e.target.closest('[data-action="tag-person-cancel"]');
      if (personCancelBtn) { const refocus = cardFocus(personCancelBtn); ports.setAddingPerson(null); ports.renderProduction(); refocus('[data-action="tag-person-new"]'); return true; }

      const personDeleteBtn = e.target.closest('[data-action="person-delete"]');
      if (personDeleteBtn) { ports.armPersonDelete(personDeleteBtn, personDeleteBtn.getAttribute("data-person")); return true; }

      const groupBtn = e.target.closest("#production-modes [data-group]");
      if (groupBtn) {
        ports.setProductionGroup(groupBtn.getAttribute("data-group"));
        if (!["cat", "person", "prep"].includes(ports.productionGroup())) ports.clearProductionSelection();
        const picker = groupBtn.closest("details");
        if (picker) picker.open = false;
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
      if (tagRenameSave) {
        const input = tagRenameSave.closest(".tag-entity")?.querySelector<HTMLInputElement>(".tag-rename-input");
        if (input) {
          const refocus = cardFocus(tagRenameSave);
          const key = ports.saveTagRename(tagRenameSave.getAttribute("data-key"), input.value);
          refocus('.tag-entity-head, [data-prep="notes"]', key);
        }
        return true;
      }

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
      if (!life.active()) return;
      const e = event as TagEvent;
      const tagEl = e.target.closest(".tag-anchor");
      if (tagEl) {
        const key = ports.tagKey(tagEl.getAttribute("data-tag-cat"), tagEl.getAttribute("data-tag-name"));
        if (ports.productionGroup() === "scene") ports.setProductionGroup("cat");
        ports.setExpanded(key);
        const owns = ports.capture();
        const panel = doc.getElementById("production-panel");
        ports.openProductionPanel();
        ports.revealProductionItem(tagEl.closest(".row")?.getAttribute("data-id") ?? null, key);
        const timer = realm.setTimeout(function () {
          timers.delete(timer);
          if (!life.active() || !owns() || !panel?.isConnected || doc.getElementById("production-panel") !== panel) return;
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
      if (!life.active()) return;
      life.dispose();
      cancelTouchPress();
      touchPress.fired = false;
      touchPress.key = null;
      timers.forEach((timer) => realm.clearTimeout(timer));
      timers.clear();
    }
  };
}
