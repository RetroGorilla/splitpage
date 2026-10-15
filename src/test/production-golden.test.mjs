import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { cellOf } from "../js/04c-doc-model.js";
import {
  TAG_CATEGORIES, TAG_STATUSES, bulkTagCell, bulkTagRows, healTagRegistry, nextTagStatus, normalizeTagName, productionEntries,
  registryKey, tagCategory, tagKey, tagOccurrences, tagStatus, tagStatusRank, tagsByCategory, tagsInField
} from "../js/07-production-tags.js";
import {
  BROLL_NAME_MAX, BROLL_PROPS_MAX, BROLL_STATUSES, BROLL_TEXT_MAX, __init as initBroll, anchorBrollInRows, brollEntries, derivedRecordsPlan,
  brollInCell, brollPropKey, brollShotsByProp, brollStatus, normalizeBrollProps
} from "../js/08c-broll.js";
import { __init as initHistory } from "../js/03a-history-store.js";
import { applyGearQuickAdd } from "../js/08-production-panels.js";
import { LONG_DEMO } from "../js/_starters.js";
import { assertGolden, freezeClockAndRandom, goldenNames, jsonCopy, maskTokens, newTokens } from "./golden-helpers.mjs";
import { startSaves } from "../legacy/save-bridge.ts";
import { WHOLE_DOCUMENT } from "../application/session/change-set.ts";

freezeClockAndRandom(0x70726f64);
startSaves({
  write: async () => ({ kind: "saved" }),
  destination: () => null,
  keyOf: () => ({ owner: null, name: "none" }),
  obsolete: () => {},
  running: () => {},
  ownership: { capture: () => { throw new Error("no save runs here"); }, stillOwns: () => false }
});
initBroll();
initHistory();

const MINTED_SHOT = /\bbs[0-9a-z]{6,}\b/g;

const tag = (cat, name, text) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${text === undefined ? name : text}</span>`;
const key = (id, text) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">${text || "B-roll:"}</span>`;
const cue = (inner) => `<span class="audio-cue">${inner}</span>`;
const anchor = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;

function row(id, audioText, visualText, extra) {
  return Object.assign({
    id, status: "todo", visualText: visualText || "", audioText: audioText || "",
    imageRef: null, updatedAt: "2026-03-01T09:00:00.000Z", updatedBy: "Sam"
  }, extra || {});
}
const tagEntry = (id, cat, name, extra) => Object.assign({ id, cat, name, owner: "", notes: "", status: "needed" }, extra || {});
const shot = (id, name, extra) => Object.assign({
  id, name, desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "",
  props: [], origin: "script"
}, extra || {});

function load(spec) {
  S.state = migrateRows(jsonCopy(spec));
  S.state.brollShots = migrateRows(Object.assign(jsonCopy(spec), { rows: [] })).brollShots;
  return jsonCopy(S.state);
}

const sha256 = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const unchangedOr = (before, now) => (JSON.stringify(before) === JSON.stringify(now) ? "unchanged" : jsonCopy(now));
const sameAsOr = (label, earlier, now) => (JSON.stringify(earlier) === JSON.stringify(now) ? "same as " + label : now);

function entriesView(list) {
  return list.map((e) => {
    assert.equal(e.cat, tagCategory(e.cat.id), "an entry's category is the presentation table's own object");
    return Object.assign({}, e, { cat: e.cat.id });
  });
}

const categoriesView = (groups) => groups.map((g) => ({ cat: g.cat.id, items: g.items.map((e) => e.key) }));

function brollView(list) {
  return list.map((e) => {
    const at = S.state.brollShots.indexOf(e.rec);
    return Object.assign({}, e, { rec: at === -1 ? { fresh: jsonCopy(e.rec) } : { stored: at } });
  });
}

function occurrencesOf(names) {
  return names.map(({ cat, name }) => {
    const hits = [];
    S.state.rows.forEach((r) => {
      ["visualText", "audioText"].forEach((field) => {
        const found = tagOccurrences(cellOf(r[field]), name);
        if (found.length) hits.push({ rowId: r.id, field, ranges: found.map((m) => [m.from, m.to]) });
      });
    });
    return { cat, name, hits, visualColumnCount: bulkTagRows(jsonCopy(S.state.rows), name, cat, name, false, true) };
  });
}

