import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { cellOf } from "../js/04c-doc-model.js";
import {
  bulkTagCell, bulkTagRows, healTagRegistry, productionEntries, tagCategory, tagOccurrences, tagsByCategory
} from "../js/07-production-tags.js";
import { __init as initBroll, anchorBrollInRows, brollEntries, brollShotsByProp } from "../js/08c-broll.js";
import { LONG_DEMO } from "../js/_starters.js";
import { assertGolden, freezeClockAndRandom, goldenNames, jsonCopy, maskTokens, newTokens } from "./golden-helpers-b.mjs";

freezeClockAndRandom(0x70726f64);
initBroll();

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
    brollRead: brollView(brollEntries(true)),
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
  const repair = brollView(brollEntries(false));
  out.brollRepair = sameAsOr("brollRead", out.brollRead, repair);
  out.shotsAfterRepair = unchangedOr(shotsBefore, S.state.brollShots);
  const rowsBefore = jsonCopy(S.state.rows.map((r) => r.visualText));
  out.anchored = anchorBrollInRows(S.state.rows);
  out.visualAfterAnchoring = unchangedOr(rowsBefore, S.state.rows.map((r) => r.visualText));
  out.brollAfterAnchoring = sameAsOr("brollRepair", repair, brollView(brollEntries(true)));
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

for (const s of SCENARIOS) {
  test("production golden: " + s.name, () => {
    assertGolden("production-" + s.name, s.run());
  });
}

test("every production fixture belongs to a scenario, and every scenario has one", () => {
  assert.deepEqual(goldenNames("production-"), SCENARIOS.map((s) => "production-" + s.name).sort());
});
