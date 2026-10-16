import { formatDateClock } from "./00p-prefs.js";
import { isSha256Hex, normalizeImageRef } from "../../shared/blob-policy.js";
import { compareCommentPositions } from "../core/document/comments.ts";
import { normalizeTagName } from "../core/document/tags.ts";
import { hasSetLength } from "../core/document/timing.ts";
import { brollSortedForList } from "../core/production/broll.ts";
import {
  ROW_STATUSES,
  TAG_STATUSES,
  groupTagsByCategory,
  rowStatus,
  tagCategory,
  tagStatus
} from "../core/production/looks.ts";
import { formatDuration, formatTimecode, pad2, rowSeconds as rowSecondsIn } from "../core/production/timing.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { htmlToPlainText } from "../legacy/plain-text.ts";
import { inertBody } from "../legacy/richtext.ts";

export function sceneFacts(doc) {
  var at = 0;
  return (doc.scenes || []).map(function (r, i) {
    var sec = rowSecondsIn(r, doc.document, productionReaders);
    var st = rowStatus(r.status) || ROW_STATUSES[0];
    var out = {
      index: i,
      number: pad2(i + 1),
      start: formatTimecode(at),
      startSeconds: at,
      seconds: sec,
      read: formatDuration(sec),
      readSet: hasSetLength(r),
      status: { id: st.id, label: st.label }
    };
    at += sec;
    return out;
  });
}

function capturedEntries(doc) {
  return doc.production.map(function (e) { return Object.assign({}, e, { cat: tagCategory(e.catId) }); });
}

function capturedShotsByProp(doc) {
  var out = Object.create(null);
  brollSortedForList(doc.broll).forEach(function (e) {
    e.props.forEach(function (p) {
      var k = "prop " + normalizeTagName(p.name);
      if (!out[k]) out[k] = [];
      out[k].push(e.name || "Untitled shot");
    });
  });
  return out;
}

function capturedPerson(doc, id) {
  if (!id) return null;
  for (var i = 0; i < doc.people.length; i++) {
    if (doc.people[i].id === id) return doc.people[i];
  }
  return null;
}

export function breakdownRows(doc) {
  var out = [];
  var shotsFor = capturedShotsByProp(doc);
  groupTagsByCategory(capturedEntries(doc)).forEach(function (g) {
    g.items.forEach(function (item) {
      var scenes = [];
      var seen = {};
      item.mentions.forEach(function (m) {
        if (seen[m.rowIndex]) return;
        seen[m.rowIndex] = true;
        scenes.push(pad2(m.rowIndex + 1));
      });
      var owner = capturedPerson(doc, item.owner);
      var st = tagStatus(item.status) || TAG_STATUSES[0];
      out.push({
        catId: g.cat.id,
        category: g.cat.plural,
        categoryLabel: g.cat.label,
        name: item.name,
        mentions: item.mentions.length,
        owner: owner ? owner.name : "",
        status: st.id,
        statusLabel: st.label,
        notes: item.notes || "",
        inScript: item.orphaned ? "no" : "yes",
        scenes: item.orphaned ? ["not in script"] : scenes,
        broll: shotsFor[item.key] || []
      });
    });
  });
  return out;
}

export function breakdownTable(doc) {
  var starts = sceneFacts(doc).map(function (f) { return f.start; });
  var out = {
    head: ["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "In script", "Notes", "B-roll shots",
           "First scene at", "Group"],
    rows: []
  };
  breakdownRows(doc).forEach(function (r) {
    var first = r.inScript === "no" ? "" : (starts[Number(r.scenes[0]) - 1] || "");
    out.rows.push({ catId: r.catId, status: r.status, cells: [
      r.categoryLabel,
      r.name,
      r.statusLabel,
      r.owner,
      r.mentions,
      r.scenes.join(" "),
      r.inScript,
      r.notes,
      r.broll.join("; "),
      first,
      r.category
    ] });
  });
  return out;
}

export function oneOf(list, id, fallback) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return id;
  return fallback;
}

export var FILTERS = [
  { id: "all",     label: "All" },
  { id: "unshot",  label: "To shoot" },
  { id: "flagged", label: "Flagged" },
  { id: "shot",    label: "Shot" }
];

export var PAGE_GROUPS = [
  { id: "location", label: "Location" },
  { id: "scene",    label: "Scene" },
  { id: "person",   label: "Person" }
];

