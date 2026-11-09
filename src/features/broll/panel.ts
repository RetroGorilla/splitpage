import { numberHtml } from "../common/number-html.ts";
import { groupItemsByScene } from "../../core/document/scene-items.ts";
import { brollSortedForList } from "../../core/production/broll.ts";
import { exposeTestHook } from "../common/test-hooks.ts";
import { BROLL_NAME_MAX, BROLL_TEXT_MAX } from "../../core/document/broll.ts";
import { tagCategory, tagStatus } from "../../core/production/looks.ts";
import { normalizeTagName } from "../../core/document/tags.ts";
import { formatTimecode, rowSeconds } from "../../core/production/timing.ts";
import { cssAttr } from "../common/dom.ts";
import { BROLL_PANEL_GROUPS as GROUPS, brollGroups as brollGroupsFrom, filterCounts, FILTERS, matchesFilter, pageSummaryText, beatLabel, startOf } from "../../core/production/broll-view.ts";
import { cappedLongText, cappedText, escapeHtml, plainText } from "../../core/document/text-policy.ts";
import { mountBroll } from "./mount.ts";
import { deleteShotCommand, setShotsCommand } from "../../application/commands/broll-records.ts";
import { newBrollRecord, removeBrollProp } from "../../application/commands/production-actions.ts";
import { brollRecord as shotIn, personById as personIn, personNamed } from "../../core/production/records.ts";

import type { BrollPanelEventsPorts, BrollPanelPorts, BrollPanelState } from "./ports.ts";
import type { BrollPorts } from "./mount.ts";
import type { BrollEntry } from "../../core/production/broll.ts";
import type { Person } from "../../core/production/records.ts";
import type { NewBrollPorts } from "../../application/commands/production-actions.ts";
import type { ShotFields } from "../../application/commands/broll-records.ts";
import type { OwnerChoice } from "../../application/commands/production-records.ts";

interface PanelDocument extends Pick<NonNullable<ReturnType<BrollPanelPorts["document"]["current"]>>, "rows" | "brollShots" | "sections"> {
  readonly people?: readonly (Person & Record<string, unknown>)[];
  readonly wordsPerMinute?: number | null | undefined;
}

interface PanelDocumentReader extends Pick<BrollPanelPorts["document"], "read"> {
  readonly current: () => PanelDocument | null;
}

interface PanelPortUse extends Omit<BrollPanelPorts, "document"> {
  readonly document: PanelDocumentReader;
}

type PanelGroup = Omit<ReturnType<typeof brollGroupsFrom>[number], "items"> & { items: BrollEntry[] };
type PanelShot = BrollEntry;
type PanelInput = HTMLInputElement | HTMLTextAreaElement;
type PanelEvent = Parameters<Parameters<typeof mountBroll>[0]["ports"]["click"]>[0];

let ports: BrollPanelPorts | null = null;

const shotEditPorts: NewBrollPorts = { run: (...args) => (ports as PanelPortUse).edits.edit(...args), get ids() { return (ports as PanelPortUse).ids; } };

function productionEntries() {
  return ((ports as PanelPortUse).production.entries as (doc: ReturnType<PanelPortUse["document"]["current"]>) => ReturnType<BrollPanelPorts["production"]["entries"]>)((ports as PanelPortUse).document.current());
}

function setFilter(id: unknown) {
  (ports as PanelPortUse).view.setFilter(id);
  renderBrollViews();
}

let openId: string | null = null;
let renamingId: string | null = null;
let addingPersonFor: string | null = null;
let editingLocFor: string | null = null;
let editingRefFor: string | null = null;
let menuFor: string | null = null;
let groupMenuOpen = false;
let selection: Record<string, boolean> = Object.create(null);
let selectionAnchor: string | null = null;
let bulkInput: string | null = null;

const ICONS: Record<string, string> = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/>',
  go: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H6M11 6l-6 6 6 6"/>',
  pencil: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  unlink: '<path d="M9 17H7a5 5 0 0 1-2.5-9.3M15 7h2a5 5 0 0 1 2.5 9.3M3 3l18 18"/>',
  orphan: '<path d="M4 5h16M4 12h9M4 19h6"/><path d="M16 15l5 5M21 15l-5 5"/>',
  box: '<path d="M4 7.5l8-4 8 4v9l-8 4-8-4z"/><path d="M4 7.5l8 4 8-4M12 11.5v9"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M7 14h10v7H7z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'
};

export function brollIcon(name: string, size?: number, cls?: string) {
  const px = size || 16;
  return '<svg class="broll-ico' + (cls ? " " + cls : "") + '" width="' + px + '" height="' + px +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || "") + '</svg>';
}

function icon(name: string, cls?: string) {
  return '<svg class="broll-si' + (cls ? " " + cls : "") + '" aria-hidden="true" focusable="false"><use href="#i-' +
    name + '"/></svg>';
}

function catColor(id: string) {
  const cat = tagCategory(id);
  return cat ? cat.color : "var(--text-dim)";
}

function initials(name: string) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from((words[0] as string))[0] || "";
  const last = words.length > 1 ? (Array.from((words[words.length - 1] as string))[0] || "") : "";
  return (first + last).toUpperCase();
}

function avatarHtml(person: Person) {
  return '<span class="person-avatar broll-avatar" aria-hidden="true" style="--presence:' +
    escapeHtml((ports as PanelPortUse).personColors.personColor(person.name)) + '">' + escapeHtml(initials(person.name)) + '</span>';
}

function plural(n: number, one: string, many: string) {
  return n + " " + (n === 1 ? one : many);
}

function beatStarts() {
  let t = 0;
  const out: Record<string, number> = Object.create(null);
  const doc = (ports as PanelPortUse).document.current();
  (doc?.rows || []).forEach(function (row) { out[row.id] = t; t += rowSeconds(row, doc, (ports as PanelPortUse).text.productionReaders); });
  return out;
}

function propChipHtml(e: PanelShot, p: BrollEntry["props"][number]) {
  const st = tagStatus(p.status);
  return '<span class="broll-prop-chip' + (p.tracked ? '' : ' is-untracked') + '" title="' +
      escapeHtml(p.auto
        ? p.name + " — tagged on this shot's lines in the script"
        : p.tracked ? p.name + " — added to this shot" : p.name + " — no longer in the breakdown") + '">' +
      (st ? itemLampHtml(st, "", true) : '') +
      '<span class="broll-prop-name">' + escapeHtml(p.name) + '</span>' +
      (st ? '<span class="broll-prop-st">' + escapeHtml(st.label) + '</span>' : '') +
      (p.ref
        ? '<button type="button" class="broll-prop-remove" data-action="broll-prop-remove" data-id="' +
            escapeHtml(e.id) + '" data-ref="' + escapeHtml(p.ref) + '" aria-label="' +
            escapeHtml("Take " + p.name + " off this shot") + '">' + icon("close") + '</button>'
        : '') +
    '</span>';
}

function itemLampHtml(st: NonNullable<ReturnType<typeof tagStatus>>, cls: string, besideWord?: boolean) {
  const named = ' title="' + escapeHtml(st.label) + '"' +
    (besideWord ? ' aria-hidden="true"' : ' role="img" aria-label="' + escapeHtml(st.label) + '"');
  const extra = cls ? " " + cls : "";
  if (st.id === "returned") {
    return '<span class="broll-lamp-returned' + extra + '"' + named + '>' +
      '<svg class="item-lamp is-returned" aria-hidden="true" focusable="false"><use href="#i-return"/></svg></span>';
  }
  return '<span class="item-lamp is-' + escapeHtml(st.id) + extra + '"' + named + '></span>';
}

function propOptionsHtml() {
  const seen: Record<string, boolean> = Object.create(null);
  return productionEntries().filter(function (t) { return t.cat.id === "prop"; })
    .map(function (t) { return t.name; })
    .sort(function (a, b) { return a.localeCompare(b); })
    .filter(function (n) { const k = normalizeTagName(n); if (seen[k]) return false; seen[k] = true; return true; })
    .map(function (n) { return '<option value="' + escapeHtml(n) + '"></option>'; }).join("");
}

function propStatusDot(p: PanelShot["props"][number]) {
  const st = tagStatus(p.status);
  if (!st) return "";
  return '<span class="broll-st-dot is-' + escapeHtml(st.id) + '" title="' + escapeHtml(st.label) +
    '" role="img" aria-label="' + escapeHtml(st.label) + '"></span>';
}