function readAll() {
  const before = JSON.stringify(S.state);
  const out = {
    entries: entriesView(productionEntries()),
    byCategory: categoriesView(tagsByCategory()),
    brollRead: brollView(brollEntries()),
    shotsByProp: jsonCopy(brollShotsByProp())
  };
  out.readsWroteNothing = JSON.stringify(S.state) === before;
  return out;
}

function repairAll(out) {
  const registryBefore = jsonCopy(S.state.productionTags);
  out.healed = healTagRegistry();
  out.registryAfterHeal = unchangedOr(registryBefore, S.state.productionTags);
  out.entriesAfterHeal = sameAsOr("entries", out.entries, entriesView(productionEntries()));
  out.healedAgain = healTagRegistry();
  const shotsBefore = jsonCopy(S.state.brollShots);
  const records = derivedRecordsPlan(S.state, WHOLE_DOCUMENT);
  if (records) records.apply(S.state);
  const repair = brollView(brollEntries());
  out.brollRepair = sameAsOr("brollRead", out.brollRead, repair);
  out.shotsAfterRepair = unchangedOr(shotsBefore, S.state.brollShots);
  const rowsBefore = jsonCopy(S.state.rows.map((r) => r.visualText));
  out.anchored = anchorBrollInRows(S.state.rows);
  out.visualAfterAnchoring = unchangedOr(rowsBefore, S.state.rows.map((r) => r.visualText));
  out.brollAfterAnchoring = sameAsOr("brollRepair", repair, brollView(brollEntries()));
  return out;
}

function masked(out, input) {
  const tokens = newTokens(out, input, MINTED_SHOT);
  tokens.forEach((t) => assert.match(t, /^bs[0-9a-z]+$/));
  return maskTokens(out, tokens, "minted-broll-id");
}

function demo() {
  const s = jsonCopy(LONG_DEMO.state);
  s.docId = "d" + "7".repeat(32);
  return s;
}

const SCENARIOS = [];

SCENARIOS.push({
  name: "long-demo",
  run() {
    const input = load(demo());
    const out = { demoSha256: sha256(LONG_DEMO.state) };
    Object.assign(out, readAll());
    out.occurrences = occurrencesOf(S.state.productionTags.map((t) => ({ cat: t.cat, name: t.name })));
    repairAll(out);
    return masked(out, input);
  }
});

SCENARIOS.push({
  name: "long-demo-registry-emptied",
  run() {
    const input = load(demo());
    S.state.productionTags = [];
    const out = { demoSha256: sha256(LONG_DEMO.state) };
    Object.assign(out, readAll());
    repairAll(out);
    return masked(out, input);
  }
});

SCENARIOS.push({
  name: "long-demo-shots-dropped",
  run() {
    const input = load(demo());
    S.state.brollShots = [];
    const out = { demoSha256: sha256(LONG_DEMO.state) };
    Object.assign(out, readAll());
    repairAll(out);
    return masked(out, input);
  }
});

