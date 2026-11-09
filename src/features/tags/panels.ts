import { numberHtml } from "../common/number-html.ts";
import { groupItemsByScene } from "../../core/document/scene-items.ts";
import { prepContext, prepSceneKey, renderProductionOutline } from "./outline.ts";
import type { Person } from "../../core/production/records.ts";
import type { TagPanelPorts } from "./ports.ts";
import type { RemoveTagPorts } from "../../application/commands/production-actions.ts";
import type { TagChange, OwnerChoice } from "../../application/commands/production-records.ts";
import type { DeepReadonly, DocumentView } from "../../application/session/document-session.ts";
import type { PresentedProductionEntry } from "../../core/production/index.ts";
import type { TagCategoryLook } from "../../core/production/looks.ts";

type PanelTagStatus = (typeof TAG_STATUSES)[number];
type PanelRowStatus = (typeof ROW_STATUSES)[number];
type PanelTagMention = PresentedProductionEntry["mentions"][number];
type BeatMentionGroup = { m: PanelTagMention; n: number; visual: boolean; audio: boolean };
type PersonTagGroup = { id: string; label: string; items: PresentedProductionEntry[] };
type ShootTagGroup = { name: string; rows: number[]; needs: Record<string, PresentedProductionEntry>; needOrder: string[] };
type PanelProductionOwner = TagPanelPorts["production"];
type PanelReadonlyArgs<A extends readonly unknown[]> = { [K in keyof A]: DeepReadonly<A[K]> };
type PanelProductionRead<K extends keyof PanelProductionOwner> =
  (...args: PanelReadonlyArgs<Parameters<PanelProductionOwner[K]>>) => ReturnType<PanelProductionOwner[K]>;
type PanelQuickAddArgs<A extends readonly unknown[]> = {
  [K in keyof A]: K extends "0" ? DeepReadonly<A[K]> | null : K extends "3" ? A[K] | null : A[K]
};
type PanelQuickAddRead = (...args: PanelQuickAddArgs<Parameters<typeof planQuickAdd>>) => ReturnType<typeof planQuickAdd>;
type PanelNullableArgs<A extends readonly unknown[], K extends keyof A> = { [P in keyof A]: P extends K ? A[P] | null : A[P] };
type PanelNullableCall<F extends (...args: never[]) => unknown, K extends keyof Parameters<F>> =
  (...args: PanelNullableArgs<Parameters<F>, K>) => ReturnType<F>;
import { tagStatusLampHtml } from "../common/tag-status.ts";
import { nextTagStatus, normalizeTagName, tagKey } from "../../core/document/tags.ts";
import { formatDuration, rowSeconds } from "../../core/production/timing.ts";
import { ROW_STATUSES, rowStatus, TAG_CATEGORIES, TAG_STATUSES, groupTagsByCategory, tagStatus } from "../../core/production/looks.ts";
import { cssAttr } from "../common/dom.ts";
import { idMap } from "../../core/document/id-map.ts";
import { cappedLongText, cappedText, escapeHtml, plainText, safeId as safeIdFrom } from "../../core/document/text-policy.ts";
import { planQuickAdd } from "../../core/production/tags.ts";
import { addPersonCommand, deletePersonCommand, deleteTagsCommand, gearQuickAddCommand, tagCellsCommand, updateTagsCommand } from "../../application/commands/production-records.ts";
import { PERSON_NAME_MAX, personById as personIn, personNamed, registryEntryOf } from "../../core/production/records.ts";
import { retagMentions, retagRewrites } from "../../application/commands/tag-rewrites.ts";

import { removeTag, renameTag } from "../../application/commands/production-actions.ts";
import { rewrittenCopies } from "../../application/commands/document-edit.ts";


export let IS_TOUCH: boolean | undefined;

let ports: TagPanelPorts | null = null;
let tagEditPorts: RemoveTagPorts | null = null;

function safeId(id: unknown, prefix: string) {
  return safeIdFrom(id, prefix, (ports as TagPanelPorts).ids);
}

function productionEntries() {
  return ((ports as TagPanelPorts).production.entries as PanelProductionRead<"entries">)((ports as TagPanelPorts).document.current());
}

function currentProductionIndex() {
  return ((ports as TagPanelPorts).production.current as PanelProductionRead<"current">)((ports as TagPanelPorts).document.current());
}

function tagsByCategory(all?: readonly PresentedProductionEntry[]) {
  return groupTagsByCategory(all || productionEntries());
}

function registryEntry(cat: string, name: string) {
  return registryEntryOf((ports as TagPanelPorts).document.current(), cat, name);
}

function personById(id: string | null) {
  return personIn((ports as TagPanelPorts).document.current(), id);
}

export function openProductionPanel() {
  if (!(ports as TagPanelPorts).document.current()) return;
  syncGrouping(ports as TagPanelPorts);
  (ports as TagPanelPorts).panels.open("production-panel");
  renderProduction();
}

export function revealProductionItem(rowId: string | null, key: string): void {
  const p = ports as TagPanelPorts;
  if (p.view.productionGroupBy() !== "prep" || !rowId) return;
  const beat = p.document.numbering().beats[rowId];
  if (!beat) return;
  renderProduction();
  const rows = p.document.current()?.rows.slice(beat.scene.start, beat.scene.end) ?? [];
  const showFilmed = p.view.prep().current().filmed.has(prepSceneKey(beat.scene.id));
  const position = rows.filter(row => row.status !== "shot" || showFilmed || row.id === rowId).findIndex(row => row.id === rowId);
  p.view.prep().reveal(prepSceneKey(beat.scene.id), rowId, position, prepContext('beat:' + rowId, key));
  renderProduction();
}

function gearEntries() {
  return productionEntries().filter(function (e) { return e.cat.id === "gear"; });
}

export function openGearPanel() {
  if (!(ports as TagPanelPorts).document.current()) return;
  syncGrouping(ports as TagPanelPorts);
  (ports as TagPanelPorts).panels.open("gear-panel");
  fillGearQuickAdd();
  renderProduction();
}

function updateGearBadge(n: number) {
  const badge = document.getElementById("gear-badge");
  if (!badge) return;
  if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  else badge.hidden = true;
}

export function updateGearCount() {
  updateGearBadge((ports as TagPanelPorts).document.current() ? gearEntries().length : 0);
}

function updateProductionBadge(n: number) {
  const badge = document.getElementById("production-badge");
  if (!badge) return;
  if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  else badge.hidden = true;
}

export function updateProductionCount() {
  updateProductionBadge((ports as TagPanelPorts).document.current() ? productionEntries().length : 0);
}

export function productionPanelsOpen() {
  const panel = document.getElementById("production-panel");
  const gearPanel = document.getElementById("gear-panel");
  return !!((panel && !panel.hidden) || (gearPanel && !gearPanel.hidden));
}

function updateGearHeadCount(n: number) {
  const el = document.getElementById("gear-head-count");
  if (!el) return;
  el.hidden = !n;
  el.innerHTML = '<span class="panel-count">' + n + '</span> item' + (n === 1 ? '' : 's');
}

export function renderGearList() {
  const panel = document.getElementById("gear-panel");
  if (!panel || panel.hidden || !(ports as TagPanelPorts).document.current()) return;
  const listEl = document.getElementById("gear-list") as HTMLElement;
  const entries = gearEntries();
  updateGearBadge(entries.length);
  updateGearHeadCount(entries.length);

  document.querySelectorAll("#gear-modes [data-group]").forEach(function (b) {
    const on = b.getAttribute("data-group") === (ports as TagPanelPorts).view.gearGroupBy();
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });

  if (!entries.length) {
    listEl.innerHTML = '<div class="comments-empty">No gear tracked yet.<br><br>' +
      'Type <code>&lt;a lens&gt;</code> straight into the script, select words and ' +
      'press <strong>Tag</strong>, or just list it below — gear doesn’t have to be ' +
      'written into a beat to be tracked.</div>';
    return;
  }

  if ((ports as TagPanelPorts).view.gearGroupBy() === "by-scene") {
    listEl.innerHTML = renderProductionByScene(entries, true);
    return;
  }
  if ((ports as TagPanelPorts).view.gearGroupBy() === "scene") {
    const untracked = entries.filter(function (e) { return e.orphaned; }).length;
    listEl.innerHTML = renderProductionByBeat(entries.filter(function (e) { return !e.orphaned; })) +
      (untracked ? '<div class="tag-orphan-note">' + untracked +
        (untracked === 1 ? " item isn't" : " items aren't") +
        ' mentioned in any beat — switch to List to see ' +
        (untracked === 1 ? "it" : "them") + '.</div>' : '');
    return;
  }

  const rename = listEl.querySelector<HTMLInputElement>(".tag-rename-input");
  const keepRename = rename && rename.getAttribute("data-key") === (ports as TagPanelPorts).view.tagRenamingKey();
  const focused = rename && document.activeElement === rename;
  const selection = rename && [rename.selectionStart, rename.selectionEnd, rename.selectionDirection] as const;
  listEl.innerHTML = '<ul class="tag-list" aria-label="Gear items">' +
    entries.map(function (e) { return tagEntityHtml(e, { gear: true }); }).join("") + '</ul>';
  const replacement = listEl.querySelector<HTMLInputElement>(".tag-rename-input");
  if (keepRename && replacement && replacement.getAttribute("data-key") === rename.getAttribute("data-key") &&
      rename.getAttribute("data-registry-id") &&
      replacement.getAttribute("data-registry-id") === rename.getAttribute("data-registry-id") &&
      replacement.getAttribute("data-document-epoch") === rename.getAttribute("data-document-epoch")) {
    replacement.replaceWith(rename);
    if (focused) rename.focus({ preventScroll: true });
    if (selection) rename.setSelectionRange(selection[0], selection[1], selection[2] || undefined);
  }
}