function propListHtml(e: PanelShot) {
  return e.props.map(function (p) {
    return '<span class="broll-prop-item">' + propStatusDot(p) + escapeHtml(p.name) + '</span>';
  }).join(", ");
}

function propLampListHtml(e: PanelShot) {
  return e.props.map(function (p) {
    const st = tagStatus(p.status);
    return '<span class="broll-prop-item">' + (st ? itemLampHtml(st, "broll-prop-lamp") : '') + escapeHtml(p.name) + '</span>';
  }).join(", ");
}

function propListTitle(e: PanelShot) {
  return e.props.map(function (p) {
    const st = tagStatus(p.status);
    return p.name + (st ? " (" + st.label + ")" : "");
  }).join(", ");
}

function propsEditHtml(e: PanelShot) {
  const id = escapeHtml(e.id);
  return '<div class="broll-props">' +
      e.props.map(function (p) { return propChipHtml(e, p); }).join("") +
      '<input type="text" class="broll-prop-input ev-field" data-id="' + id + '" list="broll-prop-options" ' +
        'maxlength="80" placeholder="Add prop" aria-label="Add a prop this shot needs">' +
    '</div>';
}

function knownLocations() {
  const seen: Record<string, boolean> = Object.create(null), out: string[] = [];
  function add(name: string | undefined) {
    const clean = String(name || "").trim();
    const k = normalizeTagName(clean);
    if (!clean || seen[k]) return;
    seen[k] = true;
    out.push(clean);
  }
  productionEntries().forEach(function (t) { if (t.cat.id === "location") add(t.name); });
  ((ports as PanelPortUse).document.current()?.brollShots || []).forEach(function (r) { add(r.location); });
  return out.sort(function (a, b) { return a.localeCompare(b); });
}

function datalistsHtml() {
  return '<datalist id="broll-prop-options">' + propOptionsHtml() + '</datalist>' +
    '<datalist id="broll-loc-options">' + knownLocations().map(function (n) {
      return '<option value="' + escapeHtml(n) + '"></option>';
    }).join("") + '</datalist>';
}

function progressBarHtml(entries: readonly PanelShot[]) {
  const n: Record<string, number> & ReturnType<typeof filterCounts> = filterCounts(entries);
  const gap = n.all <= 12 ? 2 : n.all <= 24 ? 1 : 0;
  return '<div class="broll-bar" role="progressbar" aria-label="Shots done" aria-valuemin="0" aria-valuemax="' + n.all +
      '" aria-valuenow="' + n.shot + '" aria-valuetext="' +
      escapeHtml(n.shot + " of " + n.all + " filmed" + (n.flagged ? ", " + n.flagged + " flagged" : "")) +
      '" style="--seg-gap:' + gap + 'px">' +
      brollSortedForList(entries).map(function (e) {
        const cls = e.reshoot ? "is-flagged" : e.status === "shot" ? "is-shot" : "is-todo";
        return '<span class="broll-bar-seg ' + cls + '"></span>';
      }).join("") +
    '</div>';
}

function summaryHtml(entries: readonly PanelShot[]) {
  const n: Record<string, number> & ReturnType<typeof filterCounts> = filterCounts(entries);
  return '<span class="broll-summary-line"><span class="broll-summary-n">' + n.shot + '</span> of ' +
      '<span class="broll-summary-n">' + n.all + '</span> filmed</span>' +
    progressBarHtml(entries);
}

function filterTabsHtml(entries: readonly PanelShot[]) {
  const n: Record<string, number> & ReturnType<typeof filterCounts> = filterCounts(entries);
  return '<div class="panel-tabs broll-tabs" role="radiogroup" aria-label="Show shots">' +
    FILTERS.map(function (f) {
      const on = f.id === (ports as PanelPortUse).view.current().filter;
      return '<button type="button" class="panel-tab broll-chip' + (on ? ' is-active' : '') +
        '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '" data-action="broll-filter" data-filter="' +
        f.id + '">' + escapeHtml(f.label) + ' <span class="panel-count broll-chip-n">' + n[f.id] + '</span></button>';
    }).join("") +
  '</div>';
}

function filterChipsHtml(entries: readonly PanelShot[]) {
  const n: Record<string, number> & ReturnType<typeof filterCounts> = filterCounts(entries);
  return '<div class="broll-filters" role="radiogroup" aria-label="Show">' +
    FILTERS.map(function (f) {
      const on = f.id === (ports as PanelPortUse).view.current().filter;
      return '<button type="button" class="broll-chip' + (on ? ' is-active' : '') +
        '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '" data-action="broll-filter" data-filter="' +
        f.id + '">' + escapeHtml(f.label) + ' <span class="broll-chip-n">' + n[f.id] + '</span></button>';
    }).join("") +
  '</div>';
}

function groupMenuHtml() {
  const current = GROUPS.filter(function (g) { return g.id === (ports as PanelPortUse).view.current().group; })[0] || (GROUPS[0] as { id: string; label: string; button: string; });
  return '<div class="broll-group-wrap">' +
      '<button type="button" class="broll-group-btn" data-action="broll-group-menu" aria-haspopup="menu" ' +
        'aria-expanded="' + (groupMenuOpen ? 'true' : 'false') + '" title="Group the shots">' + escapeHtml(current.button) +
        icon("chevron-down") + '</button>' +
      (groupMenuOpen
        ? '<div class="broll-menu broll-group-menu" role="menu" aria-label="Group shots by">' +
            GROUPS.map(function (g) {
              const on = g.id === (ports as PanelPortUse).view.current().group;
              return '<button type="button" role="menuitemradio" aria-checked="' + (on ? 'true' : 'false') +
                '" class="broll-menu-item' + (on ? ' is-active' : '') + '" data-action="broll-group" data-group="' +
                g.id + '">' + escapeHtml(g.label) + (on ? icon("check", "broll-menu-check") : '') + '</button>';
            }).join("") +
          '</div>'
        : '') +
    '</div>';
}

function brollGroups(entries: readonly PanelShot[], by: string, from?: Parameters<typeof brollGroupsFrom>[2]) {
  if (by === "by-scene" && !from) {
    const doc = (ports as PanelPortUse).document.current();
    const result = groupItemsByScene(doc ?? { rows: [] }, brollSortedForList(entries), entry => entry.rowId);
    const groups: PanelGroup[] = result.groups.map(({ scene, items }) => ({
      key: scene.id ?? "opening", kind: "script-scene", label: "Scene " + scene.letter + (scene.name ? " · " + scene.name : ""), items
    }));
    if (result.unassigned.length) groups.push({ key: "unassigned", kind: "added", label: "No scene", items: result.unassigned });
    return groups;
  }
  return brollGroupsFrom(entries, by, from || { rows: (ports as PanelPortUse).document.current()?.rows || [], people: ((ports as PanelPortUse).document.current()?.people as readonly (Person & Record<string, unknown>)[] | undefined) || [] }) as PanelGroup[];
}

function doneCountHtml(items: readonly PanelShot[], cls: string) {
  const done = items.filter(function (e) { return e.status === "shot"; }).length;
  return '<span class="' + cls + (done === items.length ? ' is-done' : '') + '">' + done + '/' + items.length + '</span>';
}

function groupHeadHtml(g: PanelGroup, starts: Record<string, number>) {
  if (g.kind === "flat") return "";
  let title, time = "";
  if (g.kind === "scene") {
    title = '<span class="broll-group-scene">' + escapeHtml(g.label) + '</span>';
    if (g.row && starts[g.row.id] !== undefined) {
      time = '<span class="broll-group-time">' + formatTimecode((starts[g.row.id] as number)) + '</span>';
    }
  } else if (g.kind === "location") {
    title = '<span class="broll-group-title">' +
      (g.none ? '' : '<span class="broll-loc-pin">' + icon("pin") + '</span>') +
      escapeHtml(g.label) + '</span>';
  } else {
    title = '<span class="broll-group-title">' + escapeHtml(g.label) + '</span>';
  }
  return '<h3 class="broll-group-head">' + title + time + doneCountHtml(g.items, "broll-group-count") + '</h3>';
}