SCENARIOS.push({
  name: "broll-crafted",
  run() {
    const input = load({
      schema: 2, title: "Harbour", docId: "d" + "8".repeat(32),
      people: [{ id: "p1", name: "Sam" }],
      productionTags: [tagEntry("t_kettle", "prop", "Kettle", { status: "have" }), tagEntry("t_tripod", "prop", "Tripod")],
      rows: [
        row("r1", "Waves on the " + tag("location", "Pier", "pier") + ".",
          key("bs_keep") + " the gulls<br>over the pier<br>B-roll: drone sweep<br>low and slow<br>b roll - " +
            tag("prop", "Kettle", "kettle") + " steam rising"),
        row("r2", "Boats.", key("bs_keep") + " the gulls again<br><strong>B-roll:</strong> The Harbour"),
        row("r3", "Quiet " + tag("location", "Quay", "quay") + " now.", "B-roll: new wording<br>" + key("bs_held") + " held line"),
        row("r4", "", "Intro " + key("bs_mid") + " mid-line key<br>" + key("bs_renamed") + " fresh name<br>with " +
          tag("prop", "Tripod", "the tripod"))
      ],
      brollShots: [
        shot("bs_keep", "the gulls", { status: "shot", notes: "got it" }),
        shot("bs_harbour", "the harbour", { props: [{ id: "t_tripod", name: "Tripod" }, { id: "", name: "Boat hook" }] }),
        shot("bs_held", "new wording", { notes: "held by a key further down" }),
        shot("bs_renamed", "stale name", { owner: "p1", props: [{ id: "t_kettle", name: "Kettle" }] }),
        shot("bs_orphan", "cut from the script"),
        shot("bs_list", "pickup from the list", { origin: "list", props: [{ id: "t_kettle", name: "Kettle" }] })
      ]
    });
    const out = { input };
    Object.assign(out, readAll());
    repairAll(out);
    return masked(out, input);
  }
});

SCENARIOS.push({
  name: "heal-crafted",
  run() {
    const input = load({
      schema: 2, title: "Kitchen", docId: "d" + "9".repeat(32),
      people: [{ id: "p1", name: "Sam" }],
      productionTags: [
        tagEntry("t_kettle", "prop", "Kettle", { status: "have", owner: "p1", notes: "copper" }),
        tagEntry("t_old", "prop", "Old prop", { status: "returned" }),
        tagEntry("t_tripodone", "gear", "Tripod"),
        tagEntry("t_tripodtwo", "gear", "tripod", { status: "returned", notes: "second copy" })
      ],
      rows: [
        row("r1", "Fill the " + tag("prop", "Kettle", "kettle") + ".", "Wide on the " + tag("location", "Kitchen", "kitchen")),
        row("r2", "Quiet."),
        row("r3", "", "Title card")
      ]
    });
    S.state.rows[1].audioText = "Pour from the " + tag("prop", "kettle ", "KETTLE") + " into the " + tag("prop", "Mug", "mug") +
      ", then rinse the kettle and the mug.<br>" + cue("SFX: whistle");
    S.state.rows[1].visualText = "Mug and kettle on the side";
    S.state.rows[2].visualText = tag("vfx", "Lower third") + ": “Step 1” " + tag("sound", "Whistle", "whistle") +
      " " + tag("bogus", "Thing") + " " + tag("cast", "  Ada  Lovelace ", "Ada");
    const out = { input, edited: jsonCopy(S.state.rows) };
    Object.assign(out, readAll());
    out.occurrences = occurrencesOf([{ cat: "prop", name: "kettle" }, { cat: "prop", name: "Mug" }, { cat: "sound", name: "whistle" }]);
    repairAll(out);
    return masked(out, input);
  }
});

function cueDoc(docId, rows) {
  return {
    schema: 2, title: "Cues", docId,
    rows: rows || [
      row("r1", "Welcome back.<br>" + cue("SFX: door slam") + "<br>Today, the kettle.", "Kitchen"),
      row("r2", cue("Music: upbeat intro")),
      row("r3", "")
    ]
  };
}

function soundRegistry() {
  return S.state.productionTags.filter((t) => t.cat === "sound").map((t) => [t.id, t.name, t.status, t.notes]);
}

function steps(list) {
  return list.map(([label, fn]) => {
    const healed = fn();
    return {
      step: label, healed: healed === undefined ? null : healed, sound: soundRegistry(),
      orphaned: productionEntries().filter((e) => e.orphaned).map((e) => e.key)
    };
  });
}

const setAudio = (id, html) => () => { S.state.rows.find((r) => r.id === id).audioText = html; return healTagRegistry(); };
const setVisual = (id, html) => () => { S.state.rows.find((r) => r.id === id).visualText = html; return healTagRegistry(); };
const entryNamed = (name) => S.state.productionTags.find((t) => t.name === name);