function fillGearQuickAdd() {
  const box = (document.getElementById("gear-quickadd-input") as HTMLTextAreaElement | null);
  if (!box || document.activeElement === box) return;
  const names = gearEntries().map(function (e) { return e.name; })
    .sort(function (a, b) { return a.localeCompare(b); });
  box.value = names.join("\n");
}

export function applyGearQuickAdd() {
  const raw = (document.getElementById("gear-quickadd-input") as HTMLTextAreaElement).value || "";
  function planned(doc: DocumentView | null) { return (planQuickAdd as PanelQuickAddRead)(doc, (ports as TagPanelPorts).text.productionReaders, raw, currentProductionIndex()); }
  const plan = (ports as TagPanelPorts).document.read(planned);
  const added = plan.added, removed = plan.removed;

  if (!(ports as TagPanelPorts).edits.edit(gearQuickAddCommand(planned))) { fillGearQuickAdd(); return; }
  renderProduction();
  fillGearQuickAdd();
  const parts = [];
  if (added) parts.push("added " + added);
  if (removed) parts.push("removed " + removed);
  (ports as TagPanelPorts).notices.show("Gear list updated — " + parts.join(", ") + ".", "ok");
}

function joinBeatLinks(rowIds: readonly string[], link: (rowId: string) => string) {
  const groups = new Map<string, string[]>();
  for (const rowId of rowIds) {
    const letter = (ports as TagPanelPorts).document.numbering().beats[rowId]?.scene.letter ?? "";
    const links = groups.get(letter) ?? [];
    links.push(link(rowId));
    groups.set(letter, links);
  }
  return Array.from(groups, ([letter, links]) => '<span class="tag-beat-group"><span class="tag-beat-letter">' +
    escapeHtml(letter) + '</span> <span class="tag-beat-links">' + links.join(' ') + '</span></span>').join(' ');
}

function beatLinksHtml(item: PresentedProductionEntry) {
  const byRow = idMap<BeatMentionGroup>(), order: BeatMentionGroup[] = [];
  item.mentions.forEach(function (m) {
    let s = byRow[m.rowId];
    if (!s) { s = byRow[m.rowId] = { m: m, n: 0, visual: false, audio: false }; order.push(s); }
    s.n++;
    if (m.field === "visualText") s.visual = true; else s.audio = true;
  });
  order.sort(function (a, b) { return a.m.rowIndex - b.m.rowIndex; });
  return joinBeatLinks(order.map(s => s.m.rowId), function (rowId) {
    const s = byRow[rowId] as BeatMentionGroup;
    const num = ((ports as TagPanelPorts).document.numbering().beats[s.m.rowId]?.full ?? "");
    const label = "Beat " + num + " · " +
      (s.visual && s.audio ? "Visual and Audio" : s.visual ? "Visual" : "Audio") +
      (s.n > 1 ? " · " + s.n + " mentions" : "") + " — go to it";
    return '<button type="button" class="tag-scene jump-link" data-action="jump-tag" data-row="' +
      escapeHtml(s.m.rowId) + '" data-key="' + escapeHtml(item.key) + '" title="' +
      escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' + escapeHtml((ports as TagPanelPorts).document.numbering().beats[rowId]?.short ?? "") + '</button>';
  });
}

function mentionLinksHtml(item: PresentedProductionEntry) {
  const seen: Record<string, { n: number; m: PanelTagMention }> = {}, order: string[] = [];
  item.mentions.forEach(function (m) {
    const k = m.rowIndex + "|" + m.field;
    if (seen[k]) { (seen[k] as { n: number; m: PanelTagMention }).n++; return; }
    seen[k] = { n: 1, m: m };
    order.push(k);
  });
  return order.map(function (k) {
    const entry = seen[k] as { n: number; m: PanelTagMention };
    const num = ((ports as TagPanelPorts).document.numbering().beats[entry.m.rowId]?.full ?? "");
    return '<button type="button" class="tag-mention jump-link" data-action="jump-tag" data-row="' +
      escapeHtml(entry.m.rowId) + '" data-key="' + escapeHtml(item.key) + '" title="Go to this mention in beat ' +
      num + '"><span class="tag-figure">' + numberHtml(num) + '</span> ' +
      (entry.m.field === "visualText" ? "Visual" : "Audio") +
      (entry.n > 1 ? ' <span class="tag-figure">×' + entry.n + '</span>' : '') + '</button>';
  }).join(", ");
}

function personAvatarHtml(name: string) {
  const initial = Array.from(String(name || "").trim())[0] || "?";
  return '<span class="person-avatar" style="--presence:' + (ports as TagPanelPorts).personColors.personColor(name) + '" aria-hidden="true">' +
    escapeHtml(initial.toUpperCase()) + '</span>';
}

function ownerCellHtml(owner: ReturnType<typeof personIn>) {
  if (!owner) {
    return '<span class="tag-owner is-none"><span aria-hidden="true">—</span>' +
      '<span class="tag-sr">Unassigned</span></span>';
  }
  const first = String(owner.name).trim().split(/\s+/)[0] || owner.name;
  return '<span class="tag-owner" title="' + escapeHtml(owner.name) + '">' + personAvatarHtml(owner.name) +
    '<span class="tag-owner-name">' + escapeHtml(first) + '</span></span>';
}

function statusCellHtml(item: PresentedProductionEntry) {
  const st = tagStatus(item.status) || (TAG_STATUSES[0] as PanelTagStatus);
  const k = escapeHtml(item.key);
  const inner = tagStatusLampHtml(st.id) + escapeHtml(st.label);
  const nextSt = tagStatus(nextTagStatus(st.id)) || (TAG_STATUSES[0] as PanelTagStatus);
  return '<button type="button" class="tag-status-pill" data-action="tag-status-cycle" data-key="' + k +
    '" title="' + escapeHtml(st.label + " — click for " + nextSt.label) + '" aria-label="' +
    escapeHtml("Status: " + st.label + ". Click for " + nextSt.label) + '">' + inner + '</button>';
}

function tagFieldId(what: string, gear: boolean, key: string) {
  return "tag-" + what + "-" + (gear ? "g-" : "p-") +
    String(key).replace(/[^A-Za-z0-9]/g, function (c) { return "_" + c.charCodeAt(0).toString(16); });
}

function iconHtml(id: string, cls?: string) {
  return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true" focusable="false"><use href="#' + id + '"/></svg>';
}

function untaggedMentionCount(item: PresentedProductionEntry) {
  if (!(ports as TagPanelPorts).document.current() || !item.name) return 0;
  return (ports as TagPanelPorts).bulkTag(((ports as TagPanelPorts).document.current() as DocumentView).rows, item.name, item.cat.id, item.name, false, true).hits;
}

function untaggedMentionsHtml(item: PresentedProductionEntry) {
  const n = untaggedMentionCount(item);
  if (!n) return "";
  return '<dt>Untagged</dt><dd class="tag-untagged-dd">' +
    '<button type="button" class="btn-outline is-small" data-action="tag-all-mentions" data-key="' +
      escapeHtml(item.key) + '" title="Tag every plain-text mention of ' + escapeHtml(item.name) +
      ' in the Visual column">Tag all ' + n + ' mention' + (n === 1 ? '' : 's') + '</button></dd>';
}