function rowMetaHtml(e: PanelShot) {
  const parts = [];
  if (e.location) {
    parts.push('<span class="broll-meta-item broll-meta-loc"><span class="broll-loc-pin">' + icon("pin") + '</span>' +
      escapeHtml(e.location) + '</span>');
  }
  const who = personById(e.owner);
  if (who) {
    parts.push('<span class="broll-meta-item broll-meta-owner" title="' + escapeHtml("Assigned to " + who.name) + '">' +
      avatarHtml(who) + '<span class="broll-sr">' + escapeHtml(who.name) + '</span></span>');
  }
  if (e.props.length) {
    parts.push('<span class="broll-meta-item broll-meta-props" title="' + escapeHtml(propListTitle(e)) + '">' +
      propLampListHtml(e) + '</span>');
  }
  return parts.join("");
}

function rowStateIconsHtml(e: PanelShot) {
  let out = "";
  if (e.markerless) {
    out += '<span class="broll-state-ico broll-loose-badge" title="This line has no marker yet, so it is matched ' +
      'by name — click away from the script and it gets one." aria-label="Not anchored yet">' + brollIcon("unlink", 14) + '</span>';
  }
  if (e.orphaned) {
    out += '<span class="broll-state-ico broll-orphan-ico" title="The line this came from is no longer in the script." ' +
      'aria-label="No longer in the script">' + brollIcon("orphan", 14) + '</span>';
  }
  if (e.notes) out += '<span class="broll-state-ico broll-note-ico" title="Has a note" aria-label="Has a note">' + brollIcon("note", 15) + '</span>';
  if (e.reshoot) out += '<span class="broll-state-ico broll-flag-ico" title="Flagged" aria-label="Flagged">' + brollIcon("flag", 15) + '</span>';
  return out;
}

function checkHtml(e: PanelShot) {
  const shot = e.status === "shot";
  return '<button type="button" class="broll-check" role="checkbox" aria-checked="' + (shot ? 'true' : 'false') +
    '" data-action="broll-status-toggle" data-id="' + escapeHtml(e.id) + '" aria-label="' +
    escapeHtml("Filmed: " + (e.name || "Untitled shot")) + '" title="' +
    (shot ? 'Filmed — click to mark To film' : 'To film — click to mark Filmed') +
    '"><span class="broll-check-box">' + icon("check") + '</span></button>';
}

function rowHtml(e: PanelShot, starts: Record<string, number>) {
  const id = escapeHtml(e.id);
  const open = openId === e.id || renamingId === e.id;
  return '<div class="broll-row' + (e.status === "shot" ? ' is-shot' : '') + (e.reshoot ? ' is-flagged' : '') +
      (selection[e.id] ? ' is-selected' : '') + (open ? ' is-open' : '') + (e.orphaned ? ' is-orphaned' : '') +
      '" data-id="' + id + '" aria-selected="' + (selection[e.id] ? 'true' : 'false') + '">' +
      checkHtml(e) +
      '<button type="button" class="broll-row-main" data-action="broll-expand" data-id="' + id +
        '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="broll-row-name">' + (e.shotNumber ? numberHtml(e.shotNumber) + " " : "") + escapeHtml(e.name || "Untitled shot") + '</span>' +
        '<span class="broll-row-meta">' + rowMetaHtml(e) + '</span>' +
      '</button>' +
      '<span class="broll-row-icons">' + rowStateIconsHtml(e) + '</span>' +
      (e.rowId
        ? '<button type="button" class="broll-row-go" data-action="broll-jump" data-id="' + id + '" title="Go to beat ' +
            beatLabel(e) + '">Go to beat' + icon("arrow-right") + '</button>'
        : '') +
    '</div>' +
    (open ? cardHtml(e, starts) : '');
}

function field(label: string, valueHtml: string) {
  return '<dt class="broll-label">' + escapeHtml(label) + '</dt><dd class="broll-value">' + valueHtml + '</dd>';
}

function chevronHtml() {
  return '<svg class="ev-chevron" aria-hidden="true" focusable="false"><use href="#i-chevron-down"/></svg>';
}

const SHOT_STATUSES = [{ id: "unshot", label: "To film" }, { id: "shot", label: "Filmed" }];

function statusLampHtml(status: string) {
  return '<span class="broll-status-lamp' + (status === "shot" ? ' is-shot' : '') + '" aria-hidden="true">' +
    (status === "shot" ? icon("check") : '') + '</span>';
}

function statusFieldHtml(e: PanelShot) {
  const id = escapeHtml(e.id);
  const cur = SHOT_STATUSES.filter(function (s) { return s.id === e.status; })[0] || (SHOT_STATUSES[0] as { id: string; label: string; });
  const next = (SHOT_STATUSES.filter(function (s) { return s.id !== cur.id; })[0] as { id: string; label: string; });
  const says = "Status: " + cur.label + ". Click to mark " + next.label.toLowerCase();
  return '<span class="ev-field broll-status-field">' +
      '<button type="button" class="broll-status-btn" data-action="broll-status-toggle" data-id="' + id + '" data-status="' +
        cur.id + '" aria-label="' + escapeHtml(says) + '" title="' + escapeHtml(says) + '">' +
        statusLampHtml(cur.id) + escapeHtml(cur.label) + '</button>' +
    '</span>';
}

function cardHtml(e: PanelShot, starts: Record<string, number>) {
  const id = escapeHtml(e.id);
  const renaming = renamingId === e.id;

  const when = startOf(e, starts);
  const beat = e.rowId
    ? '<button type="button" class="jump-link broll-scene-link" data-action="broll-jump" data-id="' + id + '" title="Go to beat ' +
        beatLabel(e) + '"><span class="broll-scene-n">' + beatLabel(e) + '</span>' + (when ? ' · ' + when : '') + '</button>'
    : e.orphaned
      ? '<span class="broll-muted">No longer in the script — its line was deleted.</span>'
      : '<span class="broll-muted">Added here</span>';

  const location = editingLocFor === e.id
    ? '<input type="text" class="broll-loc-input ev-field" data-id="' + id + '" list="broll-loc-options" maxlength="80" ' +
        'placeholder="Where it gets shot" aria-label="Location" value="' + escapeHtml(e.location) + '">'
    : '<span class="ev-field broll-loc-field"><button type="button" class="broll-picker" data-action="broll-loc-edit" data-id="' + id +
        '" aria-label="' + escapeHtml("Location: " + (e.location || "none") + ". Change") + '">' +
        (e.location ? escapeHtml(e.location) : '<span class="broll-muted">Choose…</span>') + '</button>' +
        chevronHtml() + '</span>';

  const who = personById(e.owner);
  const assigned = '<div class="broll-owner-row">' +
      '<span class="ev-field broll-owner-field">' + (who ? avatarHtml(who) : '') +
        '<select class="broll-owner-select' + (who ? '' : ' is-empty') + '" data-id="' + id + '" aria-label="Assigned to">' +
          '<option value=""' + (e.owner ? '' : ' selected') + '>Unassigned</option>' +
          (((ports as PanelPortUse).document.current()?.people as readonly (Person & Record<string, unknown>)[] | undefined) || []).map(function (p) {
            return '<option value="' + escapeHtml(p.id) + '"' + (p.id === e.owner ? ' selected' : '') + '>' +
              escapeHtml(p.name) + '</option>';
          }).join("") +
        '</select>' +
        chevronHtml() +
      '</span>' +
      '<button type="button" class="broll-person-btn btn-outline is-small" data-action="broll-person-new" data-id="' + id +
        '" title="Add someone to the crew list">' + icon("plus") + 'Add person</button>' +
    '</div>' +
    (addingPersonFor === e.id
      ? '<div class="broll-owner-row">' +
          '<input type="text" class="broll-person-input ev-field" data-id="' + id + '" placeholder="Their name" maxlength="60" aria-label="New person\'s name">' +
          '<button type="button" class="btn-outline is-small" data-action="broll-person-save" data-id="' + id + '">Add</button>' +
          '<button type="button" class="btn-outline is-small" data-action="broll-person-cancel">Cancel</button>' +
        '</div>'
      : '');

  const cuts = editingRefFor === e.id
    ? '<textarea class="broll-ref-input ev-field" data-id="' + id + '" rows="3" aria-label="Cuts against" ' +
        'placeholder="The line of audio this cuts against">\n' + escapeHtml(e.audioRef) + '</textarea>'
    : '<div class="broll-cuts">' +
        (e.audioRef
          ? '<blockquote class="broll-quote">' + escapeHtml(e.audioRef) + '</blockquote>'
          : '<span class="broll-muted">No line yet</span>') +
        '<button type="button" class="broll-icon-btn" data-action="broll-ref-edit" data-id="' + id +
          '" aria-label="Edit the line this cuts against" title="Edit">' + brollIcon("pencil", 16) + '</button>' +
      '</div>';

  const foot = '<div class="broll-card-foot">' +
      '<button type="button" class="broll-flag-btn btn-outline is-small' + (e.reshoot ? ' is-active' : '') + '"' +
        ' data-action="broll-reshoot-toggle" data-id="' + id + '" aria-pressed="' + (e.reshoot ? 'true' : 'false') + '" title="' +
        (e.reshoot ? 'Flagged — click to clear' : 'Flag it: a reshoot, or anything else worth a second look') + '">' +
        icon("flag") + (e.reshoot ? 'Flagged' : 'Flag for reshoot') + '</button>' +
      '<div class="broll-more-wrap">' +
        '<button type="button" class="broll-more-btn btn-outline is-small is-icon" data-action="broll-menu" data-id="' + id +
          '" aria-haspopup="menu" aria-expanded="' + (menuFor === e.id ? 'true' : 'false') +
          '" aria-label="More actions for this shot" title="More">' + icon("more") + '</button>' +
        (menuFor === e.id
          ? '<div class="broll-menu broll-more-menu" role="menu">' +
              (e.rowId ? '<button type="button" role="menuitem" class="broll-menu-item" data-action="broll-rename" data-id="' + id +
                '">Rename in script</button>' : '') +
              '<button type="button" role="menuitem" class="broll-menu-item danger" data-action="broll-delete" data-id="' + id +
                '">Delete from list</button>' +
            '</div>'
          : '') +
      '</div>' +
    '</div>';

  return '<div class="broll-card" data-id="' + id + '">' +
      (renaming
        ? '<div class="broll-card-rename">' +
            '<input type="text" class="broll-rename-input ev-field" data-id="' + id + '" maxlength="200" aria-label="Shot name" value="' +
              escapeHtml(e.name) + '">' +
            '<button type="button" class="btn-outline is-small" data-action="broll-rename-save" data-id="' + id + '">Save</button>' +
            '<button type="button" class="btn-outline is-small" data-action="broll-rename-cancel">Cancel</button>' +
          '</div>'
        : e.desc ? '<div class="broll-card-desc">' + escapeHtml(e.desc) + '</div>' : '') +
      '<dl class="broll-fields">' +
        field("Status", statusFieldHtml(e)) +
        field("Beat", beat) +
        field("Location", location) +
        field("Assigned", assigned) +
        field("Props", propsEditHtml(e)) +
        field("Cuts against", cuts) +
        field("Note", '<textarea class="broll-notes-input ev-field" data-id="' + id + '" rows="1" aria-label="Note" ' +
          'placeholder="Add a note…">\n' + escapeHtml(e.notes) + '</textarea>') +
      '</dl>' +
      foot +
    '</div>';
}