SCENARIOS.push({
  name: "cue-retitle",
  run() {
    const out = {};

    load(cueDoc("d" + "a".repeat(32)));
    out.typedWithPauses = steps([
      ["open and heal", () => healTagRegistry()],
      ["Music: slow", setAudio("r3", cue("Music: slow"))],
      ["Music: slow piano", setAudio("r3", cue("Music: slow piano"))],
      ["Music: slow piano intro", setAudio("r3", cue("Music: slow piano intro"))],
      ["marked Have it with a note", () => { Object.assign(entryNamed("slow piano intro"), { status: "have", notes: "the Rhodes take" }); }],
      ["a one-letter fix", setAudio("r3", cue("Music: slow piano intros"))],
      ["undone", setAudio("r3", cue("Music: slow piano intro"))]
    ]);

    load(cueDoc("d" + "b".repeat(32)));
    out.oldNameStillInScript = steps([
      ["open with the cue twice", () => { S.state.rows[1].audioText = cue("SFX: door slam"); return healTagRegistry(); }],
      ["marked Have it", () => { entryNamed("door slam").status = "have"; }],
      ["one copy edited", setAudio("r2", cue("SFX: door slams"))]
    ]);

    load(cueDoc("d" + "c".repeat(32)));
    out.oldNameStillTagged = steps([
      ["a tag of the same name", setVisual("r1", "Kitchen " + tag("sound", "door slam"))],
      ["the cue edited", setAudio("r1", "Welcome back.<br>" + cue("SFX: door bang"))]
    ]);

    load(cueDoc("d" + "d".repeat(32)));
    out.newNameAlreadyTracked = steps([
      ["open and heal", () => healTagRegistry()],
      ["the cue moved to another row", () => {
        S.state.rows[1].audioText = cue("Music: door slam");
        S.state.rows[0].audioText = "Welcome back.";
        return healTagRegistry();
      }],
      ["the first cue renamed to a tracked name", setAudio("r1", "Welcome back.<br>" + cue("SFX: upbeat intro"))]
    ]);

    load(cueDoc("d" + "e".repeat(32), [
      row("r1", cue("SFX: door slam") + "<br>Then.<br>" + cue("SFX: kettle whistle")),
      row("r2", cue("Music: theme"))
    ]));
    out.twoCuesInOneCell = steps([
      ["open and heal", () => healTagRegistry()],
      ["both edited at once", setAudio("r1", cue("SFX: door slams") + "<br>Then.<br>" + cue("SFX: kettle whistles"))],
      ["one removed, one edited", setAudio("r1", "Then.<br>" + cue("SFX: kettle whistling"))]
    ]);

    load(cueDoc("d" + "f".repeat(32)));
    out.cueMovedToAnotherRow = steps([
      ["open and heal", () => healTagRegistry()],
      ["removed from one row, a new one in another", () => {
        S.state.rows[1].audioText = "";
        S.state.rows[2].audioText = cue("Music: upbeat outro");
        return healTagRegistry();
      }]
    ]);

    const docA = migrateRows(jsonCopy(cueDoc("d" + "0".repeat(31) + "a")));
    const docB = migrateRows(jsonCopy(cueDoc("d" + "0".repeat(31) + "b")));
    out.anotherDocumentBetweenHeals = steps([
      ["document A healed", () => { S.state = docA; return healTagRegistry(); }],
      ["document B healed", () => { S.state = docB; return healTagRegistry(); }],
      ["back to A with its cue edited", () => {
        S.state = docA;
        S.state.rows[1].audioText = cue("Music: upbeat intros");
        return healTagRegistry();
      }]
    ]);
    return out;
  }
});

const OCCURRENCE_CELLS = [
  ["the kettle, the Kettle and KETTLE", "kettle"],
  [tag("prop", "Kettle", "kettle") + " and a kettle", "kettle"],
  [link("https://x.example/", "kettle") + " kettle", "kettle"],
  ["ket" + anchor("c1", "tle") + " " + anchor("c1", "kettle") + " " + anchor("c2", "ket") + anchor("c3", "tle"), "kettle"],
  ["kettles teakettle kettle-black kettle_", "kettle"],
  ["🎬kettle🎬 kettle· 𝒦kettle", "kettle"],
  ["İstanbul istanbul ISTANBUL", "istanbul"],
  [key("bs_x") + "kettle " + key("bs_y") + " kettle", "kettle"],
  ["red<br>mug red mug red  mug", "red mug"],
  ["Straße STRASSE strasse", "straße"],
  ["éclair éclair", "éclair"],
  ["Kettle kettle", "Kettle"],
  ["", "kettle"],
  ["kettle", ""],
  ["  padded  ", "  padded  "]
];