export function matchesFilter(e, filter) {
  if (filter === "unshot") return e.status !== "shot";
  if (filter === "shot") return e.status === "shot";
  if (filter === "flagged") return e.reshoot;
  return true;
}

export function filterCounts(entries) {
  var n = { all: entries.length, unshot: 0, shot: 0, flagged: 0 };
  entries.forEach(function (e) {
    if (e.status === "shot") n.shot++; else n.unshot++;
    if (e.reshoot) n.flagged++;
  });
  return n;
}

export function pageSummaryText(entries) {
  var n = filterCounts(entries);
  return n.shot + " of " + n.all + " shot" + (n.flagged ? " · " + n.flagged + " flagged" : "");
}

export function personIn(people, id) {
  if (!id) return null;
  for (var i = 0; i < people.length; i++) {
    if (people[i].id === id) return people[i];
  }
  return null;
}

export function sceneLabel(e) {
  return e.rowIndex === -1 ? "" : pad2(e.rowIndex + 1);
}

export function startOf(e, starts) {
  return e.rowId && starts[e.rowId] !== undefined ? formatTimecode(starts[e.rowId]) : "";
}

export function capturedStarts(doc) {
  var t = 0, out = Object.create(null);
  doc.scenes.forEach(function (row) { out[row.id] = t; t += rowSecondsIn(row, doc.document, productionReaders); });
  return out;
}

export function shotRecordForFile(e, people) {
  var who = personIn(people, e.owner);
  return {
    scene: e.rowId ? sceneLabel(e) : "",
    name: e.name || "Untitled shot",
    status: e.status === "shot" ? "Shot" : "To shoot",
    shot: e.status === "shot",
    flagged: !!e.reshoot,
    location: e.location || "",
    props: e.props.map(function (p) { return p.name; }),
    propsWithStatus: e.props.map(function (p) {
      var st = tagStatus(p.status);
      return p.name + (st ? " (" + st.label.toLowerCase() + ")" : "");
    }),
    cuts: e.audioRef || "",
    owner: who ? who.name : "",
    note: e.notes || "",
    desc: e.desc || ""
  };
}

export function brollTable(doc) {
  var out = {
    head: ["Scene", "Shot", "Status", "Flagged", "Location", "Props", "Cuts against", "Assigned to", "Note", "Description",
           "Scene start"],
    rows: []
  };
  var starts = capturedStarts(doc);
  brollSortedForList(doc.broll).forEach(function (e) {
    var r = shotRecordForFile(e, doc.people);
    out.rows.push({ shot: r.shot, flagged: r.flagged, cells: [r.scene, r.name, r.status, r.flagged ? "yes" : "", r.location,
      r.props.join("; "), r.cuts, r.owner, r.note, r.desc, startOf(e, starts)] });
  });
  return out;
}

export function brollShotListForPrint(doc, as) {
  var filterId = oneOf(FILTERS, as && as.filter, "all");
  var groupId = oneOf(PAGE_GROUPS, as && as.group, "scene");
  var entries = doc.broll;
  var shown = entries.filter(function (e) { return matchesFilter(e, filterId); });
  var filter = FILTERS.filter(function (f) { return f.id === filterId; })[0];
  var group = PAGE_GROUPS.filter(function (g) { return g.id === groupId; })[0];
  var starts = capturedStarts(doc);
  return {
    title: doc.title || "Untitled Script",
    summary: pageSummaryText(entries),
    scope: (filter && filter.id !== "all" ? filter.label + ", " : "") + "by " + group.label.toLowerCase(),
    groups: brollGroups(shown, groupId, { rows: doc.scenes, people: doc.people }).map(function (g) {
      return {
        label: g.label,
        kind: g.kind,
        none: !!g.none,
        start: g.row && starts[g.row.id] !== undefined ? formatTimecode(starts[g.row.id]) : "",
        done: g.items.filter(function (e) { return e.status === "shot"; }).length,
        total: g.items.length,
        items: g.items.map(function (e) {
          var rec = shotRecordForFile(e, doc.people);
          rec.start = startOf(e, starts);
          return rec;
        })
      };
    })
  };
}