function selectedIds(entries: readonly PanelShot[]) {
  return entries.filter(function (e) { return selection[e.id]; }).map(function (e) { return e.id; });
}

function bulkBarHtml(entries: readonly PanelShot[]) {
  const chosen = entries.filter(function (e) { return selection[e.id]; });
  if (!chosen.length) return "";
  const allShot = chosen.every(function (e) { return e.status === "shot"; });
  const allFlagged = chosen.every(function (e) { return e.reshoot; });
  return '<div class="broll-bulk-row">' +
      '<span class="broll-bulk-n">' + chosen.length + ' selected</span>' +
      '<button type="button" class="broll-bulk-btn btn-outline is-small" data-action="broll-bulk-shot">' +
        icon("check") + (allShot ? 'Mark to film' : 'Mark filmed') + '</button>' +
      '<select class="broll-bulk-select" id="broll-bulk-owner" aria-label="Assign the selected shots">' +
        '<option value="__none__" selected>Assign</option>' +
        '<option value="">Unassigned</option>' +
        (((ports as PanelPortUse).document.current()?.people as readonly (Person & Record<string, unknown>)[] | undefined) || []).map(function (p) {
          return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>';
        }).join("") +
        '<option value="__new__">+ Person…</option>' +
      '</select>' +
      '<select class="broll-bulk-select" id="broll-bulk-location" aria-label="Set the location of the selected shots">' +
        '<option value="__none__" selected>Location</option>' +
        '<option value="">No location</option>' +
        knownLocations().map(function (n) {
          return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>';
        }).join("") +
        '<option value="__new__">New location…</option>' +
      '</select>' +
      '<button type="button" class="broll-bulk-btn btn-outline is-small" data-action="broll-bulk-flag">' +
        icon("flag") + (allFlagged ? 'Unflag' : 'Flag') + '</button>' +
      '<button type="button" class="broll-bulk-clear" data-action="broll-bulk-clear" aria-label="Clear the selection" ' +
        'title="Clear the selection (Esc)">' + icon("close") + '</button>' +
    '</div>' +
    (bulkInput
      ? '<div class="broll-bulk-row">' +
          '<input type="text" id="broll-bulk-input" class="ev-field" maxlength="' + (bulkInput === "person" ? 60 : 80) + '" placeholder="' +
            (bulkInput === "person" ? 'Their name' : 'Where they get shot') + '" aria-label="' +
            (bulkInput === "person" ? 'New person' : 'New location') + '"' +
            (bulkInput === "location" ? ' list="broll-loc-options"' : '') + '>' +
          '<button type="button" class="broll-bulk-btn btn-outline is-small" data-action="broll-bulk-input-save">' +
            (bulkInput === "person" ? 'Assign' : 'Set') + '</button>' +
          '<button type="button" class="broll-bulk-btn btn-outline is-small" data-action="broll-bulk-input-cancel">Cancel</button>' +
        '</div>'
      : '');
}

function focusKey(el: Element | null) {
  if (!el || el === document.body) return null;
  if (el.id) return "#" + cssAttr(el.id);
  const cls = el.classList && el.classList[0];
  if (!cls) return null;
  let sel = "." + cls;
  ["data-id", "data-action", "data-filter", "data-group", "data-status", "data-ref"].forEach(function (a) {
    const v = el.getAttribute(a);
    if (v !== null) sel += "[" + a + '="' + cssAttr(v) + '"]';
  });
  return sel;
}

const RECORD_INPUTS: { cls: string; field: "notes" | "audioRef" | "location" }[] = [
  { cls: "broll-notes-input", field: "notes" },
  { cls: "broll-ref-input", field: "audioRef" },
  { cls: "broll-loc-input", field: "location" }
];

function recordField(el: Element | null) {
  if (!el || !el.classList || !el.getAttribute || !el.getAttribute("data-id")) return null;
  for (let i = 0; i < RECORD_INPUTS.length; i++) {
    if (el.classList.contains((RECORD_INPUTS[i] as { cls: string; field: "notes" | "audioRef" | "location"; }).cls)) return (RECORD_INPUTS[i] as { cls: string; field: "notes" | "audioRef" | "location"; }).field;
  }
  return null;
}

function typedSinceDrawn(el: PanelInput) {
  return el.value !== el.defaultValue;
}

function typedChange(el: PanelInput) {
  const field = recordField(el);
  const rec = field && brollRecord(el.getAttribute("data-id"));
  if (!rec || !typedSinceDrawn(el)) return null;
  const next = field === "location" ? cappedText(el.value, 80) : cappedLongText(plainText(el.value), BROLL_TEXT_MAX);
  if (rec[(field as "location" | "notes" | "audioRef")] === next) return null;
  const change: Record<string, string> = {};
  change[(field as "location" | "notes" | "audioRef")] = next;
  return change;
}

let drawingPanel = 0;

function keepingFocus(container: HTMLElement, draw: () => void) {
  const active = document.activeElement as PanelInput | null;
  let kept = null;
  if (active && container.contains(active)) {
    const typed = active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.type === "text");
    const ownValue = recordField(active) ? typedSinceDrawn(active) : typed;
    if (ownValue) {
      const change = typedChange(active);
      if (change) writeRecord(active.getAttribute("data-id"), change);
    }
    kept = { key: focusKey(active), typed: typed, ownValue: ownValue, value: active.value,
             start: typed ? active.selectionStart : 0, end: typed ? active.selectionEnd : 0 };
  }
  drawingPanel++;
  try {
    draw();
  } finally {
    drawingPanel--;
  }
  if (!kept || !kept.key) return;
  const again = container.querySelector<PanelInput>(kept.key);
  if (!again) return;
  if (kept.ownValue) again.value = kept.value;
  if (kept.ownValue && recordField(again)) again.defaultValue = kept.value;
  if (kept.typed) {
    try { again.setSelectionRange(kept.start, kept.end); } catch (e) { }
  }
  again.focus({ preventScroll: true });
}