SCENARIOS.push({
  name: "tag-occurrences",
  run() {
    return OCCURRENCE_CELLS.map(([html, phrase]) => {
      const cell = cellOf(html);
      return {
        html, phrase,
        ranges: tagOccurrences(cell, phrase).map((m) => [m.from, m.to]),
        count: bulkTagCell(html, phrase, "prop", "Kettle", false, true),
        countMatchingCase: bulkTagCell(html, phrase, "prop", "Kettle", true, true),
        tagged: bulkTagCell(html, phrase, "prop", "Kettle", false, false)
      };
    });
  }
});

const shown = (v) => (v === undefined ? "(undefined)" : v);
const letters = (n, ch) => (ch || "a").repeat(n);
const lengthsOf = (list) => list.map((x) => ({ length: x.length, text: x }));

function cueLimitRows() {
  const cases = [
    ["79", letters(79)], ["80", letters(80)], ["81", letters(81)], ["79 then a space and more", letters(79) + " bb"],
    ["spaces across the cut", letters(77) + "    " + letters(5, "b")], ["leading spaces", "   " + letters(80)]
  ];
  return cases.map(([label, name]) => {
    const html = cue("Music: " + name);
    return { case: label, nameLength: name.length, read: lengthsOf(tagsInField(html).map((t) => t.name)) };
  });
}

function cueLimitRetitle() {
  const long = (ch) => "slow " + ch + " " + letters(80, "x");
  load(cueDoc("d" + "2".repeat(31) + "c", [row("r1", "Intro.<br>" + cue("Music: " + long("a"))), row("r2", "")]));
  const sounds = () => S.state.productionTags.filter((t) => t.cat === "sound")
    .map((t) => ({ id: t.id, length: t.name.length, name: t.name, status: t.status }));
  return [
    ["open and heal", () => healTagRegistry()],
    ["marked Have it", () => { S.state.productionTags.find((t) => t.cat === "sound").status = "have"; }],
    ["a word inside the first 80 characters edited", setAudio("r1", "Intro.<br>" + cue("Music: " + long("b")))],
    ["only characters past 80 edited", setAudio("r1", "Intro.<br>" + cue("Music: " + long("b") + "zz"))]
  ].map(([label, fn]) => {
    const healed = fn();
    return { step: label, healed: healed === undefined ? null : healed, sound: sounds() };
  });
}

function seedRows() {
  const loc = (name) => tag("location", name);
  const marker = (n) => "B-roll: shot " + n;
  return [
    row("r1", loc("Pier"), marker(1) + "<br>" + loc("Harbour") + " then " + loc("Quay")),
    row("r2", loc("Pier") + " and " + loc("Quay"), marker(2)),
    row("r3", tag("prop", "Kettle") + " only", marker(3)),
    row("r4", loc(letters(79, "l")), marker(4)),
    row("r5", loc(letters(80, "l")), marker(5)),
    row("r6", loc(letters(81, "l")), marker(6)),
    row("r7", letters(1999, "w"), marker(7)),
    row("r8", letters(2000, "w"), marker(8)),
    row("r9", letters(2001, "w"), marker(9))
  ];
}

function brollLimitCells() {
  const cells = [
    ["name 199", "B-roll: " + letters(199)], ["name 200", "B-roll: " + letters(200)], ["name 201", "B-roll: " + letters(201)],
    ["desc 1999", "B-roll: n<br>" + letters(1999)], ["desc 2000", "B-roll: n<br>" + letters(2000)],
    ["desc 2001", "B-roll: n<br>" + letters(2001)],
    ["markers", ["B-roll: a", "b roll - b", "B-Roll — c", "broll: d", "B roll– e", "  b-roll : f", "Brolls: g", "B--roll: h",
      "x B-roll: i", "B-roll j", "B-roll:"].join("<br>")]
  ];
  return cells.map(([label, html]) => ({
    case: label,
    read: brollInCell(cellOf(html)).map((b) => ({ id: b.id, nameLength: b.name.length, name: b.name.slice(0, 12), descLength: b.desc.length }))
  }));
}