export function tagAllMentions(key: string | null) {
  const item = findTagByKey(key);
  if (!item) return;
  (ports as TagPanelPorts).undo.breakCoalescing();
  const done = (ports as TagPanelPorts).bulkTag(jsonRows(), item.name, item.cat.id, item.name, false, true);
  const tagged = rewrittenCopies(["visualText"], function (rows) { (ports as TagPanelPorts).bulkTag(rows, item.name, item.cat.id, item.name, false, false); });
  if (!done.hits || !(ports as TagPanelPorts).edits.edit(tagCellsCommand("tag-all-mentions", tagged, tagRef(item), (ports as TagPanelPorts).edits.stamps))) {
    (ports as TagPanelPorts).notices.show("No untagged mentions of " + item.name + " left.", "warn");
    return;
  }
  (ports as TagPanelPorts).undo.breakCoalescing();
  (ports as TagPanelPorts).notices.show("Tagged " + done.hits + " mention" + (done.hits === 1 ? "" : "s") + " of " + item.name, "ok");
}

function tagEntityDetailHtml(item: PresentedProductionEntry, renaming: boolean, gear: boolean, detailId: string, prep = false, idKey = item.key) {
  const k = escapeHtml(item.key);
  const name = escapeHtml(item.name);
  const st = tagStatus(item.status) || (TAG_STATUSES[0] as PanelTagStatus);
  const ownerId = tagFieldId("owner", gear, idKey);
  const notesId = tagFieldId("notes", gear, idKey);
  const renameId = tagFieldId("rename", gear, idKey);

  const choices = TAG_STATUSES.map(function (s) {
    const on = s.id === st.id;
    return '<button type="button" role="' + (gear ? 'menuitemradio' : 'radio') + '" class="' +
        (gear ? 'tag-menu-item' : 'tag-status-choice') + (on ? ' is-active' : '') +
        '" data-action="tag-status-set" data-key="' + k + '" data-status="' + escapeHtml(s.id) +
        '" aria-checked="' + (on ? 'true' : 'false') + '">' +
      tagStatusLampHtml(s.id) + escapeHtml(s.label) + '</button>';
  }).join("");
  const status = gear
    ? '<div class="tag-menu-wrap">' +
        '<button type="button" class="tag-status-menu-btn tag-menu-btn" aria-haspopup="menu" aria-expanded="false" ' +
          'aria-label="' + escapeHtml("Status: " + st.label + ". Change") + '">' +
          tagStatusLampHtml(st.id) + escapeHtml(st.label) + iconHtml("i-chevron-down", "tag-chevron") +
        '</button>' +
        '<div class="tag-menu tag-status-seg" role="menu" aria-label="Status of ' + name + '" hidden>' + choices + '</div>' +
      '</div>'
    : '<div class="tag-status-seg" role="radiogroup" aria-label="Status of ' + name + '">' + choices + '</div>';

  const ownerField = '<span class="ev-field tag-owner-field">' +
      '<select class="tag-owner-select' + (personById(item.owner) ? '' : ' is-unassigned') + '" id="' + ownerId +
        '" data-key="' + k + '">' +
        '<option value=""' + (item.owner ? '' : ' selected') + '>Unassigned</option>' +
        (((ports as TagPanelPorts).document.current()?.people as readonly Person[] | null | undefined) || []).map(function (p) {
          return '<option value="' + escapeHtml(p.id) + '"' +
            (p.id === item.owner ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
        }).join("") +
      '</select>' +
      iconHtml("i-chevron-down", "ev-chevron") +
    '</span>';
  const addPerson =
    '<button type="button" class="tag-person-add tag-quiet-btn" data-action="tag-person-new" data-key="' + k +
      '" title="Add someone to the crew list"' +
      (gear ? ' aria-label="Add a person to the crew list">' + iconHtml("i-plus") + 'Person' : '>Add person') +
    '</button>';
  const personRow = (ports as TagPanelPorts).view.tagAddingPersonKey() === item.key
    ? '<div class="tag-person-row">' +
        '<input type="text" class="tag-person-input ev-field" data-key="' + k +
          '" placeholder="Their name" maxlength="60" aria-label="The new person’s name">' +
        '<button type="button" class="btn-outline is-small" data-action="tag-person-save" data-key="' + k + '">Add</button>' +
        '<button type="button" class="tag-quiet-btn" data-action="tag-person-cancel">Cancel</button>' +
      '</div>'
    : '';

  const more =
    '<div class="tag-menu-wrap tag-more">' +
      '<button type="button" class="tag-more-btn tag-menu-btn' + (gear ? ' tag-icon-btn' : ' btn-outline is-small is-icon') +
        '" aria-haspopup="menu" aria-expanded="false" title="More" aria-label="' +
        escapeHtml("More actions for " + item.name + ": " + (gear ? "" : "Rename, ") +
          (item.orphaned ? "Delete from list" : "Remove label")) + '">' + iconHtml("i-more") + '</button>' +
      '<div class="tag-menu" role="menu" aria-label="' + escapeHtml("Actions for " + item.name) + '" hidden>' +
        (gear ? '' :
          '<button type="button" role="menuitem" class="tag-menu-item" data-action="tag-rename" data-key="' + k + '">' +
            iconHtml("i-pen") + '<span class="tag-menu-label">Rename</span></button>') +
        (item.orphaned
          ? '<button type="button" role="menuitem" class="tag-menu-item danger" data-action="tag-delete" data-key="' + k + '">' +
              iconHtml("i-trash") + '<span class="tag-menu-label">Delete from list</span></button>'
          : '<button type="button" role="menuitem" class="tag-menu-item danger" data-action="tag-remove" data-key="' + k + '">' +
              iconHtml("i-tag") + '<span class="tag-menu-label">Remove label</span></button>') +
      '</div>' +
    '</div>';

  const dl = '<dl class="tag-entity-detail' + (gear ? ' is-gear' : '') + '" id="' + detailId + '">' +
      (renaming
        ? '<dt><label for="' + renameId + '">Name</label></dt>' +
          '<dd class="tag-rename-row">' +
            '<input type="text" class="tag-rename-input ev-field" id="' + renameId + '" value="' + name +
              '" data-key="' + k + '" data-registry-id="' + escapeHtml(item.id || '') +
              '" data-document-epoch="' + (ports as TagPanelPorts).lifetime.epoch() + '">' +
            '<button type="button" class="btn-outline is-small" data-action="tag-rename-save" data-key="' + k + '">Save</button>' +
            '<button type="button" class="tag-quiet-btn" data-action="tag-rename-cancel">Cancel</button>' +
          '</dd>'
        : '') +
      '<dt>Status</dt><dd class="tag-status-dd">' + status + '</dd>' +
      untaggedMentionsHtml(item) +
      (gear
        ? '<dt>Mentions</dt><dd class="tag-mentions">' +
            (item.orphaned ? '<span class="tag-orphan-badge">Not in script</span>' : mentionLinksHtml(item)) + '</dd>'
        : '') +
      '<dt><label for="' + ownerId + '">Assigned to</label></dt>' +
      '<dd class="tag-owner-dd">' + ownerField + addPerson + (gear ? '' : more) + personRow + '</dd>' +
      '<dt><label for="' + notesId + '">Notes &amp; links</label></dt>' +
      '<dd class="tag-notes-dd">' +
        '<textarea class="tag-notes-input ev-field" id="' + notesId + '" data-key="' + k + '" rows="2" ' +
          'placeholder="Reference link, file path, spec, where it’s coming from…">\n' + escapeHtml(item.notes) + '</textarea>' +
      '</dd>' +
    '</dl>';
  if (prep) return '<div class="prep-notes" id="' + detailId + '">' +
    (renaming ? '<div class="tag-rename-row"><input type="text" class="tag-rename-input ev-field" value="' + name +
      '" data-key="' + k + '" data-registry-id="' + escapeHtml(item.id || '') + '" data-document-epoch="' +
      (ports as TagPanelPorts).lifetime.epoch() + '" aria-label="Item name">' +
      '<button type="button" class="btn-outline is-small" data-action="tag-rename-save" data-key="' + k + '">Save</button>' +
      '<button type="button" class="tag-quiet-btn" data-action="tag-rename-cancel">Cancel</button></div>' : '') +
    '<label for="' + notesId + '">Notes &amp; links</label>' +
    '<textarea class="tag-notes-input ev-field" id="' + notesId + '" data-key="' + k + '" rows="2" placeholder="Reference link, spec, where it is coming from">\n' + escapeHtml(item.notes) + '</textarea>' +
    '<div class="prep-notes-tools">' + addPerson + more + '</div>' + personRow +
    '<dl class="prep-untagged">' + untaggedMentionsHtml(item) + '</dl></div>';
  if (!gear) return dl;
  return dl +
    '<div class="tag-detail-foot">' +
      (renaming ? '' :
        '<button type="button" class="tag-quiet-btn tag-rename-btn" data-action="tag-rename" data-key="' + k + '">' +
          iconHtml("i-pen") + 'Rename</button>') +
      more +
    '</div>';
}

function tagEntityHtml(item: PresentedProductionEntry, opts?: { gear?: boolean; selection?: boolean; dot?: boolean; idSuffix?: string }) {
  opts = opts || {};
  const gear = !!opts.gear;
  const renaming = (ports as TagPanelPorts).view.tagRenamingKey() === item.key;
  const expanded = (ports as TagPanelPorts).view.tagExpandedKey() === item.key || renaming;
  const k = escapeHtml(item.key);
  const selected = opts.selection && (ports as TagPanelPorts).selection.selected(item.key);
  const idKey = item.key + (opts.idSuffix ?? "");
  const detailId = tagFieldId("detail", gear, idKey);
  const dot = '<span class="tag-row-dot" data-tag-cat="' + item.cat.id + '" aria-hidden="true"></span>';
  return '<li class="tag-entity' + (gear ? ' is-gear' : '') + (item.orphaned ? ' is-orphaned' : '') +
      (expanded ? ' is-expanded' : '') +
      (selected ? ' is-selected' : '') +
      '" style="--dot:' + item.cat.color + '" data-key="' + k +
      '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
    '<div class="tag-entity-row">' +
      (gear ? dot : '') +
      '<button type="button" class="tag-entity-head" data-action="tag-expand" data-key="' + k +
        '" aria-expanded="' + (expanded ? 'true' : 'false') + '"' +
        (expanded ? ' aria-controls="' + detailId + '"' : '') + '>' +
        (opts.dot ? dot : '') + '<span class="tag-entity-name">' + escapeHtml(item.name) + '</span>' +
      '</button>' +
      statusCellHtml(item) +
      '<span class="tag-scenes">' +
        (item.orphaned ? '<span class="tag-orphan-badge">Not in script</span>' : beatLinksHtml(item)) +
      '</span>' +
      (gear ? '' : ownerCellHtml(personById(item.owner))) +
    '</div>' +
    (expanded ? tagEntityDetailHtml(item, renaming, gear, detailId, false, idKey) : '') +
  '</li>';
}

function renderProductionByScene(entries: readonly PresentedProductionEntry[], gear: boolean): string {
  const doc = (ports as TagPanelPorts).document.current();
  const mentions = entries.flatMap(item => item.mentions.map(mention => ({ item, rowId: mention.rowId })));
  const result = groupItemsByScene(doc ?? { rows: [] }, mentions, mention => mention.rowId);
  const assigned = new Set(result.groups.flatMap(group => group.items.map(mention => mention.item.key)));
  const section = (title: string, items: readonly PresentedProductionEntry[], suffix: string) =>
    '<section class="tag-scene-group" data-scene-group="' + escapeHtml(suffix) + '"><h3 class="tag-scene-group-head">' + escapeHtml(title) + '</h3>' +
    '<ul class="tag-list">' + items.map(item => tagEntityHtml(item, { gear, idSuffix: suffix })).join("") + '</ul></section>';
  const groups = result.groups.map((group, index) => {
    const items = Array.from(new Map(group.items.map(mention => [mention.item.key, mention.item])).values());
    return section('Scene ' + group.scene.letter + (group.scene.name ? ' · ' + group.scene.name : ''), items, ':scene:' + index);
  });
  const unassigned = entries.filter(item => !assigned.has(item.key));
  if (unassigned.length) groups.push(section('No scene', unassigned, ':unassigned'));
  return groups.join("");
}

function renderProductionByBeat(all: readonly PresentedProductionEntry[]) {
  const byRow: Record<number, Record<string, PresentedProductionEntry>> = {};
  all.forEach(function (item) {
    item.mentions.forEach(function (m) {
      if (!byRow[m.rowIndex]) byRow[m.rowIndex] = {};
      (byRow[m.rowIndex] as Record<string, PresentedProductionEntry>)[item.key] = item;
    });
  });
  const indexes = Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; });
  return indexes.map(function (idx) {
    const items = Object.keys(byRow[idx] as Record<string, PresentedProductionEntry>).map(function (k) { return (byRow[idx] as Record<string, PresentedProductionEntry>)[k] as PresentedProductionEntry; });
    return '<section class="tag-scene-group">' +
      '<h3 class="tag-scene-group-head">Beat <span class="tag-figure">' + numberHtml((ports as TagPanelPorts).document.numbering().beats[(ports as TagPanelPorts).document.current()?.rows[idx]?.id ?? ""]?.full ?? "") + '</span></h3>' +
      '<ul class="tag-pills">' +
        items.map(function (item) {
          return '<li class="tag-pill" style="--dot:' + item.cat.color + '">' +
            '<span class="tag-cat-dot" data-tag-cat="' + item.cat.id + '" aria-hidden="true"></span>' +
            escapeHtml(item.name) + '</li>';
        }).join("") +
      '</ul>' +
    '</section>';
  }).join("");
}