function emptyListHtml(entries: readonly PanelShot[]) {
  if (!entries.length) {
    return '<div class="broll-empty">No b-roll yet.<br><br>Start a line in the Visual column with ' +
      '<code>B-roll:</code> and whatever follows it becomes a shot to track — or add one below.</div>';
  }
  const msg = ({
    unshot: "Nothing left to film — everything on the list is in the can.",
    shot: "Nothing filmed yet.",
    flagged: "Nothing flagged."
  } as Record<string, string>)[(ports as PanelPortUse).view.current().filter] || "No shots match.";
  return '<div class="broll-empty">' + escapeHtml(msg) + '</div>';
}

export function renderBroll() {
  (ports as PanelPortUse).records.updateBrollBadge();
  const panel = document.getElementById("broll-panel");
  if (!panel || panel.hidden || !(ports as PanelPortUse).document.current()) return;
  const summary = document.getElementById("broll-summary");
  const controls = (document.getElementById("broll-controls") as HTMLElement);
  const listEl = (document.getElementById("broll-list") as HTMLElement);
  const bulk = (document.getElementById("broll-bulk") as HTMLElement);

  keepingFocus(panel, function () {
    const entries = (ports as PanelPortUse).records.brollEntries();
    pruneSelection(entries);
    if (summary) summary.innerHTML = entries.length ? summaryHtml(entries) : '';
    controls.innerHTML = entries.length ? filterTabsHtml(entries) + groupMenuHtml() : '';
    const shown = entries.filter(function (e) { return matchesFilter(e, (ports as PanelPortUse).view.current().filter); });
    const starts = beatStarts();
    listEl.innerHTML = datalistsHtml() + (shown.length
      ? brollGroups(shown, (ports as PanelPortUse).view.current().group).map(function (g) {
          return '<div class="broll-group" role="group" aria-label="' + escapeHtml(g.label || "Shots") + '">' +
            groupHeadHtml(g, starts) + g.items.map(function (e) { return rowHtml(e, starts); }).join("") + '</div>';
        }).join("")
      : emptyListHtml(entries));
    const bar = bulkBarHtml(entries);
    bulk.innerHTML = bar;
    bulk.hidden = !bar;
  });
  fitNotes(listEl);
}