function propLimitRows() {
  const registry = [
    tagEntry("t_kettle", "prop", "Kettle"), tagEntry("t_tripod", "gear", "Tripod"), tagEntry("t_lamp", "prop", "Lamp"),
    tagEntry("t_spare", "prop", "Kettle")
  ];
  const named = (n) => Array.from({ length: n }, (_, i) => ({ id: "", name: "Prop " + (i + 1) }));
  const cases = [
    ["no list", null], ["a string, not a list", "Kettle"], ["names as strings", ["Kettle", "kettle ", "Ladder"]],
    ["a number for a name", [42, { name: 7 }]], ["entries with nothing usable", [{}, null, true, { name: "   " }, { id: "", name: "" }]],
    ["a known id with no name", [{ id: "t_kettle" }]], ["a known id with a stale name", [{ id: "t_lamp", name: "Old lamp" }]],
    ["an id of the right shape that nothing holds", [{ id: "t_unknown1", name: "Ghost" }]],
    ["an id of the wrong shape", [{ id: "bogus id", name: "Ladder" }, { id: "constructor", name: "Rope" }]],
    ["a name a gear entry holds", [{ name: "tripod" }]], ["a name in markup", [{ name: "<b>Lamp</b>" }]],
    ["a name two prop entries hold", [{ name: "KETTLE" }]],
    ["names of 79, 80 and 81 characters", [{ name: letters(79, "p") }, { name: letters(80, "q") }, { name: letters(81, "r") }]],
    ["39 props", named(39)], ["40 props", named(40)], ["41 props", named(41)],
    ["repeats by id and by name", [{ id: "t_kettle", name: "x" }, { name: "kettle" }, { name: "Lamp" }, { name: "LAMP" }, { name: "Rope" }, { name: "rope " }]]
  ];
  return cases.map(([label, list]) => {
    const out = normalizeBrollProps(jsonCopy(list), registry);
    return { case: label, count: out.length, props: out.length > 6 ? [out[0], out[out.length - 1]] : out };
  });
}

SCENARIOS.push({
  name: "limits",
  run() {
    const ids = TAG_STATUSES.map((s) => s.id).concat(["Needed", "", null, undefined, "bogus", "constructor", "toString", 0, 1]);
    const out = {
      tagStatuses: TAG_STATUSES.map((s) => s.id),
      tagCategories: TAG_CATEGORIES.map((c) => c.id),
      statuses: ids.map((id) => ({
        id: shown(id), tagStatus: tagStatus(id) ? tagStatus(id).id : null, rank: tagStatusRank(id), next: nextTagStatus(id)
      })),
      categories: ["prop", "gear", "Prop", "", null, "bogus", "constructor"].map((id) => ({
        id, tagCategory: tagCategory(id) ? tagCategory(id).id : null
      })),
      tagNames: [null, undefined, "", "   ", "Kettle", "  Red   Mug  ", "Red\tMug", "a b", "A\nB", "İstanbul", "STRASSE",
        "Straße", 42, 0, false].map((v) => ({
        name: shown(v), normalized: normalizeTagName(v), registryKey: registryKey("prop", v), tagKey: tagKey("gear", v)
      })),
      cueNames: cueLimitRows(),
      cueRetitleWithALongName: cueLimitRetitle(),
      brollStatuses: BROLL_STATUSES.map((s) => s.id),
      brollStatus: ["unshot", "shot", "Shot", "", null, undefined, "bogus", "constructor"].map((id) => ({
        id: shown(id), brollStatus: brollStatus(id) ? brollStatus(id).id : null
      })),
      brollLimits: { BROLL_NAME_MAX, BROLL_TEXT_MAX, BROLL_PROPS_MAX },
      brollCells: brollLimitCells(),
      propKeys: [["t_kettle", "Anything"], ["", "Kettle"], ["", "  RED   mug "], [undefined, "Lamp"], ["", ""], [null, null]]
        .map(([id, name]) => ({ id: shown(id), name: shown(name), key: brollPropKey(id, name) })),
      props: propLimitRows()
    };
    const input = load({ schema: 2, title: "Seeds", docId: "d" + "3".repeat(31) + "c", rows: [] });
    S.state.rows = seedRows();
    out.seeds = brollEntries().map((e) => ({
      rowId: e.rowId, name: e.name, location: e.location, locationLength: e.location.length, audioRefLength: e.audioRef.length
    }));
    return masked(out, input);
  }
});