function renderProductionByPerson(all: readonly PresentedProductionEntry[]) {
  const buckets = idMap<PersonTagGroup>(), order: string[] = [];
  function bucket(id: string, label: string) {
    if (!buckets[id]) { buckets[id] = { id: id, label: label, items: [] }; order.push(id); }
    return buckets[id] as PersonTagGroup;
  }
  (((ports as TagPanelPorts).document.current()?.people as readonly Person[] | null | undefined) || []).forEach(function (p) { bucket(p.id, p.name); });
  all.forEach(function (item) {
    const p = personById(item.owner);
    bucket(p ? p.id : "", p ? p.name : "Unassigned").items.push(item);
  });
  order.sort(function (a, b) { return (a === "" ? 1 : 0) - (b === "" ? 1 : 0); });

  return order.map(function (id) {
    const g = buckets[id] as PersonTagGroup;
    return '<section class="tag-group">' +
      '<h3 class="tag-group-head tag-person-head">' +
        (id ? personAvatarHtml(g.label) : iconHtml("i-person", "tag-person-none")) +
        '<span class="tag-person-name">' + escapeHtml(g.label) + '</span>' +
        '<span class="tag-group-count">' + g.items.length + '</span>' +
        (id ? '<button type="button" class="tag-person-remove" data-action="person-delete" ' +
                'data-person="' + escapeHtml(id) + '" title="Remove from the crew list" aria-label="' +
                escapeHtml("Remove " + g.label + " from the crew list") + '">' +
                iconHtml("i-close") + '</button>' : '') +
      '</h3>' +
      (g.items.length
        ? '<ul class="tag-list">' +
            g.items.map(function (e) { return tagEntityHtml(e, { selection: true, dot: true }); }).join("") +
          '</ul>'
        : '<div class="tag-orphan-note">Nothing assigned yet.</div>') +
    '</section>';
  }).join("");
}