function fitNotes(root: HTMLElement) {
  if (typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content")) return;
  Array.prototype.forEach.call(root.querySelectorAll("textarea.ev-field"), fitTextarea);
}

function fitTextarea(box: HTMLTextAreaElement) {
  if (typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content")) return;
  box.style.height = "auto";
  box.style.height = (box.scrollHeight + box.offsetHeight - box.clientHeight) + "px";
}

function renderBrollViews() {
  renderBroll();
  renderBrollPage();
}

export function runBrollRefresh() {
  (ports as PanelPortUse).records.updateBrollBadge();
  renderBrollViews();
}

function entryById(id: string | null) {
  const all = (ports as PanelPortUse).records.brollEntries();
  for (let i = 0; i < all.length; i++) if ((all[i] as BrollEntry).id === id) return all[i];
  return null;
}

function brollRecord(id: unknown) {
  return (ports as PanelPortUse).document.read(function (doc) { return shotIn(doc, id); });
}

function personById(id: unknown) {
  return (ports as PanelPortUse).document.read(function (doc) { return personIn(doc, id); });
}

function writeRecord(id: string | null, fields: ShotFields) {
  if (!brollRecord(id)) return false;
  (ports as PanelPortUse).edits.edit(setShotsCommand([(id as string)], fields));
  return true;
}

function updateRecord(id: string | null, fields: ShotFields) {
  if (writeRecord(id, fields)) renderBrollViews();
}

function toggleBrollShot(id: string | null) {
  const rec = brollRecord(id);
  if (!rec) return;
  updateRecord(id, { status: rec.status === "shot" ? "unshot" : "shot" });
}

function bulkUpdate(fields: ShotFields, describe: (n: number) => string, owner?: OwnerChoice) {
  const entries = (ports as PanelPortUse).records.brollEntries();
  const ids = selectedIds(entries);
  if (!ids.length) return;
  (ports as PanelPortUse).undo.breakCoalescing();
  const n = ids.filter(function (id) {
    const rec = brollRecord(id);
    return rec && Object.keys(fields).some(function (k) { return (rec as NonNullable<ReturnType<typeof brollRecord>>)[k] !== fields[k]; });
  }).length;
  if (!n || !(ports as PanelPortUse).edits.edit(setShotsCommand(ids, fields, owner, (ports as PanelPortUse).ids))) { renderBrollViews(); return; }
  renderBrollViews();
  (ports as PanelPortUse).notices.show(describe(n), "ok");
}

function shotsWord(n: number) { return plural(n, "shot", "shots"); }

function bulkMarkShot() {
  const entries = (ports as PanelPortUse).records.brollEntries().filter(function (e) { return selection[e.id]; });
  const allShot = entries.length && entries.every(function (e) { return e.status === "shot"; });
  const want = allShot ? "unshot" : "shot";
  bulkUpdate({ status: want }, function (n) { return "Marked " + shotsWord(n) + (want === "shot" ? " filmed" : " to film") + "."; });
}

function bulkFlag() {
  const entries = (ports as PanelPortUse).records.brollEntries().filter(function (e) { return selection[e.id]; });
  const want = !(entries.length && entries.every(function (e) { return e.reshoot; }));
  bulkUpdate({ reshoot: want }, function (n) { return (want ? "Flagged " : "Unflagged ") + shotsWord(n) + "."; });
}

function bulkAssign(personId: string) {
  const owner = personById(personId) ? personId : "";
  bulkUpdate({ owner: owner }, function (n) {
    const who = personById(owner);
    return who ? "Assigned " + shotsWord(n) + " to " + who.name + "." : "Unassigned " + shotsWord(n) + ".";
  });
}

function bulkLocation(name: string) {
  const clean = cappedText(name, 80);
  bulkUpdate({ location: clean }, function (n) { return clean ? "Moved " + shotsWord(n) + " to " + clean + "." : "Cleared the location of " + shotsWord(n) + "."; });
}

function bulkAssignNewPerson(name: string) {
  const entries = (ports as PanelPortUse).records.brollEntries();
  const ids = selectedIds(entries);
  if (!ids.length) return;
  (ports as PanelPortUse).undo.breakCoalescing();
  const known = (ports as PanelPortUse).document.read(function (doc) { return personNamed(doc, name); });
  const n = ids.filter(function (sid) {
    const rec = brollRecord(sid);
    return rec && (!known || rec.owner !== known.id);
  }).length;
  if (!(ports as PanelPortUse).edits.edit(setShotsCommand(ids, {}, { name: name }, (ports as PanelPortUse).ids))) { renderBrollViews(); return; }
  renderBrollViews();
  const who = (ports as PanelPortUse).document.read(function (doc) { return personNamed(doc, name); });
  (ports as PanelPortUse).notices.show("Assigned " + shotsWord(n) + " to " + (who ? who.name : "them") + ".", "ok");
}

function clearSelection() {
  selection = Object.create(null);
  selectionAnchor = null;
  bulkInput = null;
}

function pruneSelection(entries: readonly PanelShot[]) {
  const live: Record<string, boolean> = Object.create(null);
  entries.forEach(function (e) { live[e.id] = true; });
  Object.keys(selection).forEach(function (id) { if (!live[id]) Reflect.deleteProperty(selection, id); });
  if (!Object.keys(selection).length) bulkInput = null;
}

function selectWithModifier(e: Partial<Pick<MouseEvent, "shiftKey">>, id: string, orderIds: string[]) {
  if (e.shiftKey && selectionAnchor && orderIds.indexOf(selectionAnchor) !== -1) {
    const a = orderIds.indexOf(selectionAnchor), b = orderIds.indexOf(id);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) selection[(orderIds[i] as string)] = true;
  } else {
    if (selection[id]) Reflect.deleteProperty(selection, id); else selection[id] = true;
    selectionAnchor = id;
  }
  const sel = window.getSelection();
  if (sel && sel.removeAllRanges) sel.removeAllRanges();
}

function shownOrder(container: HTMLElement): string[] {
  return Array.prototype.map.call(container.querySelectorAll(".broll-row[data-id]"), function (r: Element) {
    return r.getAttribute("data-id");
  }) as string[];
}

function addBrollFromPanel() {
  const input = document.getElementById("broll-add-input") as HTMLInputElement | null;
  if (!input) return;
  const name = cappedText(input.value, BROLL_NAME_MAX);
  if (!name) return;
  const rec = newBrollRecord({ name: name, origin: "list" }, shotEditPorts);
  input.value = "";
  openId = rec.id;
  renderBrollViews();
  (ports as PanelPortUse).notices.show("Added to the b-roll list.", "ok");
}

function jumpToBrollShot(id: string | null) {
  const e = entryById(id);
  if (!e || !e.rowId) return false;
  (ports as PanelPortUse).shotHiding.reveal(e.rowId);
  (ports as PanelPortUse).rows.focusField(e.rowId, "visualText");
  return true;
}

function commitPropInput(input: PanelInput) {
  const id = input.getAttribute("data-id");
  const name = input.value;
  input.value = "";
  if (!plainText(name).trim()) return;
  (ports as PanelPortUse).records.addBrollProp((id as string), name);
  renderBrollViews();
  const again = document.querySelector<HTMLInputElement>('.broll-prop-input[data-id="' + cssAttr(id) + '"]');
  if (again) again.focus();
}

function commitLocation(input: PanelInput) {
  editingLocFor = null;
  const change = typedChange(input);
  if (change) updateRecord(input.getAttribute("data-id"), change);
  else renderBrollViews();
}

function renameShot(id: string | null, box: PanelInput | null) {
  const e = entryById(id);
  const next = box ? cappedText(box.value, BROLL_NAME_MAX) : "";
  renamingId = null;
  (ports as PanelPortUse).undo.breakCoalescing();
  if (e && next && next !== e.name) (ports as PanelPortUse).records.renameBrollInScript(e, next);
  renderBrollViews();
}

function deleteShot(id: string | null) {
  const e = entryById(id);
  if (!e) return;
  (ports as PanelPortUse).edits.edit(deleteShotCommand((id as string)));
  if (openId === id) openId = null;
  menuFor = null;
  Reflect.deleteProperty(selection, (id as string));
  renderBrollViews();
  (ports as PanelPortUse).notices.show(e.rowId ? "Removed from the list — the line stays in the script." : "Removed from the list.", "ok");
}

function onBrollClick(e: PanelEvent & Partial<MouseEvent>, root: HTMLElement, exportAs: BrollPanelEventsPorts["exportAs"]) {
  const btn = e.target.closest<HTMLElement>("[data-action]");
  if (!btn || !root.contains(btn)) {
    if (groupMenuOpen || menuFor) { groupMenuOpen = false; menuFor = null; renderBrollViews(); }
    return;
  }
  const action = btn.getAttribute("data-action");
  const id = btn.getAttribute("data-id");

  if (action !== "broll-group-menu" && action !== "broll-group") groupMenuOpen = false;
  if (action !== "broll-menu" && action !== "broll-rename" && action !== "broll-delete") menuFor = null;

  if (action === "broll-status-toggle") {
    e.stopPropagation();
    const fromField = btn.classList.contains("broll-status-btn");
    toggleBrollShot(id);
    const again = fromField && root.querySelector<HTMLInputElement>('.broll-status-btn[data-id="' + cssAttr(id) + '"]');
    if (again) again.focus();
  } else if (action === "broll-expand") {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      selectWithModifier(e, (id as string), shownOrder(root));
      renderBrollViews();
      return;
    }
    openId = openId === id ? null : id;
    renamingId = null; editingLocFor = null; editingRefFor = null; addingPersonFor = null;
    renderBrollViews();
  } else if (action === "broll-reshoot-toggle") {
    const rec = brollRecord(id);
    if (!rec) return;
    const raising = !rec.reshoot;
    openId = id;
    updateRecord(id, { reshoot: raising });
    if (raising) {
      const notes = root.querySelector<HTMLInputElement>('.broll-notes-input[data-id="' + cssAttr(id) + '"]');
      if (notes) notes.focus();
    }
  } else if (action === "broll-jump") {
    jumpToBrollShot(id);
  } else if (action === "broll-filter") {
    setFilter(btn.getAttribute("data-filter"));
  } else if (action === "broll-group-menu") {
    groupMenuOpen = !groupMenuOpen;
    renderBrollViews();
    if (groupMenuOpen) {
      const first = root.querySelector<HTMLInputElement>('.broll-group-menu .broll-menu-item.is-active, .broll-group-menu .broll-menu-item');
      if (first) first.focus();
    }
  } else if (action === "broll-group") {
    (ports as PanelPortUse).view.setGroup(btn.getAttribute("data-group"));
    (ports as PanelPortUse).preferences.setPanelGrouping("broll", (ports as PanelPortUse).view.current().group);
    groupMenuOpen = false;
    renderBrollViews();
    const gb = root.querySelector<HTMLInputElement>(".broll-group-btn");
    if (gb) gb.focus();
  } else if (action === "broll-menu") {
    menuFor = menuFor === id ? null : id;
    renderBrollViews();
  } else if (action === "broll-rename") {
    menuFor = null;
    renamingId = id;
    openId = id;
    renderBrollViews();
    const input = root.querySelector<HTMLInputElement>('.broll-rename-input[data-id="' + cssAttr(id) + '"]');
    if (input) { input.focus(); input.select(); }
  } else if (action === "broll-rename-save") {
    renameShot(id, root.querySelector<HTMLInputElement>('.broll-rename-input[data-id="' + cssAttr(id) + '"]'));
  } else if (action === "broll-rename-cancel") {
    renamingId = null;
    renderBrollViews();
  } else if (action === "broll-delete") {
    deleteShot(id);
  } else if (action === "broll-loc-edit") {
    editingLocFor = id;
    renderBrollViews();
    const loc = root.querySelector<HTMLInputElement>('.broll-loc-input[data-id="' + cssAttr(id) + '"]');
    if (loc) { loc.focus(); loc.select(); }
  } else if (action === "broll-ref-edit") {
    editingRefFor = id;
    renderBrollViews();
    const ref = root.querySelector<HTMLInputElement>('.broll-ref-input[data-id="' + cssAttr(id) + '"]');
    if (ref) ref.focus();
  } else if (action === "broll-prop-remove") {
    removeBrollProp((id as string), (btn.getAttribute("data-ref") as string), shotEditPorts);
    renderBrollViews();
  } else if (action === "broll-person-new") {
    addingPersonFor = id;
    renderBrollViews();
    const pi = root.querySelector<HTMLInputElement>('.broll-person-input[data-id="' + cssAttr(id) + '"]');
    if (pi) pi.focus();
  } else if (action === "broll-person-save") {
    const nameBox = root.querySelector<HTMLInputElement>('.broll-person-input[data-id="' + cssAttr(id) + '"]');
    addingPersonFor = null;
    (ports as PanelPortUse).undo.breakCoalescing();
    const named = nameBox ? nameBox.value : "";
    if (brollRecord(id)) (ports as PanelPortUse).edits.edit(setShotsCommand([(id as string)], {}, { name: named }, (ports as PanelPortUse).ids));
    renderBrollViews();
  } else if (action === "broll-person-cancel") {
    addingPersonFor = null;
    renderBrollViews();
  } else if (action === "broll-bulk-shot") {
    bulkMarkShot();
  } else if (action === "broll-bulk-flag") {
    bulkFlag();
  } else if (action === "broll-bulk-clear") {
    clearSelection();
    renderBrollViews();
  } else if (action === "broll-bulk-input-save") {
    const box = document.getElementById("broll-bulk-input") as HTMLInputElement | null;
    const value = box ? box.value : "";
    const mode = bulkInput;
    bulkInput = null;
    if (mode === "person") bulkAssignNewPerson(value);
    else if (mode === "location" && plainText(value).trim()) bulkLocation(value);
    else renderBrollViews();
  } else if (action === "broll-bulk-input-cancel") {
    bulkInput = null;
    renderBrollViews();
  } else {
    onBrollPageAction(action, btn, exportAs);
  }
}