export function brollGroups(entries, by, from) {
  var rows = from.rows;
  var people = from.people;
  var sorted = brollSortedForList(entries);
  if (by === "flat") return [{ key: "all", kind: "flat", label: "", items: sorted }];
  var groups = [], byKey = Object.create(null);
  sorted.forEach(function (e) {
    var key, label, kind = by, row = null;
    if (by === "scene") {
      if (e.rowIndex === -1) { key = "added"; label = "Added here"; kind = "added"; }
      else { key = "r:" + e.rowId; label = "Scene " + pad2(e.rowIndex + 1); row = rows[e.rowIndex] || null; }
    } else if (by === "location") {
      key = e.location ? "l:" + normalizeTagName(e.location) : "none";
      label = e.location || "No location";
    } else {
      var who = personIn(people, e.owner);
      key = who ? "p:" + who.id : "none";
      label = who ? who.name : "Unassigned";
    }
    if (!byKey[key]) {
      byKey[key] = { key: key, kind: kind, label: label, row: row, items: [], none: key === "none" };
      groups.push(byKey[key]);
    }
    byKey[key].items.push(e);
  });
  if (by !== "scene") {
    groups.sort(function (a, b) {
      if (a.none !== b.none) return a.none ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  }
  return groups;
}

function capturedRowIndex(doc) {
  var at = Object.create(null);
  doc.scenes.forEach(function (row, i) { if (!(row.id in at)) at[row.id] = i; });
  return function (id) { return typeof id === "string" && id in at ? at[id] : -1; };
}

function capturedLocationLabel(rowIndex, field) {
  if (field === "title") return "Document title";
  var rowLabel = rowIndex === -1 ? "Deleted row" : ("Row " + pad2(rowIndex + 1));
  return rowLabel + " · " + (field === "audioText" ? "Audio" : "Visual");
}

export function formatTimestampAbsolute(iso, clockMode) {
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return formatDateClock(d, { year: true }, clockMode);
  } catch (e) { return ""; }
}

export function commentEntries(doc, opts) {
  var pieces = !!(opts && opts.pieces);
  var clockMode = opts && opts.clockMode;
  var rowIndexOf = capturedRowIndex(doc);
  var list = (doc.comments || []).slice();
  list.sort(function (a, b) { return compareCommentPositions(a, b, rowIndexOf); });
  return list.map(function (c) {
    var rowIndex = rowIndexOf(c.rowId);
    var entry = {
      id: c.id,
      rowIndex: c.field === "title" ? -1 : rowIndex,
      field: c.field,
      location: capturedLocationLabel(rowIndex, c.field),
      author: c.author || "Anonymous",
      body: htmlToPlainText(c.body),
      quoted: c.quotedText || "",
      resolved: !!c.resolved,
      resolvedBy: c.resolved ? (c.resolvedBy || "") : "",
      assignee: c.assignee || "",
      when: formatTimestampAbsolute(c.createdAt, clockMode),
      replies: (c.replies || []).map(function (rp) {
        var reply = {
          author: rp.author || "Anonymous",
          body: htmlToPlainText(rp.body),
          when: formatTimestampAbsolute(rp.createdAt, clockMode)
        };
        if (pieces) reply.pieces = bodyPieces(rp.body);
        return reply;
      })
    };
    if (pieces) entry.pieces = commentBodyPieces(c);
    return entry;
  });
}

export function bodyPieces(html) {
  var out = [];
  if (!html) return out;
  var root = inertBody(String(html).replace(/<br\s*\/?>/gi, "\n"));
  if (!root.querySelector("img[data-blob]")) {
    var only = htmlToPlainText(html);
    if (only) out.push({ text: only });
    return out;
  }
  var buf = "";
  function flush() {
    var t = buf.replace(/\u00A0/g, " ").trim();
    if (t) out.push({ text: t });
    buf = "";
  }
  (function walk(node) {
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) { buf += child.nodeValue || ""; return; }
      if (child.nodeType !== 1) return;
      if (child.tagName === "IMG") {
        var sha = child.getAttribute("data-blob");
        if (isSha256Hex(sha)) { flush(); out.push({ image: sha }); }
        return;
      }
      walk(child);
    });
  })(root);
  flush();
  return out;
}

export function commentBodyPieces(c) {
  if (c.kind === "conflict" && c.field === "visualImage") {
    var ref = normalizeImageRef(c.imageValue);
    return ref ? [{ image: ref.sha256 }] : [];
  }
  return bodyPieces(c.body);
}

export var COMMENT_IMAGE_TEXT = "[image]";

export function commentBodyText(entry) {
  var pieces = (entry && entry.pieces) || [];
  if (!pieces.some(function (p) { return p.image; })) return entry.body;
  return pieces.map(function (p) { return p.image ? COMMENT_IMAGE_TEXT : p.text; }).join("\n");
}