function renderProductionByShoot(entries?: readonly PresentedProductionEntry[]) {
  const doc = (ports as TagPanelPorts).document.current();
  if (!doc) return '<div class="comments-empty">Nothing to schedule yet.</div>';
  const live = entries || productionEntries();
  const byRow: Record<number, PresentedProductionEntry[]> = {};
  live.forEach(function (item) {
    item.mentions.forEach(function (m) {
      (byRow[m.rowIndex] = byRow[m.rowIndex] || []).push(item);
    });
  });

  const groups: Record<string, ShootTagGroup> = {}, order: string[] = [];
  function group(key: string, name: string) {
    if (!groups[key]) { groups[key] = { name: name, rows: [], needs: {}, needOrder: [] }; order.push(key); }
    return groups[key] as ShootTagGroup;
  }

  doc.rows.forEach(function (row, i) {
    const here = byRow[i] || [];
    const locs = here.filter(function (t) { return t.cat.id === "location"; });
    const targets = locs.length
      ? locs.map(function (t) { return { key: t.key, name: t.name }; })
      : [{ key: "", name: "No location set" }];
    targets.forEach(function (t) {
      const g = group(t.key, t.name);
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
  order.sort(function (a, b) { return (a === "" ? 1 : 0) - (b === "" ? 1 : 0); });

  return order.map(function (key) {
    const g = groups[key] as ShootTagGroup;
    const shot = g.rows.filter(function (i) { return (doc.rows[i] as DocumentView["rows"][number]).status === "shot"; }).length;
    const secs = g.rows.reduce(function (n, i) { return n + rowSeconds(doc.rows[i] as DocumentView["rows"][number], doc, (ports as TagPanelPorts).text.productionReaders); }, 0);
    const done = shot === g.rows.length;
    return '<section class="shoot-group" style="--dot:' + (key ? (TAG_CATEGORIES[1] as TagCategoryLook).color : "var(--border-strong)") + '">' +
      '<h3 class="shoot-head">' +
        '<span class="tag-cat-dot"' + (key ? ' data-tag-cat="' + (TAG_CATEGORIES[1] as TagCategoryLook).id + '"' : '') + ' aria-hidden="true"></span>' +
        '<span class="shoot-name">' + escapeHtml(g.name) + '</span>' +
        '<span class="shoot-progress' + (done ? ' is-done' : '') + '">' +
          '<span class="tag-figure">' + shot + '/' + g.rows.length + '</span> filmed · ' +
          '<span class="tag-figure">' + formatDuration(secs) + '</span></span>' +
      '</h3>' +
      '<dl class="shoot-detail">' +
        '<dt>Beats</dt>' +
        '<dd class="tag-scenes">' +
          joinBeatLinks(g.rows.map(i => (doc.rows[i] as DocumentView["rows"][number]).id), function (rowId) {
            const row = doc.rows.find(row => row.id === rowId) as DocumentView["rows"][number];
            const st = rowStatus(row.status) || (ROW_STATUSES[0] as PanelRowStatus);
            const label = "Beat " + ((ports as TagPanelPorts).document.numbering().beats[row.id]?.full ?? "") + " · " + st.label + " — go to it";
            return '<button type="button" class="tag-scene jump-link' + (row.status === "shot" ? ' is-shot' : '') +
              '" data-action="jump-row" data-row="' + escapeHtml(row.id) + '" title="' + escapeHtml(label) +
              '" aria-label="' + escapeHtml(label) + '">' + escapeHtml((ports as TagPanelPorts).document.numbering().beats[row.id]?.short ?? "") +
              (row.status === "shot" ? iconHtml("i-check", "tag-scene-tick") : '') + '</button>';
          }) +
        '</dd>' +
        (g.needOrder.length
          ? '<dt>Needs on the day</dt>' +
            '<dd><ul class="shoot-needs">' +
              g.needOrder.map(function (k) {
                const item = g.needs[k] as PresentedProductionEntry;
                const owner = personById(item.owner);
                const nst = tagStatus(item.status) || (TAG_STATUSES[0] as PanelTagStatus);
                return '<li class="shoot-need" style="--dot:' + item.cat.color + '">' +
                  '<span class="tag-cat-dot" data-tag-cat="' + item.cat.id + '" aria-hidden="true"></span>' +
                  '<span class="shoot-need-name">' + escapeHtml(item.name) + '</span>' +
                  '<span class="shoot-need-status">' + tagStatusLampHtml(nst.id) + escapeHtml(nst.label) + '</span>' +
                  ownerCellHtml(owner) +
                '</li>';
              }).join("") +
            '</ul></dd>'
          : '') +
      '</dl>' +
    '</section>';
  }).join("");
}

export function renderProduction() {
  renderProductionPanel();
  renderGearList();
}

function renderProductionPanel() {
  const panel = document.getElementById("production-panel");
  if (!panel || panel.hidden || !(ports as TagPanelPorts).document.current()) return;
  const entries = productionEntries();
  if ((ports as TagPanelPorts).selection.selectedKeys().length) (ports as TagPanelPorts).selection.prune(entries);
  renderProductionList(entries);
  renderBulkBar(entries);
  updateProductionBadge(entries.length);
}

function renderProductionList(entries?: readonly PresentedProductionEntry[]) {
  const listEl = document.getElementById("production-list");
  const panel = document.getElementById("production-panel");
  if (!listEl || !panel || panel.hidden || !(ports as TagPanelPorts).document.current()) return;
  entries = entries || productionEntries();
  const group = (ports as TagPanelPorts).view.productionGroupBy();
  const viewLabel = document.getElementById("production-view-label");
  if (viewLabel) viewLabel.textContent = ({ prep: "Scene prep", cat: "Category", person: "Person", scene: "Beat", shoot: "Shoot", "by-scene": "By scene" } as Record<string, string>)[group] ?? "Scene prep";

  document.querySelectorAll("#production-modes [data-group]").forEach(function (b) {
    const on = b.getAttribute("data-group") === (ports as TagPanelPorts).view.productionGroupBy();
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });

  const groups = tagsByCategory(entries);
  const cols = document.getElementById("production-cols");
  if (cols) {
    cols.hidden = !groups.length ||
      ((ports as TagPanelPorts).view.productionGroupBy() !== "cat" && (ports as TagPanelPorts).view.productionGroupBy() !== "person");
  }

  if (group === "prep") {
    const rename = listEl.querySelector<HTMLInputElement>(".tag-rename-input");
    const keepRename = rename && rename.getAttribute("data-key") === (ports as TagPanelPorts).view.tagRenamingKey();
    const active = document.activeElement;
    const focused = active && listEl.contains(active) ? active as HTMLElement : null;
    const identity = focused ? {
      prep: focused.getAttribute("data-prep"), id: focused.getAttribute("data-id"),
      key: focused.getAttribute("data-key"), row: focused.getAttribute("data-row"),
      className: focused.className, value: isPrepTextField(focused) ? focused.value : null,
      context: focused.closest(".prep-resource")?.getAttribute("data-prep-context") ?? null,
      start: isPrepTextField(focused) ? focused.selectionStart : null,
      end: isPrepTextField(focused) ? focused.selectionEnd : null,
      direction: isPrepTextField(focused) ? focused.selectionDirection : null
    } : null;
    const scroll = listEl.scrollTop;
    const html = renderProductionOutline(ports as TagPanelPorts, entries, (item, id) =>
      tagEntityDetailHtml(item, (ports as TagPanelPorts).view.tagRenamingKey() === item.key, false, id, true));
    if (listEl.innerHTML === html) return;
    listEl.innerHTML = html;
    const replacement = listEl.querySelector<HTMLInputElement>(".tag-rename-input");
    if (keepRename && replacement && replacement.getAttribute("data-registry-id") === rename.getAttribute("data-registry-id") &&
      replacement.getAttribute("data-document-epoch") === rename.getAttribute("data-document-epoch")) replacement.replaceWith(rename);
    if (identity) {
      const next = Array.from(listEl.querySelectorAll<HTMLElement>("button, select, input, textarea, a")).find(el =>
        el.className === identity.className && el.getAttribute("data-prep") === identity.prep &&
        (el.closest(".prep-resource")?.getAttribute("data-prep-context") ?? null) === identity.context &&
        el.getAttribute("data-id") === identity.id && el.getAttribute("data-key") === identity.key && el.getAttribute("data-row") === identity.row);
      if (next) {
        if ((isPrepTextField(next)) && identity.value !== null) {
          next.value = identity.value;
          if (identity.start !== null && identity.end !== null) next.setSelectionRange(identity.start, identity.end, identity.direction ?? undefined);
        }
        if (next.matches(":disabled")) next.closest(".prep-resource")?.querySelector<HTMLSelectElement>(".prep-status-select")?.focus({ preventScroll: true });
        else next.focus({ preventScroll: true });
      }
    }
    listEl.scrollTop = scroll;
    return;
  }

  if ((ports as TagPanelPorts).view.productionGroupBy() === "shoot") {
    listEl.innerHTML = renderProductionByShoot(entries);
    return;
  }

  if (!groups.length) {
    listEl.innerHTML = '<div class="comments-empty">Nothing labelled yet.<br><br>' +
      'Type <code>[a prop]</code>, <code>{a location}</code> or <code>~an effect~</code> ' +
      'straight into the script, or select any words and press <strong>Tag</strong>. ' +
      'Everything you label shows up here with every beat it appears in — and you can ' +
      'assign who is responsible for it, track it from Needed through to Returned, ' +
      'and keep notes and links against it.</div>';
    return;
  }

  if (group === "by-scene") {
    listEl.innerHTML = renderProductionByScene(entries, false);
    return;
  }
  if ((ports as TagPanelPorts).view.productionGroupBy() === "scene") {
    const orphanCount = groups.reduce(function (n, g) {
      return n + g.items.filter(function (i) { return i.orphaned; }).length;
    }, 0);
    listEl.innerHTML = renderProductionByBeat(entries.filter(function (e) { return !e.orphaned; })) +
      (orphanCount ? '<div class="tag-orphan-note">' + orphanCount +
        (orphanCount === 1 ? " item doesn't" : " items don't") +
        ' appear in any beat — group by category or person to see ' +
        (orphanCount === 1 ? "it" : "them") + '.</div>' : '');
    return;
  }

  if ((ports as TagPanelPorts).view.productionGroupBy() === "person") {
    listEl.innerHTML = renderProductionByPerson(entries);
    return;
  }

  listEl.innerHTML = groups.map(function (g) {
    return '<section class="tag-group">' +
      '<h3 class="tag-group-head" style="--dot:' + g.cat.color + '">' +
        '<span class="tag-cat-dot" data-tag-cat="' + g.cat.id + '" aria-hidden="true"></span>' +
        '<span class="tag-group-label">' + escapeHtml(g.cat.plural) + '</span>' +
        '<span class="tag-group-count">' + g.items.length + '</span>' +
      '</h3>' +
      '<ul class="tag-list">' +
        g.items.map(function (e) { return tagEntityHtml(e, { selection: true }); }).join("") +
      '</ul>' +
    '</section>';
  }).join("");
}

function isPrepTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT" && (el as HTMLInputElement).type !== "checkbox";
}

function prepNotice(message: string): void {
  const p = ports as TagPanelPorts;
  const epoch = p.lifetime.epoch();
  const last = p.undo.last();
  p.notices.showAction(message, "ok", "Undo", () => {
    if (ports !== p || p.lifetime.epoch() !== epoch || p.undo.last() !== last) return;
    p.undo.undo();
    renderProduction();
  });
}

export function clickProductionOutline(e: MouseEvent): boolean {
  const target = e.target as Element;
  const button = target.closest<HTMLElement>("#production-list [data-prep]");
  if (!button) return false;
  const id = button.dataset["id"] ?? "";
  const p = ports as TagPanelPorts;
  const state = p.view.prep();
  switch (button.dataset["prep"]) {
    case "scene": state.toggleScene(id); break;
    case "beat": state.toggleBeat(id); p.view.setTagRenaming(null); p.view.setTagAddingPerson(null); break;
    case "requirements": state.toggleRequirements(id); break;
    case "filmed": state.toggleFilmed(id); break;
    case "more": state.showMore(id); break;
    case "earlier": state.showEarlier(id); break;
    case "ready-fold": state.toggleReady(id); break;
    case "notes": state.toggleNotes(id); p.view.setTagRenaming(null); p.view.setTagAddingPerson(null); break;
    case "selection": state.toggleSelecting(); p.selection.clear(); break;
    case "select": p.selection.toggle(id); break;
    case "jump": p.beats.reveal(id); return true;
    case "shot": p.footage.open(id); return true;
    case "ready": setTagStatus(id, "have"); prepNotice("Marked as Have it"); return true;
    default: return false;
  }
  renderProduction();
  return true;
}

export function changeProductionOutline(target: HTMLElement): void {
  if (target.tagName === "SELECT" && target.classList.contains("prep-status-select")) {
    setTagStatus(target.dataset["key"] ?? null, (target as HTMLSelectElement).value);
    prepNotice("Requirement status updated");
  } else if (target.tagName === "INPUT" && target.classList.contains("prep-film-input")) {
    (ports as TagPanelPorts).undo.breakCoalescing();
    (ports as TagPanelPorts).beats.setFilmed(target.dataset["row"] ?? "", (target as HTMLInputElement).checked);
    renderProduction();
    prepNotice((target as HTMLInputElement).checked ? "Beat marked as Filmed" : "Beat marked as To do");
  }
}

function jsonRows() {
  return (ports as TagPanelPorts).document.read(function (doc) {
    return doc ? doc.rows.map(function (row) { return { id: row.id, visualText: row.visualText }; }) : [];
  });
}

function tagRef(item: PresentedProductionEntry) {
  return { cat: item.cat.id, name: item.name };
}

function entryValue(item: PresentedProductionEntry, field: "owner") {
  const entry = registryEntry(item.cat.id, item.name);
  return entry ? entry[field] || "" : "";
}

function updateTags(items: readonly PresentedProductionEntry[], change: TagChange) {
  return (ports as TagPanelPorts).edits.edit(updateTagsCommand(items.map(tagRef), change, (ports as TagPanelPorts).ids));
}

function findTagByKey(key: string | null) {
  const all = productionEntries();
  for (let i = 0; i < all.length; i++) if ((all[i] as PresentedProductionEntry).key === key) return all[i];
  return null;
}

export function jumpToTag(rowId: string | null, key: string | null) {
  ((ports as TagPanelPorts).shotHiding.reveal as PanelNullableCall<TagPanelPorts["shotHiding"]["reveal"], "0">)(rowId);
  const row = document.querySelector('#rows .row[data-id="' + safeId(rowId, "r") + '"]');
  if (!row) { (ports as TagPanelPorts).notices.show("That beat is no longer here.", "warn"); return; }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  const item = findTagByKey(key);
  if (!item) return;
  Array.prototype.forEach.call(row.querySelectorAll(".tag-anchor"), function (el: HTMLElement) {
    if (el.getAttribute("data-tag-cat") !== item.cat.id) return;
    if (normalizeTagName(el.getAttribute("data-tag-name")) !== normalizeTagName(item.name)) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  });
  if (item.cat.id !== "sound") return;
  Array.prototype.forEach.call(row.querySelectorAll(".audio-cue"), function (el: HTMLElement) {
    const name = (el.textContent || "").replace(/\u200B/g, "").replace(/^\s*(sfx|music)\s*:/i, "");
    if (normalizeTagName(name) !== normalizeTagName(item.name)) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  });
}

export function armRemoveTag(btn: Element, key: string | null) {
  if ((ports as TagPanelPorts).deletion.armedId("tag") === key) {
    (ports as TagPanelPorts).deletion.disarm("tag");
    const item = findTagByKey(key);
    if (!item) return;
    (ports as TagPanelPorts).undo.breakCoalescing();
    const n = removeTag(item.cat.id, item.name, tagEditPorts as RemoveTagPorts);
    (ports as TagPanelPorts).undo.breakCoalescing();
    (ports as TagPanelPorts).notices.show("Removed " + item.name + " from " + n + " mention" + (n === 1 ? "" : "s"), "ok");
    return;
  }
  let disarm: () => void;
  ((ports as TagPanelPorts).deletion.arm as PanelNullableCall<TagPanelPorts["deletion"]["arm"], "1">)("tag", key, function () {
    disarm();
  }, function () { disarm = armButton(btn); });
}

function armButton(btn: Element) {
  const label = btn.querySelector(".tag-menu-label") || btn;
  const was = label.innerHTML;
  const aria = btn.getAttribute("aria-label");
  label.textContent = "Confirm?";
  if (aria) btn.setAttribute("aria-label", "Confirm? " + aria);
  btn.classList.add("armed");
  return function () {
    label.innerHTML = was;
    if (aria) btn.setAttribute("aria-label", aria);
    btn.classList.remove("armed");
  };
}

export function armDeleteTag(btn: Element, key: string | null) {
  if ((ports as TagPanelPorts).deletion.armedId("tag") === key) {
    (ports as TagPanelPorts).deletion.disarm("tag");
    const item = findTagByKey(key);
    if (!item) return;
    (ports as TagPanelPorts).edits.edit(deleteTagsCommand([{ cat: item.cat.id, name: item.name, unlabel: false }], function () { return []; }, (ports as TagPanelPorts).edits.stamps));
    (ports as TagPanelPorts).notices.show("Deleted " + item.name + " from the production list", "ok");
    return;
  }
  let disarm: () => void;
  ((ports as TagPanelPorts).deletion.arm as PanelNullableCall<TagPanelPorts["deletion"]["arm"], "1">)("tag", key, function () {
    disarm();
  }, function () { disarm = armButton(btn); });
}

export function toggleCardSelection(key: string | null) {
  ((ports as TagPanelPorts).selection.toggle as PanelNullableCall<TagPanelPorts["selection"]["toggle"], "0">)(key);
  (ports as TagPanelPorts).selection.disarm();
  renderProduction();
}

export function handleSelectionClick(e: Pick<MouseEvent, "shiftKey">, card: Element) {
  const key = card.getAttribute("data-key");
  if (!key) return false;
  const order = Array.prototype.map.call(
    document.querySelectorAll("#production-list .tag-entity"),
    function (el: HTMLElement) { return el.getAttribute("data-key"); });
  if (!(ports as TagPanelPorts).selection.select(key, order as string[], e.shiftKey)) return false;

  const sel = window.getSelection();
  if (sel && sel.removeAllRanges) sel.removeAllRanges();
  (ports as TagPanelPorts).selection.disarm();
  renderProduction();
  return true;
}

function selectedEntries(entries?: readonly PresentedProductionEntry[]): PresentedProductionEntry[] {
  const byKey: Record<string, PresentedProductionEntry> = {};
  (entries || productionEntries()).forEach(function (e) { byKey[e.key] = e; });
  return (ports as TagPanelPorts).selection.selectedKeys().map(function (k) { return byKey[k]; }).filter(Boolean) as PresentedProductionEntry[];
}

export function bulkSetOwner(personId: string) {
  setOwnerOf(selectedEntries(), { id: personId });
}

function setOwnerOf(items: readonly PresentedProductionEntry[], choice: OwnerChoice) {
  if (!items.length) return;
  const known = "id" in choice ? personById(choice.id) : (ports as TagPanelPorts).document.read(function (doc) { return personNamed(doc, choice.name); });
  const owner = known ? known.id : "";
  const n = items.filter(function (item) { return (!known && "name" in choice) || entryValue(item, "owner") !== owner; }).length;
  updateTags(items, { owner: choice });
  renderProduction();
  if (!n) return;
  const who = "id" in choice ? personById(choice.id) : (ports as TagPanelPorts).document.read(function (doc) { return personNamed(doc, choice.name); });
  (ports as TagPanelPorts).notices.show(who ? ("Assigned " + n + " item" + (n === 1 ? "" : "s") + " to " + who.name)
                : ("Unassigned " + n + " item" + (n === 1 ? "" : "s")), "ok");
}

export function bulkSetStatus(statusId: string) {
  const items = selectedEntries();
  if (!items.length) return;
  const want = (tagStatus(statusId) || (TAG_STATUSES[0] as PanelTagStatus));
  const n = items.filter(function (item) {
    const entry = registryEntry(item.cat.id, item.name);
    return (entry ? entry.status : (TAG_STATUSES[0] as PanelTagStatus).id) !== want.id;
  }).length;
  updateTags(items, { status: want.id });
  renderProduction();
  if (!n) return;
  (ports as TagPanelPorts).notices.show("Marked " + n + " item" + (n === 1 ? "" : "s") + " " + want.label, "ok");
}

export function bulkAddPerson() {
  const input = (document.getElementById("bulk-person-input") as HTMLInputElement | null);
  if (!input) return;
  (ports as TagPanelPorts).view.setTagAddingPerson(null);
  if (!cappedText(input.value, PERSON_NAME_MAX)) { renderProduction(); return; }
  setOwnerOf(selectedEntries(), { name: input.value });
}

export function bulkDeleteSelected() {
  const items = selectedEntries();
  if (!items.length) return;
  (ports as TagPanelPorts).undo.breakCoalescing();
  const labelled = items.filter(function (item) { return !item.orphaned; }).map(tagRef);
  const unlabelled = (ports as TagPanelPorts).document.read(function (doc) { return retagMentions((ports as TagPanelPorts).text, doc, labelled); });
  (ports as TagPanelPorts).selection.clear();
  (ports as TagPanelPorts).edits.edit(deleteTagsCommand(items.map(function (item) {
    return { cat: item.cat.id, name: item.name, unlabel: !item.orphaned };
  }), retagRewrites((ports as TagPanelPorts).text, labelled, null), (ports as TagPanelPorts).edits.stamps));
  const n = items.length;
  (ports as TagPanelPorts).undo.breakCoalescing();
  (ports as TagPanelPorts).notices.show("Deleted " + n + " item" + (n === 1 ? "" : "s") +
    (unlabelled ? " and removed " + unlabelled + " label" + (unlabelled === 1 ? "" : "s") +
      " from the script" : ""), "ok");
}

function bulkCountsLabel(items: readonly PresentedProductionEntry[]) {
  let live = 0;
  items.forEach(function (i) { if (!i.orphaned) live += i.mentions.length; });
  return live;
}

function renderBulkBar(entries?: readonly PresentedProductionEntry[]) {
  const bar = document.getElementById("production-bulk");
  if (!bar) return;
  const items = selectedEntries(entries);
  const cardView = ["prep", "cat", "person"].includes((ports as TagPanelPorts).view.productionGroupBy());
  if (!items.length || !cardView) { bar.hidden = true; bar.innerHTML = ""; return; }

  const n = items.length;
  const liveMentions = bulkCountsLabel(items);
  bar.hidden = false;
  bar.innerHTML =
    '<div class="bulk-row bulk-head">' +
      '<span class="bulk-count"><span class="tag-figure">' + n + '</span> selected</span>' +
      '<button type="button" class="bulk-clear" data-action="bulk-clear" ' +
        'title="Clear the selection (Esc)" aria-label="Clear the selection">' + iconHtml("i-close") + '</button>' +
    '</div>' +
    '<div class="bulk-row">' +
      '<span class="ev-field">' +
        '<select class="bulk-select" id="bulk-owner" aria-label="Assign the selected items to">' +
          '<option value="__none__" selected>Assign to…</option>' +
          '<option value="">Unassigned</option>' +
          (((ports as TagPanelPorts).document.current()?.people as readonly Person[] | null | undefined) || []).map(function (p) {
            return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>';
          }).join("") +
        '</select>' + iconHtml("i-chevron-down", "ev-chevron") +
      '</span>' +
      '<button type="button" class="bulk-btn btn-outline is-small" data-action="bulk-person-new" ' +
        'title="Add someone to the crew list and assign these to them">' + iconHtml("i-plus") + 'Person</button>' +
      '<span class="ev-field">' +
        '<select class="bulk-select" id="bulk-status" aria-label="Set the status of the selected items">' +
          '<option value="__none__" selected>Status…</option>' +
          TAG_STATUSES.map(function (s) {
            return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.label) + '</option>';
          }).join("") +
        '</select>' + iconHtml("i-chevron-down", "ev-chevron") +
      '</span>' +
      '<button type="button" class="bulk-btn btn-outline is-small danger' + ((ports as TagPanelPorts).selection.armed() ? ' armed' : '') + '" ' +
        'data-action="bulk-delete">' + iconHtml("i-trash") +
        ((ports as TagPanelPorts).selection.armed()
          ? 'Delete ' + n + (liveMentions ? ' + ' + liveMentions + ' label' +
              (liveMentions === 1 ? '' : 's') : '') + '?'
          : 'Delete') +
      '</button>' +
    '</div>' +
    ((ports as TagPanelPorts).view.tagAddingPersonKey() === "__bulk__"
      ? '<div class="bulk-row bulk-person-row">' +
          '<input type="text" class="ev-field" id="bulk-person-input" placeholder="Their name" maxlength="60" ' +
            'aria-label="The new person’s name">' +
          '<button type="button" class="bulk-btn btn-outline is-small" data-action="bulk-person-save">Add</button>' +
          '<button type="button" class="tag-quiet-btn" data-action="bulk-person-cancel">Cancel</button>' +
        '</div>'
      : '') +
    ((ports as TagPanelPorts).selection.armed()
      ? '<div class="bulk-note">Removes ' + n + ' item' + (n === 1 ? '' : 's') +
          ' from the breakdown' +
          (liveMentions ? ', and their labels from the script — the words stay, the labels go' : '') +
          '. Click again to confirm.</div>'
      : '<div class="bulk-note">' + (IS_TOUCH
          ? 'Tap a card to add or drop it · long-press started this'
          : 'Ctrl+click a card to add or drop it · Shift+click for a run') + '</div>');
}

export function setTagStatus(key: string | null, statusId: string | null) {
  const item = findTagByKey(key);
  if (!item) return;
  if (updateTags([item], { status: statusId === null ? { next: true } : (tagStatus(statusId) || (TAG_STATUSES[0] as PanelTagStatus)).id })) renderProduction();
}

export function setTagOwner(key: string | null, personId: string) {
  const item = findTagByKey(key);
  if (!item) return;
  updateTags([item], { owner: { id: personId } });
  renderProduction();
}

export function setTagNotes(key: string | null, text: string) {
  const item = findTagByKey(key);
  if (!item) return;
  updateTags([item], { notes: cappedLongText(plainText(text), 2000) });
}

export function addPersonForTag(key: string | null, value: string) {
  (ports as TagPanelPorts).view.setTagAddingPerson(null);
  const item = findTagByKey(key);
  if (item) updateTags([item], { owner: { name: value } });
  else (ports as TagPanelPorts).edits.edit(addPersonCommand(value, (ports as TagPanelPorts).ids));
  renderProduction();
}

export function armPersonDelete(btn: Element, personId: string | null) {
  if ((ports as TagPanelPorts).deletion.armedId("tag") === "person:" + personId) {
    (ports as TagPanelPorts).deletion.disarm("tag");
    const person = personById(personId);
    (ports as TagPanelPorts).edits.edit((deletePersonCommand as PanelNullableCall<typeof deletePersonCommand, "0">)(personId));
    renderProduction();
    (ports as TagPanelPorts).notices.show("Removed " + (person ? person.name : "that person") +
      " — their items are now unassigned", "ok");
    return;
  }
  let disarm: () => void;
  (ports as TagPanelPorts).deletion.arm("tag", "person:" + personId, function () {
    disarm();
  }, function () { disarm = armButton(btn); });
}

function renamedNotes(context: string, key: string | null, nextKey: string | null): string | null {
  const [container, open] = JSON.parse(context) as [string, string];
  return nextKey !== null && open === key ? prepContext(container, nextKey) : null;
}

export function saveTagRename(key: string | null, renamed: string): string | null {
  const item = findTagByKey(key);
  if (!item) { (ports as TagPanelPorts).view.setTagRenaming(null); renderProduction(); return null; }
  const p = ports as TagPanelPorts;
  const previousExpanded = p.view.tagExpandedKey();
  const clean = cappedText(renamed, 80);
  const nextKey = clean ? tagKey(item.cat.id, clean) : key;
  if (previousExpanded === key) p.view.setTagExpanded(nextKey);
  const prep = p.view.prep();
  const notes = prep.current().notes;
  const movedNotes = notes === null ? null : renamedNotes(notes, key, nextKey);
  if (notes !== null && movedNotes !== null) prep.renameNotes(notes, movedNotes);
  (ports as TagPanelPorts).view.setTagRenaming(null);
  (ports as TagPanelPorts).undo.breakCoalescing();
  const changed = renameTag(item.cat.id, item.name, renamed, tagEditPorts as RemoveTagPorts);
  if (changed) {
    (ports as TagPanelPorts).undo.breakCoalescing();
    (ports as TagPanelPorts).notices.show("Renamed to " + plainText(renamed).trim(), "ok");
  } else {
    p.view.setTagExpanded(previousExpanded);
    if (notes !== null && movedNotes !== null) prep.renameNotes(movedNotes, notes);
    renderProduction();
  }
  return changed ? nextKey : key;
}

let openTagMenu: HTMLElement | null = null;

function closeTagMenu(refocus: boolean) {
  const menu = openTagMenu;
  openTagMenu = null;
  if (!menu) return;
  menu.hidden = true;
  const btn = menu.parentNode && menu.parentNode.querySelector<HTMLElement>(".tag-menu-btn");
  if (!btn) return;
  btn.setAttribute("aria-expanded", "false");
  if (refocus && btn.isConnected) btn.focus();
}

function openTagMenuFor(btn: HTMLElement, focusFirst: boolean) {
  const menu = (btn.parentNode as ParentNode).querySelector<HTMLElement>(".tag-menu");
  if (!menu) return;
  closeTagMenu(false);
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  openTagMenu = menu;
  menu.classList.remove("opens-up");
  const list = btn.closest(".comments-list");
  const box = list ? list.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const r = menu.getBoundingClientRect();
  if (r.bottom > box.bottom - 8 && r.top - r.height - btn.offsetHeight > box.top + 8) menu.classList.add("opens-up");
  if (focusFirst) {
    const first = menu.querySelector<HTMLElement>(".tag-menu-item.is-active") || menu.querySelector<HTMLElement>(".tag-menu-item");
    if (first) first.focus();
  }
}

function refocusIn(panel: Element | null, origin: Element, selector: string) {
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  if (!panel) return;
  const scene = origin.closest("[data-scene-group]")?.getAttribute("data-scene-group");
  const scope = scene ? panel.querySelector('[data-scene-group="' + cssAttr(scene) + '"]') : panel;
  const key = origin.closest(".tag-entity")?.getAttribute("data-key") ?? origin.getAttribute("data-key");
  const el = scope?.querySelector<HTMLElement>('.tag-entity[data-key="' + cssAttr(key) + '"] ' + selector);
  if (el) el.focus();
}

function onTagMenuClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest) return;
  if (openTagMenu && !openTagMenu.isConnected) openTagMenu = null;
  const panel = document.querySelector("#production-panel:not([hidden]), #gear-panel:not([hidden])");

  const rename = t.closest('[data-action="tag-rename"]');
  if (rename) {
    const scene = rename.closest("[data-scene-group]")?.getAttribute("data-scene-group");
    const scope = scene ? panel?.querySelector('[data-scene-group="' + cssAttr(scene) + '"]') : panel;
    const key = rename.closest(".tag-entity")?.getAttribute("data-key");
    const input = scope?.querySelector<HTMLInputElement>('.tag-entity[data-key="' + cssAttr(key ?? null) + '"] .tag-rename-input');
    if (input) { input.focus(); input.select(); }
  }

  const redrawn = t.closest(".tag-entity-head, .tag-status-pill");
  if (redrawn && !redrawn.isConnected) {
    refocusIn(panel, redrawn,
      redrawn.getAttribute("data-action") === "tag-status-cycle" ? ".tag-status-pill" : ".tag-entity-head");
    return;
  }

  const btn = t.closest<HTMLButtonElement>(".tag-menu-btn");
  if (btn && btn.closest(".tag-entity")) {
    if (e.defaultPrevented) return;
    const menu = (btn.parentNode as ParentNode).querySelector<HTMLElement>(".tag-menu");
    if (menu && menu === openTagMenu) closeTagMenu(false);
    else openTagMenuFor(btn, e.detail === 0);
    return;
  }
  if (!openTagMenu) {
    const picked = t.closest('.tag-status-seg [data-action="tag-status-set"]');
    if (picked && !picked.isConnected) {
      refocusIn(panel, picked, picked.classList.contains("tag-status-choice")
        ? '.tag-status-choice[data-status="' + cssAttr(picked.getAttribute("data-status")) + '"]'
        : ".tag-status-menu-btn");
    }
    return;
  }
  const item = t.closest(".tag-menu-item");
  if (item && openTagMenu.contains(item)) {
    if (item.classList.contains("armed")) return;
    const fromStatus = item.getAttribute("data-action") === "tag-status-set";
    closeTagMenu(item.isConnected);
    if (fromStatus) refocusIn(panel, item, ".tag-status-menu-btn");
    return;
  }
  if (openTagMenu.contains(t)) return;
  closeTagMenu(false);
}