function onBrollChange(e: PanelEvent) {
  const t = e.target as PanelInput;
  if (t.classList.contains("broll-owner-select")) {
    updateRecord(t.getAttribute("data-id"), { owner: personById(t.value) ? t.value : "" });
  } else if (t.id === "broll-bulk-owner") {
    if (t.value === "__new__") { bulkInput = "person"; renderBrollViews(); focusBulkInput(); }
    else if (t.value !== "__none__") bulkAssign(t.value);
  } else if (t.id === "broll-bulk-location") {
    if (t.value === "__new__") { bulkInput = "location"; renderBrollViews(); focusBulkInput(); }
    else if (t.value !== "__none__") bulkLocation(t.value);
  }
}

function focusBulkInput() {
  const box = document.getElementById("broll-bulk-input");
  if (box) box.focus();
}

function onBrollFocusOut(e: PanelEvent) {
  if (drawingPanel) return;
  const el = e.target as PanelInput;
  const field = recordField(el);
  if (!field || !brollRecord(el.getAttribute("data-id"))) return;
  if (field === "location") { commitLocation(el); return; }
  if (field === "audioRef") editingRefFor = null;
  const change = typedChange(el);
  if (change) updateRecord(el.getAttribute("data-id"), change);
  else if (field === "audioRef") renderBrollViews();
}

function onBrollKeydown(e: PanelEvent, root: HTMLElement) {
  const t = e.target as PanelInput;
  const onPage = root.id === "broll-page";
  if (e.key === "Escape") {
    let refocus = null;
    if (groupMenuOpen) { groupMenuOpen = false; refocus = ".broll-group-btn"; }
    else if (menuFor) { refocus = '[data-action="broll-menu"][data-id="' + cssAttr(menuFor) + '"]'; menuFor = null; }
    else if (t.classList.contains("broll-loc-input")) editingLocFor = null;
    else if (t.classList.contains("broll-ref-input")) editingRefFor = null;
    else if (t.classList.contains("broll-rename-input")) renamingId = null;
    else if (t.classList.contains("broll-person-input")) addingPersonFor = null;
    else if (t.id === "broll-bulk-input") bulkInput = null;
    else if (!onPage && Object.keys(selection).length) clearSelection();
    else if (!onPage && openId) {
      refocus = '.broll-row-main[data-id="' + cssAttr(openId) + '"]';
      openId = null;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    renderBrollViews();
    const back = refocus && root.querySelector<HTMLInputElement>(refocus);
    if (back) back.focus();
    return;
  }
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && t.classList && t.classList.contains("broll-menu-item")) {
    const items: HTMLElement[] = Array.prototype.slice.call((t.parentNode as ParentNode).querySelectorAll(".broll-menu-item"));
    const at = items.indexOf(t) + (e.key === "ArrowDown" ? 1 : -1);
    e.preventDefault();
    (items[(at + items.length) % items.length] as HTMLElement).focus();
    return;
  }
  if (e.key !== "Enter") return;
  if (t.id === "broll-add-input") { e.preventDefault(); addBrollFromPanel(); }
  else if (t.classList.contains("broll-prop-input")) { e.preventDefault(); commitPropInput(t); }
  else if (t.classList.contains("broll-loc-input")) { e.preventDefault(); commitLocation(t); }
  else if (t.classList.contains("broll-rename-input")) {
    e.preventDefault();
    renameShot(t.getAttribute("data-id"), t);
  } else if (t.classList.contains("broll-person-input")) {
    e.preventDefault();
    const add = root.querySelector<HTMLInputElement>('[data-action="broll-person-save"][data-id="' + cssAttr(t.getAttribute("data-id")) + '"]');
    if (add) add.click();
  } else if (t.id === "broll-bulk-input") {
    e.preventDefault();
    const save = root.querySelector<HTMLInputElement>('[data-action="broll-bulk-input-save"]');
    if (save) save.click();
  }
}

function onBrollInput(e: PanelEvent & Partial<Pick<InputEvent, "inputType">>) {
  const box = e.target as HTMLTextAreaElement;
  if (box.tagName === "TEXTAREA" && box.classList.contains("ev-field")) fitTextarea(box);
  if (box.classList && box.classList.contains("broll-prop-input") &&
      (e.inputType === "insertReplacementText" || e.inputType === undefined)) {
    commitPropInput(box);
  }
}

export function openBrollPanel() {
  if (!(ports as PanelPortUse).document.current()) return;
  const savedGroup = (ports as PanelPortUse).preferences.panelGrouping("broll");
  if (savedGroup && savedGroup !== (ports as PanelPortUse).view.current().group) (ports as PanelPortUse).view.setGroup(savedGroup);
  (ports as PanelPortUse).panels.open("broll-panel");
  renderBroll();
}

function brollPanelClosed() {
  groupMenuOpen = false;
  menuFor = null;
}

let brollMount: ReturnType<typeof mountBroll> | null = null;
let brollPanelRegistration: (() => void) | null = null;

export function mountBrollPanel(exportPort: BrollPanelEventsPorts) {
  stopBrollFeature();
  brollPanelRegistration = (ports as PanelPortUse).panels.registerPanel("broll-panel", brollPanelClosed);
  const panel = document.getElementById("broll-panel");
  const page = brollPageEl();
  brollMount = mountBroll({
    window: window,
    ports: {
      click: function (event, root) { onBrollClick(event, root, exportPort.exportAs); },
      change: onBrollChange,
      focusout: onBrollFocusOut,
      keydown: onBrollKeydown,
      input: onBrollInput,
      add: addBrollFromPanel,
      closePanel: function () { (ports as PanelPortUse).panels.close("broll-panel"); },
      openPanel: function () { (ports as PanelPortUse).actions.invoke("panel-broll", "button"); },
      closePage: closeBrollPage,
      pageOpen: function () { return (ports as PanelPortUse).flags.brollPageOpen(); },
      screen: (ports as PanelPortUse).screen,
      setPageGroup: function (value) {
        (ports as PanelPortUse).view.setPageGroup(value);
        renderBrollPage();
      },
      menusOpen: function () { return groupMenuOpen || !!menuFor; },
      closeMenus: function () { groupMenuOpen = false; menuFor = null; },
      hasSelection: function () { return !!Object.keys(selection).length; },
      clearSelection: clearSelection,
      render: renderBrollViews,
      refresh: runBrollRefresh,
      reset: function () {
        openId = null; renamingId = null; addingPersonFor = null;
        editingLocFor = null; editingRefFor = null;
        groupMenuOpen = false; menuFor = null;
        clearSelection();
        pageReturnFocus = null; pagePanelWasOpen = false;
        if (panel && document.getElementById("broll-panel") === panel) panel.hidden = true;
        if (page && brollPageEl() === page) {
          page.hidden = true;
          (ports as PanelPortUse).flags.setBrollPageOpen(false);
          document.body.classList.remove("broll-page-open");
        }
        (ports as PanelPortUse).panels.sync();
      }
    } as BrollPorts & { readonly refresh: () => void }
  });
  return brollMount;
}

export function stopBrollFeature() {
  const owner = brollMount;
  const registration = brollPanelRegistration;
  brollMount = null;
  brollPanelRegistration = null;
  if (registration) registration();
  if (owner) owner.dispose();
}

let pageReturnFocus: Element | null = null;
let pagePanelWasOpen = false;

function brollPageEl() {
  return document.getElementById("broll-page");
}

export function openBrollPage() {
  const page = brollPageEl();
  if (!page || !(ports as PanelPortUse).document.current()) return;
  pageReturnFocus = document.activeElement;
  const panel = document.getElementById("broll-panel");
  pagePanelWasOpen = !!panel && !panel.hidden;
  groupMenuOpen = false;
  menuFor = null;
  (ports as PanelPortUse).panels.closeAll();
  page.hidden = false;
  (ports as PanelPortUse).flags.setBrollPageOpen(true);
  document.body.classList.add("broll-page-open");
  renderBrollPage();
  const back = document.getElementById("broll-page-close");
  if (back) back.focus();
}

export function closeBrollPage(andThen?: () => void) {
  const page = brollPageEl();
  if (!page || page.hidden) return;
  page.hidden = true;
  (ports as PanelPortUse).flags.setBrollPageOpen(false);
  document.body.classList.remove("broll-page-open");
  if (pagePanelWasOpen) openBrollPanel();
  if (andThen) { andThen(); return; }
  const back = pageReturnFocus;
  pageReturnFocus = null;
  if (back && document.body.contains(back) && (back as HTMLElement).offsetParent !== null) (back as HTMLElement).focus();
  else {
    const btn = document.getElementById(pagePanelWasOpen ? "broll-open-page" : "btn-broll");
    if (btn) btn.focus();
  }
}