function gearElements() {
  let box = document.getElementById("gear-quickadd-input");
  if (!box) {
    box = document.createElement("textarea");
    box.id = "gear-quickadd-input";
    document.body.appendChild(box);
  }
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    document.body.appendChild(host);
  }
  return { box, host };
}

function quickAdd(label, lines, eol) {
  const { box, host } = gearElements();
  host.innerHTML = "";
  const text = lines.join(eol || "\n");
  box.value = text;
  S.dirty = false;
  const others = jsonCopy(S.state.productionTags.filter((t) => t.cat !== "gear"));
  applyGearQuickAdd();
  return {
    step: label, typed: text,
    gear: S.state.productionTags.filter((t) => t.cat === "gear").map((t) => [t.id, t.name, t.status, t.notes]),
    otherTagsUntouched: JSON.stringify(others) === JSON.stringify(S.state.productionTags.filter((t) => t.cat !== "gear")),
    toasts: Array.from(host.children).map((el) => el.textContent),
    boxAfter: box.value,
    dirty: !!S.dirty,
    personColors: S.state.personColors === undefined ? null : jsonCopy(S.state.personColors)
  };
}

const gearDoc = (docId, registry) => ({
  schema: 2, title: "Gear", docId,
  rows: [row("r1", "", "Wide on " + tag("gear", "Tripod", "the tripod") + " and " + tag("gear", "Slider"))],
  productionTags: registry
});

SCENARIOS.push({
  name: "gear-quick-add",
  run() {
    const out = {};
    out.input = load(gearDoc("d" + "4".repeat(31) + "c", [
      tagEntry("t_tripod", "gear", "Tripod", { status: "have" }), tagEntry("t_slider", "gear", "Slider"),
      tagEntry("t_oldlens", "gear", "Old lens", { notes: "sold" }), tagEntry("t_gimbal", "gear", "Gimbal"),
      tagEntry("t_ctor", "gear", "constructor"), tagEntry("t_proto", "gear", "__proto__"),
      tagEntry("t_kettle", "prop", "Kettle")
    ]));
    const lines = ["tripod", "  Lav mic  ", "Gimbal", "constructor", "__proto__", "toString", "hasOwnProperty", letters(81, "x"),
      "<b>Boom</b> pole", "", "   ", "Lav Mic"];
    out.steps = [
      quickAdd("a list with every kind of line, CRLF", lines, "\r\n"),
      quickAdd("the same list again, LF", lines, "\n"),
      quickAdd("the same list, CR", lines, "\r"),
      quickAdd("a list leaving out everything not in the script", ["Tripod", "Slider"])
    ];
    load(gearDoc("d" + "5".repeat(31) + "c", [
      tagEntry("t_tripod", "gear", "Tripod"), tagEntry("t_spare", "gear", "Spare battery")
    ]));
    out.steps.push(quickAdd("lines named after Object's own properties, none tracked yet", ["constructor", "__proto__", "Tripod", "toString"]));
    out.steps.push(quickAdd("an empty list", [""]));
    return out;
  }
});

for (const s of SCENARIOS) {
  test("production golden: " + s.name, () => {
    assertGolden("production-" + s.name, s.run());
  });
}

test("every production fixture belongs to a scenario, and every scenario has one", () => {
  assert.deepEqual(goldenNames("production-"), SCENARIOS.map((s) => "production-" + s.name).sort());
});