function onTagMenuKeydown(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest) return;
  if (openTagMenu && !openTagMenu.isConnected) openTagMenu = null;
  const btn = t.closest<HTMLButtonElement>(".tag-menu-btn");
  if (btn && btn.closest(".tag-entity") && !btn.disabled) {
    const own = (btn.parentNode as ParentNode).querySelector<HTMLElement>(".tag-menu");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      openTagMenuFor(btn, true);
    } else if (e.key === "Escape" && own && own === openTagMenu) {
      e.preventDefault();
      e.stopPropagation();
      closeTagMenu(true);
    }
    return;
  }
  const menu = t.closest(".tag-menu");
  if (!menu || menu !== openTagMenu) return;
  const items: HTMLElement[] = Array.prototype.slice.call(menu.querySelectorAll(".tag-menu-item:not(:disabled)"));
  const i = items.indexOf(t);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) (items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length] as HTMLElement).focus();
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) (items[e.key === "Home" ? 0 : items.length - 1] as HTMLElement).focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeTagMenu(true);
  } else if (e.key === "Tab") {
    closeTagMenu(false);
  }
}

function syncGrouping(p: TagPanelPorts): void {
  const production = p.preferences.panelGrouping("production");
  const gear = p.preferences.panelGrouping("gear");
  if (production && ["prep", "cat", "person", "scene", "shoot", "by-scene"].includes(production)) p.view.setProductionGroupBy(production);
  if (gear && ["flat", "scene", "by-scene"].includes(gear)) p.view.setGearGroupBy(gear);
}