function pageGroupHeadHtml(g: PanelGroup) {
  const done = g.items.filter(function (e) { return e.status === "shot"; }).length;
  let title;
  if (g.kind === "location") {
    title = (g.none ? '' : '<span class="broll-loc-pin" style="--loc:' + catColor("location") + '">' + brollIcon("pin", 15) + '</span>') +
      '<span class="broll-page-group-name">' + escapeHtml(g.label) + '</span>';
  } else if (g.kind === "scene") {
    title = '<span class="broll-page-group-scene">' + escapeHtml(g.label) + '</span>';
  } else if (g.kind === "added") {
    title = '<span class="broll-page-group-name">' + escapeHtml(g.label) + '</span>';
  } else {
    const who = g.none ? null : personById((g.items[0] as BrollEntry).owner);
    title = (who ? avatarHtml(who) : '') + '<span class="broll-page-group-name">' + escapeHtml(g.label) + '</span>';
  }
  return '<tr class="broll-page-group"><th colspan="7" scope="rowgroup"><span class="broll-page-group-in">' + title +
    '<span class="broll-page-group-count' + (done === g.items.length ? ' is-done' : '') + '">' +
    done + '/' + g.items.length + ' filmed</span></span></th></tr>';
}

function pageRowHtml(e: PanelShot) {
  const id = escapeHtml(e.id);
  const props = e.props.map(function (p) { return p.name; }).join(", ");
  return '<tr class="broll-page-row' + (e.status === "shot" ? ' is-shot' : '') + (e.reshoot ? ' is-flagged' : '') +
      '" data-id="' + id + '">' +
    '<td class="broll-page-c-check">' + checkHtml(e) + '</td>' +
    '<td class="broll-page-c-shot" data-label="Shot"><span class="broll-row-name" title="' + escapeHtml(e.name || "Untitled shot") + '">' +
      (e.shotNumber ? numberHtml(e.shotNumber) + " " : "") + escapeHtml(e.name || "Untitled shot") + '</span>' + rowStateIconsHtml(Object.assign({}, e, { notes: "", reshoot: false })) + '</td>' +
    '<td class="broll-page-c-scene" data-label="Beat">' + (e.rowId
      ? '<button type="button" class="broll-page-scene" data-action="broll-page-jump" data-id="' + id + '" title="Go to beat ' +
          beatLabel(e) + '">' + beatLabel(e) + '</button>'
      : '<span class="broll-muted" title="' + (e.orphaned ? 'No longer in the script' : 'Added here') + '">—</span>') + '</td>' +
    '<td class="broll-page-c-props" data-label="Props" style="--prop:' + catColor("prop") + '">' +
      (props ? '<span class="broll-page-ellipsis" title="' + escapeHtml(propListTitle(e)) + '">' + propListHtml(e) + '</span>' : '<span class="broll-muted">—</span>') + '</td>' +
    '<td class="broll-page-c-cuts" data-label="Cuts against">' +
      (e.audioRef ? '<span class="broll-page-ellipsis broll-page-cuts" title="' + escapeHtml(e.audioRef) + '">' + escapeHtml(e.audioRef) + '</span>' : '<span class="broll-muted">—</span>') + '</td>' +
    '<td class="broll-page-c-owner" data-label="Assigned">' +
      '<select class="broll-owner-select broll-page-owner" data-id="' + id + '" aria-label="' + escapeHtml("Assigned to, " + (e.name || "Untitled shot")) + '">' +
        '<option value=""' + (e.owner ? '' : ' selected') + '>Unassigned</option>' +
        (((ports as PanelPortUse).document.current()?.people as readonly (Person & Record<string, unknown>)[] | undefined) || []).map(function (p) {
          return '<option value="' + escapeHtml(p.id) + '"' + (p.id === e.owner ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
        }).join("") +
      '</select></td>' +
    '<td class="broll-page-c-note" data-label="Note">' +
      (e.reshoot ? '<span class="broll-flag-ico" title="Flagged" aria-label="Flagged">' + brollIcon("flag", 14) + '</span>' : '') +
      '<textarea class="broll-notes-input broll-page-note" data-id="' + id + '" rows="1" maxlength="2000" ' +
        'placeholder="Add a note" aria-label="' + escapeHtml("Note, " + (e.name || "Untitled shot")) + '">\n' + escapeHtml(e.notes) + '</textarea></td>' +
  '</tr>';
}

function renderBrollPage() {
  const page = brollPageEl();
  if (!page || page.hidden || !(ports as PanelPortUse).document.current()) return;
  keepingFocus(page, function () {
    const entries = (ports as PanelPortUse).records.brollEntries();
    const shown = entries.filter(function (e) { return matchesFilter(e, (ports as PanelPortUse).view.current().filter); });
    (document.getElementById("broll-page-summary") as HTMLElement).textContent = pageSummaryText(entries);
    const sel = document.getElementById("broll-page-group") as HTMLSelectElement | null;
    if (sel) sel.value = (ports as PanelPortUse).view.current().pageGroup;
    (document.getElementById("broll-page-filters") as HTMLElement).innerHTML = filterChipsHtml(entries);
    (document.getElementById("broll-page-table") as HTMLElement).innerHTML = shown.length
      ? '<table class="broll-page-table">' +
          '<colgroup><col class="broll-page-w-check"><col class="broll-page-w-shot"><col class="broll-page-w-scene">' +
          '<col class="broll-page-w-props"><col class="broll-page-w-cuts"><col class="broll-page-w-owner"><col class="broll-page-w-note"></colgroup>' +
          '<thead><tr><th scope="col"><span class="broll-sr">Filmed or to film</span></th><th scope="col">Shot</th><th scope="col">Beat</th>' +
            '<th scope="col">Props</th><th scope="col">Cuts against</th><th scope="col">Assigned</th><th scope="col">Note</th></tr></thead>' +
          brollGroups(shown, (ports as PanelPortUse).view.current().pageGroup).map(function (g) {
            return '<tbody>' + pageGroupHeadHtml(g) + g.items.map(pageRowHtml).join("") + '</tbody>';
          }).join("") +
        '</table>'
      : emptyListHtml(entries);
  });
}

function onBrollPageAction(action: string | null, btn: HTMLElement, exportAs: BrollPanelEventsPorts["exportAs"]) {
  if (action === "broll-open-page") openBrollPage();
  else if (action === "broll-page-close") closeBrollPage();
  else if (action === "broll-page-jump") {
    const id = btn.getAttribute("data-id");
    closeBrollPage(function () { jumpToBrollShot(id); });
  } else if (action === "broll-page-csv") exportAs("b-roll csv");
  else if (action === "broll-page-print") {
    if (!(ports as PanelPortUse).records.brollEntries().length) { (ports as PanelPortUse).notices.show("There is no b-roll to print yet.", "warn"); return; }
    exportAs("b-roll pdf");
  }
}

export function startBrollPanel(nextPorts: BrollPanelPorts): BrollPanelState {
  ports = nextPorts;
  (ports as PanelPortUse).view.load();
  const savedGroup = (ports as PanelPortUse).preferences.panelGrouping("broll");
  if (savedGroup) (ports as PanelPortUse).view.setGroup(savedGroup);
  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__brollTest", function () { return {
    view: function () { return (ports as PanelPortUse).view.current(); },
    selected: function () { return Object.keys(selection); }
  }; }, function (withdraw) { withdrawHook = withdraw; });
  let active = true;
  return { openShot: function (id) {
    if (!active) return;
    const entry = (ports as PanelPortUse).records.brollEntries().find(shot => shot.id === id);
    if (!entry) return;
    if (!matchesFilter(entry, (ports as PanelPortUse).view.current().filter)) (ports as PanelPortUse).view.setFilter("all");
    openId = id;
    openBrollPanel();
    document.querySelector<HTMLElement>('.broll-row-main[data-id="' + cssAttr(id) + '"]')?.scrollIntoView({ block: "nearest" });
  }, openBrollPanel: function () { if (active) openBrollPanel(); }, dispose: function () {
    if (!active) return;
    active = false;
    stopBrollFeature();
    ports = null;
    if (withdrawHook) withdrawHook();
  } };
}