export function startTagPanels(nextPorts: TagPanelPorts) {
  ports = nextPorts;
  syncGrouping(nextPorts);
  const stopPreferenceChanges = nextPorts.changes.onChange(change => {
    if (change.name !== "panelGrouping") return;
    syncGrouping(nextPorts);
    renderProduction();
  });
  tagEditPorts = {
    run: (ports as TagPanelPorts).edits.edit, read: (ports as TagPanelPorts).document.read, stamps: (ports as TagPanelPorts).edits.stamps,
    rewrites: (tags, toName) => retagRewrites((ports as TagPanelPorts).text, tags, toName),
    mentions: (doc, tags) => retagMentions((ports as TagPanelPorts).text, doc, tags)
  };
  document.addEventListener("click", onTagMenuClick);
  document.addEventListener("keydown", onTagMenuKeydown, true);

  IS_TOUCH = window.matchMedia && window.matchMedia("(hover: none)").matches;
  let active = true;
  function command<Args extends unknown[], Result>(handler: (...args: Args) => Result) {
    return function (...args: Args) {
      if (active && ports === nextPorts) return handler(...args);
    };
  }
  return {
    openProductionPanel: command(openProductionPanel),
    openGearPanel: command(openGearPanel),
    renderProduction: command(renderProduction),
    saveTagRename: (...args: Parameters<typeof saveTagRename>) => command(saveTagRename)(...args) ?? null,
    addPersonForTag: command(addPersonForTag),
    setTagOwner: command(setTagOwner),
    setTagNotes: command(setTagNotes),
    dispose: function () {
      if (!active) return;
      active = false;
      stopPreferenceChanges();
      document.removeEventListener("click", onTagMenuClick);
      document.removeEventListener("keydown", onTagMenuKeydown, true);
      (ports as TagPanelPorts).deletion.disarm("tag");
      (ports as TagPanelPorts).selection.disarm();
      closeTagMenu(false);
      IS_TOUCH = undefined;
      tagEditPorts = null;
      ports = null;
    }
  };
}
