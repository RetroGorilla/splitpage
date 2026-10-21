import { rowContentEqual } from "../core/merge/rows.ts";
import { mergeTextField } from "../core/merge/text-field.ts";
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../js/02-state.js";
import {
  acceptStash,
  mergeStates,
  readStash,
  stashLocalWork,
  textMergeContext
} from "../js/03-sync.js";
import { createMemoryBackend, dataUrlForSync, intern, setBackend } from "../adapters/storage/02c-blobs.js";
import { S } from "../js/_state.js";
import { changedBetween } from "../js/12a-undo.js";
import { personIdRemap } from "../core/merge/lists.ts";
import { cloneState } from "../core/document/clone.ts";

function mk() {
  return migrateRows({
    title: "M",
    rows: [{ id: "r1", visualText: "v", audioText: "a" }],
    people: [{ id: "p1", name: "Sam" }],
    productionTags: [{ cat: "prop", name: "Kettle", owner: "", notes: "", status: "needed" }],
    brollShots: [{ id: "b1", name: "Rooftop" }],
    wordsPerMinute: 150
  });
}

test("the fixture is what the delete cases assume", () => {
  const s = mk();
  assert.equal(s.people.length, 1);
  assert.equal(s.productionTags.length, 1);
  assert.equal(s.brollShots.length, 1);
});

test("a person I deleted stays deleted", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.people = [];
  assert.equal(mergeStates(base, mine, theirs).merged.people.length, 0);
});

test("a person they deleted stays deleted", () => {
  const base = mk(), mine = mk(), theirs = mk();
  theirs.people = [];
  assert.equal(mergeStates(base, mine, theirs).merged.people.length, 0);
});

test("a production tag I deleted stays deleted", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.productionTags = [];
  assert.equal(mergeStates(base, mine, theirs).merged.productionTags.length, 0);
});

test("a b-roll shot I deleted stays deleted", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.brollShots = [];
  assert.equal(mergeStates(base, mine, theirs).merged.brollShots.length, 0);
});

test("a delete never beats a real edit on the other side — tag", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.productionTags = [];
  theirs.productionTags[0].status = "have";
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.productionTags.length, 1);
  assert.equal(out.productionTags[0].status, "have");
});

test("a delete never beats a real edit on the other side — b-roll", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.brollShots = [];
  theirs.brollShots[0].owner = "p1";
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.brollShots.length, 1);
  assert.equal(out.brollShots[0].owner, "p1");
});

test("additions still union", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.people.push({ id: "p2", name: "Ada" });
  theirs.people.push({ id: "p3", name: "Bo" });
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.people.length, 3);
  assert.deepEqual(out.people.map((p) => p.name).sort(), ["Ada", "Bo", "Sam"]);
});

test("both sides add the same person: what I gave my copy keeps its owner (#283)", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.people.push({ id: "pMine", name: "Ada" });
  theirs.people.push({ id: "pTheirs", name: " ada " });
  mine.productionTags[0].owner = "pMine";
  mine.productionTags.push({ cat: "prop", name: "Lamp", owner: "pMine", notes: "", status: "needed" });
  mine.brollShots[0].owner = "pMine";
  mine.brollShots.push({ id: "b2", name: "Harbour", owner: "pMine" });
  const out = mergeStates(base, migrateRows(mine), theirs).merged;
  assert.deepEqual(out.people.map((p) => p.id).sort(), ["p1", "pTheirs"], "one Ada, under their id");
  const tag = (name) => out.productionTags.find((t) => t.name === name);
  const shot = (id) => out.brollShots.find((b) => b.id === id);
  assert.equal(tag("Kettle").owner, "pTheirs", "an edited tag");
  assert.equal(tag("Lamp").owner, "pTheirs", "a tag I added");
  assert.equal(shot("b1").owner, "pTheirs", "an edited shot");
  assert.equal(shot("b2").owner, "pTheirs", "a shot I added");
});

test("both sides add the same person: an owner they set, and other people's, are left alone (#283)", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.people.push({ id: "pMine", name: "Ada" });
  theirs.people.push({ id: "pTheirs", name: "Ada" });
  theirs.productionTags[0].owner = "pTheirs";
  mine.brollShots[0].owner = "p1";
  const out = mergeStates(base, migrateRows(mine), migrateRows(theirs)).merged;
  assert.equal(out.productionTags[0].owner, "pTheirs");
  assert.equal(out.brollShots[0].owner, "p1");
});

test("both sides add the same person with no ancestor: my items keep their owner (#283)", () => {
  const mine = mk(), theirs = mk();
  mine.people.push({ id: "pMine", name: "Ada" });
  theirs.people.push({ id: "pTheirs", name: "Ada" });
  mine.brollShots[0].owner = "pMine";
  const out = mergeStates(null, migrateRows(mine), migrateRows(theirs)).merged;
  assert.equal(out.people.filter((p) => p.name === "Ada").length, 1);
  assert.equal(out.brollShots[0].owner, "pTheirs");
});

test("I deleted a person and added them again while they kept the old one: my items follow theirs (#283)", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.people = [{ id: "pNew", name: "sam" }];
  mine.productionTags[0].owner = "pNew";
  const out = mergeStates(base, migrateRows(mine), theirs).merged;
  assert.deepEqual(out.people, [{ id: "p1", name: "Sam" }]);
  assert.equal(out.productionTags[0].owner, "p1");
});

test("a person deleted on one side is not brought back by the re-pointing (#283)", () => {
  const base = mk(), mine = mk(), theirs = mk();
  base.brollShots[0].owner = "p1";
  theirs.brollShots[0].owner = "p1";
  mine.people = [];
  mine.brollShots[0].owner = "";
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.people.length, 0);
  assert.equal(out.brollShots[0].owner, "", "their item loses the owner I deleted, as before");
});

test("a side with no people list, or owners naming nobody, merges without re-pointing anything (#283)", () => {
  const mine = mk(), theirs = mk();
  delete mine.people;
  mine.productionTags[0].owner = "pGone";
  theirs.brollShots[0].owner = "p1";
  const out = mergeStates(null, mine, theirs).merged;
  assert.deepEqual(out.people, [{ id: "p1", name: "Sam" }]);
  assert.equal(out.productionTags[0].owner, "");
  assert.equal(out.brollShots[0].owner, "p1");
});

test("merging the merged state again changes no owner (#283)", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.people.push({ id: "pMine", name: "Ada" });
  theirs.people.push({ id: "pTheirs", name: "Ada" });
  mine.productionTags[0].owner = "pMine";
  const once = mergeStates(base, migrateRows(mine), migrateRows(theirs)).merged;
  const twice = mergeStates(base, cloneState(once), migrateRows(theirs)).merged;
  assert.equal(twice.productionTags[0].owner, "pTheirs");
  assert.deepEqual(twice.people, once.people);
});

function deletedOwnerSides() {
  const base = mk();
  base.people.push({ id: "pAda", name: "Ada" });
  base.productionTags[0].owner = "p1";
  base.brollShots[0].owner = "p1";
  const withOwners = (s, owner) => {
    s.productionTags[0].owner = owner;
    s.brollShots[0].owner = owner;
    return s;
  };
  return { base, kept: () => withOwners(cloneState(base), "p1"), handedOver: () => {
    const s = withOwners(cloneState(base), "pAda");
    s.people = s.people.filter((p) => p.id !== "p1");
    return s;
  } };
}

test("I deleted Sam and gave his items to Ada while they kept him: Ada keeps them (#353)", () => {
  const { base, kept, handedOver } = deletedOwnerSides();
  const out = mergeStates(base, handedOver(), kept()).merged;
  assert.deepEqual(out.people, [{ id: "pAda", name: "Ada" }]);
  assert.equal(out.productionTags[0].owner, "pAda", "the tag");
  assert.equal(out.brollShots[0].owner, "pAda", "the shot");
});

test("they deleted Sam and gave his items to Ada while I kept him: Ada keeps them (#353)", () => {
  const { base, kept, handedOver } = deletedOwnerSides();
  const out = mergeStates(base, kept(), handedOver()).merged;
  assert.deepEqual(out.people, [{ id: "pAda", name: "Ada" }]);
  assert.equal(out.productionTags[0].owner, "pAda");
  assert.equal(out.brollShots[0].owner, "pAda");
});

test("a deleted owner gives way only to a live one; a live owner on their side still wins (#353)", () => {
  const { base, kept, handedOver } = deletedOwnerSides();
  const toBo = kept();
  toBo.people.push({ id: "pBo", name: "Bo" });
  toBo.productionTags[0].owner = "pBo";
  toBo.brollShots[0].owner = "pBo";
  const live = mergeStates(base, handedOver(), toBo).merged;
  assert.deepEqual([live.productionTags[0].owner, live.brollShots[0].owner], ["pBo", "pBo"]);
  const gone = handedOver();
  gone.people = [];
  const none = mergeStates(base, gone, kept()).merged;
  assert.deepEqual(none.people, []);
  assert.deepEqual([none.productionTags[0].owner, none.brollShots[0].owner], ["", ""]);
});

test("a deleted owner on their side gives way to mine's owner who survived under their id (#283, #353)", () => {
  const { base, kept } = deletedOwnerSides();
  const mine = cloneState(base);
  mine.people = [{ id: "pM", name: "Bo" }];
  mine.productionTags[0].owner = "pM";
  const theirs = kept();
  theirs.people.push({ id: "pT", name: "bo" });
  const out = mergeStates(base, mine, theirs).merged;
  assert.deepEqual(out.people, [{ id: "pT", name: "bo" }]);
  assert.equal(out.productionTags[0].owner, "pT");
});

test("both sides added one tag name under different ids: theirs owned by Sam, whom I deleted, mine by Ada: Ada owns it (#353)", () => {
  const base = mk();
  base.productionTags = [];
  const theirs = cloneState(base), mine = cloneState(base);
  theirs.productionTags.push({ id: "t_lampT", cat: "prop", name: "Lamp", owner: "p1", notes: "", status: "needed" });
  mine.people = [{ id: "pAda", name: "Ada" }];
  mine.productionTags.push({ id: "t_lampM", cat: "prop", name: "lamp", owner: "pAda", notes: "", status: "needed" });
  const out = mergeStates(base, mine, theirs).merged;
  assert.deepEqual(out.people, [{ id: "pAda", name: "Ada" }]);
  assert.deepEqual(out.productionTags.map((t) => [t.name, t.owner]), [["Lamp", "pAda"]]);
});

function seededRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const SEED_NAMES = ["Ada", "ada ", "Bo", "Cy", " BO", "Dee"];
const norm = (n) => n.trim().toLowerCase();

function seededMerge(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const base = migrateRows({
    title: "M",
    rows: [{ id: "r1", visualText: "v", audioText: "a" }],
    people: ["Ada", "Bo"].filter(() => r() < 0.5).map((n) => ({ id: "pb" + n, name: n })),
    productionTags: [0, 1, 2].map((i) => ({ cat: "prop", name: "T" + i, owner: "", notes: "", status: "needed" })),
    brollShots: [0, 1, 2].map((i) => ({ id: "s" + i, name: "S" + i })),
    wordsPerMinute: 150
  });
  const owners = (s) => [""].concat(s.people.map((p) => p.id));
  base.productionTags.concat(base.brollShots).forEach((e) => { e.owner = pick(owners(base)); });
  function side(prefix) {
    const s = cloneState(base);
    s.people = s.people.filter(() => r() >= 0.2);
    SEED_NAMES.forEach((n, i) => {
      if (r() < 0.4 && !s.people.some((p) => norm(p.name) === norm(n))) s.people.push({ id: prefix + i, name: n });
    });
    const known = new Set(s.people.map((p) => p.id));
    s.productionTags = s.productionTags.filter(() => r() >= 0.1);
    s.brollShots = s.brollShots.filter(() => r() >= 0.1);
    s.productionTags.push({ cat: "prop", name: "N" + prefix, owner: "", notes: "", status: "needed" });
    s.brollShots.push({ id: "n" + prefix, name: "N" + prefix });
    s.productionTags.concat(s.brollShots).forEach((e) => {
      if (!known.has(e.owner)) e.owner = "";
      if (r() < 0.5) e.owner = pick(owners(s));
    });
    return migrateRows(s);
  }
  return { base, mine: side("pm"), theirs: side("pt") };
}

function unifyPeople(base, mine, theirs) {
  const theirId = {};
  theirs.people.forEach((p) => { theirId[norm(p.name)] = p.id; });
  const to = {};
  mine.people.forEach((p) => {
    const t = theirId[norm(p.name)];
    if (t && t !== p.id) to[p.id] = t;
  });
  const um = cloneState(mine);
  um.people.forEach((p) => { if (to[p.id]) p.id = to[p.id]; });
  um.productionTags.concat(um.brollShots).forEach((e) => { if (to[e.owner]) e.owner = to[e.owner]; });
  const targets = new Set(Object.values(to));
  return { um, inBase: base.people.some((p) => to[p.id] || targets.has(p.id)) };
}

test("seeded merges with both sides adding people: the same as if the same name had always had their id (#283)", () => {
  const r = seededRng(283);
  let compared = 0, repointed = 0, readded = 0;
  for (let i = 0; i < 600; i++) {
    const { base, mine, theirs } = seededMerge(r);
    const { um, inBase } = unifyPeople(base, mine, theirs);
    const label = "case " + i + ": " + JSON.stringify({ base, mine, theirs });
    const got = mergeStates(cloneState(base), cloneState(mine), cloneState(theirs)).merged;
    const want = mergeStates(cloneState(base), um, cloneState(theirs)).merged;
    const ids = new Set(got.people.map((p) => p.id));
    for (const e of got.productionTags.concat(got.brollShots)) assert.ok(!e.owner || ids.has(e.owner), label);
    assert.deepEqual(got.people, want.people, label);
    if (inBase) { readded++; continue; }
    assert.deepEqual(Object.keys(personIdRemap(theirs.people.concat(um.people), want.people)), [], label);
    assert.deepEqual(got, want, label);
    compared++;
    const moved = mine.productionTags.concat(mine.brollShots).filter((e, k) => e.owner !== um.productionTags.concat(um.brollShots)[k].owner);
    if (moved.length) repointed++;
  }
  assert.ok(compared > 400 && repointed > 50 && readded > 0,
    "the generator covers what it should: " + JSON.stringify({ compared, repointed, readded }));
});

test("with no ancestor, nothing is a delete", () => {
  const mine = mk(), theirs = mk();
  mine.people = [];
  assert.equal(mergeStates(null, mine, theirs).merged.people.length, 1);
});

test("wordsPerMinute follows whoever changed it", () => {
  let base = mk(), mine = mk(), theirs = mk();
  mine.wordsPerMinute = 180;
  assert.equal(mergeStates(base, mine, theirs).merged.wordsPerMinute, 180);

  base = mk(); mine = mk(); theirs = mk();
  theirs.wordsPerMinute = 200;
  assert.equal(mergeStates(base, mine, theirs).merged.wordsPerMinute, 200);

  base = mk(); mine = mk(); theirs = mk();
  mine.wordsPerMinute = 180;
  theirs.wordsPerMinute = 200;
  assert.equal(mergeStates(base, mine, theirs).merged.wordsPerMinute, 200);
});

function shaped() {
  const s = mk();
  s.docId = "d" + "5".repeat(32);
  s.comments = [{ id: "c1", rowId: "r1", field: "audioText", body: "look", createdAt: "2026-01-01T00:00:00.000Z",
    replies: [{ id: "rp1", body: "yes", createdAt: "2026-01-02T00:00:00.000Z" }] }];
  s.rows[0].imageLinks = [{ href: "https://video.example/a" }];
  s.rows[0].moreImages = [
    { links: [{ href: "https://video.example/b", poster: true }] },
    { imageRef: { sha256: "a".repeat(64), width: 640, height: 360, mime: "image/png" }, name: "Pier", links: [{ href: "https://video.example/c" }] }
  ];
  const d = migrateRows(s);
  assert.equal(d.rows[0].moreImages.length, 2, "the fixture keeps both gallery items");
  return { base: cloneState(d), mine: cloneState(d), theirs: cloneState(d) };
}

const SHAPES = [
  ["their tag list is an object", (d) => { d.theirs.productionTags = {}; }, (d) => { d.theirs.productionTags = []; }],
  ["their scene list is an object", (d) => { d.theirs.rows = {}; }, (d) => { d.theirs.rows = []; }],
  ["their scene list is missing", (d) => { delete d.theirs.rows; }, (d) => { d.theirs.rows = []; }],
  ["my scene list is null", (d) => { d.mine.rows = null; }, (d) => { d.mine.rows = []; }],
  ["their people list is a string", (d) => { d.theirs.people = "x"; }, (d) => { d.theirs.people = []; }],
  ["my shot list is a number", (d) => { d.mine.brollShots = 7; }, (d) => { d.mine.brollShots = []; }],
  ["the ancestor's lists are strings and objects", (d) => { d.base.productionTags = "x"; d.base.brollShots = {}; d.base.people = "y"; },
    (d) => { d.base.productionTags = []; d.base.brollShots = []; d.base.people = []; }],
  ["a scene that is a string on both sides", (d) => { d.mine.rows.push("x"); d.theirs.rows.push("x"); }, () => {}],
  ["a scene that is null on both sides", (d) => { d.mine.rows.unshift(null); d.theirs.rows.push(null); }, () => {}],
  ["a comment that is a string on both sides", (d) => { d.mine.comments.push("x"); d.theirs.comments.push("x"); }, () => {}],
  ["their comment list is an object", (d) => { d.theirs.comments = { c1: d.theirs.comments[0] }; }, (d) => { d.theirs.comments = []; }],
  ["their replies are a string", (d) => { d.theirs.comments[0].replies = "x"; }, (d) => { d.theirs.comments[0].replies = []; }],
  ["a reply that is null", (d) => { d.mine.comments[0].replies.push(null); }, () => {}],
  ["a gallery link that is null", (d) => { d.mine.rows[0].imageLinks.push(null); d.theirs.rows[0].imageLinks.unshift(null); }, () => {}],
  ["their gallery lists are objects", (d) => { d.theirs.rows[0].imageLinks = {}; d.theirs.rows[0].moreImages[0].links = {}; },
    (d) => { d.theirs.rows[0].imageLinks = []; d.theirs.rows[0].moreImages[0].links = []; }],
  ["a picture that is null", (d) => { d.mine.rows[0].moreImages.push(null); d.theirs.rows[0].moreImages.push(null); }, () => {}],
  ["both sides changed the gallery, and their picture's links are an object",
    (d) => {
      d.mine.rows[0].moreImages[1].links.push({ href: "https://video.example/mine" });
      d.mine.rows[0].moreImages.push({ links: [{ href: "https://video.example/new", poster: true }] });
      d.theirs.rows[0].moreImages[1].links = {};
    },
    (d) => {
      d.mine.rows[0].moreImages[1].links.push({ href: "https://video.example/mine" });
      d.mine.rows[0].moreImages.push({ links: [{ href: "https://video.example/new", poster: true }] });
      d.theirs.rows[0].moreImages[1].links = [];
    }]
];

for (const [label, bad, clean] of SHAPES) {
  test("#304: " + label + ": the merge drops what is not a list or not an object, and nothing throws", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 2, 1) });
    const odd = shaped(), plain = shaped();
    bad(odd);
    clean(plain);
    const before = JSON.stringify(odd);
    const got = mergeStates(odd.base, odd.mine, odd.theirs);
    assert.equal(JSON.stringify(odd), before, "the inputs are left as they were");
    const want = mergeStates(plain.base, plain.mine, plain.theirs);
    assert.deepEqual(got, want);
  });
}

test("#304: two unmigrated sides whose lists hold strings and nulls merge to a migrated document", () => {
  const raw = { rows: ["x", null, { id: "r1", audioText: "a" }], comments: ["x", null], people: [null, "Sam"], productionTags: ["x"], brollShots: [null] };
  const out = mergeStates(null, JSON.parse(JSON.stringify(raw)), JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(out.merged.rows.map((r) => [r.id, r.audioText]), [["r1", "a"]]);
  assert.deepEqual([out.merged.comments, out.merged.people, out.merged.productionTags, out.merged.brollShots], [[], [], [], []]);
  assert.deepEqual(out.conflicts, []);
});

const ID_A = "d" + "1".repeat(32);
const ID_B = "d" + "2".repeat(32);
const ID_D = "d" + "4".repeat(32);

test("a merge keeps the document's id rather than minting a fresh one", () => {
  const s = mk();
  const mine = cloneState(s), theirs = cloneState(s);
  mine.docId = ID_A;
  theirs.docId = ID_B;
  assert.equal(mergeStates(null, mine, theirs).merged.docId, ID_B);

  const base2 = cloneState(s), mine2 = cloneState(s), theirs2 = cloneState(s);
  base2.docId = ID_A; mine2.docId = ID_A; theirs2.docId = ID_D;
  assert.equal(mergeStates(base2, mine2, theirs2).merged.docId, ID_D);
});

function rowDoc(rows) {
  return migrateRows({ title: "R", rows: rows, schema: 2 });
}

test("only one side changed a cell: that side wins, silently", () => {
  const base = rowDoc([{ id: "r1", audioText: "one" }]);
  const mine = rowDoc([{ id: "r1", audioText: "one" }]);
  const theirs = rowDoc([{ id: "r1", audioText: "two" }]);
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "two");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.stats.rowsFromThem, 1);
});

test("both sides changed the same cell: theirs goes live, mine becomes a conflict comment", () => {
  const base = rowDoc([{ id: "r1", audioText: "one" }]);
  const mine = rowDoc([{ id: "r1", audioText: "mine" }]);
  const theirs = rowDoc([{ id: "r1", audioText: "theirs" }]);
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "theirs");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].field, "audioText");
  assert.equal(res.conflicts[0].mine, "mine");
  const card = res.merged.comments.find((c) => c.kind === "conflict");
  assert.ok(card, "the conflict is preserved as a comment, never dropped");
  assert.equal(card.rowId, "r1");
  assert.equal(card.conflictField, "Audio");
  assert.equal(card.body, "mine");
});

test("an edit outranks a delete, in both directions", () => {
  const base = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two" }]);
  const mine = rowDoc([{ id: "r1", audioText: "one" }]);
  const theirs = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two, edited" }]);
  const kept = mergeStates(base, mine, theirs).merged.rows.map((r) => r.id);
  assert.deepEqual(kept, ["r1", "r2"]);

  const theirs2 = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two" }]);
  const gone = mergeStates(base, mine, theirs2).merged.rows.map((r) => r.id);
  assert.deepEqual(gone, ["r1"]);
});

test("a row I added lands back beside the neighbour it was added after", () => {
  const base = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two" }]);
  const mine = rowDoc([
    { id: "r1", audioText: "one" },
    { id: "rNEW", audioText: "new" },
    { id: "r2", audioText: "two" }
  ]);
  const theirs = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two" }]);
  const res = mergeStates(base, mine, theirs);
  assert.deepEqual(res.merged.rows.map((r) => r.id), ["r1", "rNEW", "r2"]);
  assert.equal(res.stats.rowsAddedByMe, 1);
});

test("status is progress, not text: the furthest-along value wins", () => {
  const base = rowDoc([{ id: "r1", audioText: "one", status: "todo" }]);
  const mine = rowDoc([{ id: "r1", audioText: "one", status: "shot" }]);
  const theirs = rowDoc([{ id: "r1", audioText: "one", status: "ready" }]);
  assert.equal(mergeStates(base, mine, theirs).merged.rows[0].status, "shot");
  assert.equal(mergeStates(base, theirs, mine).merged.rows[0].status, "shot");
});

test("a title both sides changed is a conflict, not a silent overwrite", () => {
  const base = rowDoc([]); base.title = "Base";
  const mine = rowDoc([]); mine.title = "Mine";
  const theirs = rowDoc([]); theirs.title = "Theirs";
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.title, "Theirs");
  const card = res.merged.comments.find((c) => c.conflictField === "Title");
  assert.ok(card, "my title survives as a conflict card");
  assert.equal(card.titleValue, "Mine");
  assert.equal(card.rowId, null);
});

test("a title only I changed is kept", () => {
  const base = rowDoc([]); base.title = "Base";
  const mine = rowDoc([]); mine.title = "Mine";
  const theirs = rowDoc([]); theirs.title = "Base";
  assert.equal(mergeStates(base, mine, theirs).merged.title, "Mine");
});

function commentDoc(comments) {
  return migrateRows({
    title: "C", schema: 2,
    rows: [{ id: "r1", audioText: "one" }],
    comments: comments
  });
}

function cmt(extra) {
  return Object.assign({
    id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "one",
    author: "Sam", body: "look", resolved: false, kind: "anchor",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", replies: []
  }, extra || {});
}

test("resolved is forward progress, whichever side is newer", () => {
  const base = commentDoc([cmt()]);
  const mine = commentDoc([cmt({ resolved: true, resolvedBy: "Sam", resolvedAt: "2026-01-02T00:00:00.000Z" })]);
  const theirs = commentDoc([cmt({ updatedAt: "2026-01-03T00:00:00.000Z", body: "look, edited" })]);
  const out = mergeStates(base, mine, theirs).merged.comments.find((c) => c.id === "c1");
  assert.equal(out.resolved, true);
  assert.equal(out.resolvedBy, "Sam");
});

test("an assignee only one side made survives the merge", () => {
  const base = commentDoc([cmt()]);
  const mine = commentDoc([cmt({ assignee: "Ada" })]);
  const theirs = commentDoc([cmt({ updatedAt: "2026-01-05T00:00:00.000Z" })]);
  const out = mergeStates(base, mine, theirs).merged.comments.find((c) => c.id === "c1");
  assert.equal(out.assignee, "Ada");
});

test("replies from both sides are unioned, oldest first", () => {
  const rep = (id, at) => ({ id: id, body: id, author: "Sam", createdAt: at });
  const base = commentDoc([cmt()]);
  const mine = commentDoc([cmt({ replies: [rep("rp1", "2026-01-02T00:00:00.000Z")] })]);
  const theirs = commentDoc([cmt({ replies: [rep("rp2", "2026-01-03T00:00:00.000Z")] })]);
  const out = mergeStates(base, mine, theirs).merged.comments.find((c) => c.id === "c1");
  assert.deepEqual(out.replies.map((r) => r.id), ["rp1", "rp2"]);
});

test("mergeStates leaves the replies of its own mine and theirs alone (#303)", () => {
  const base = commentDoc([cmt(), cmt({ id: "c2", anchorId: "c2" })]);
  const mine = commentDoc([cmt(), cmt({ id: "c2", anchorId: "c2" })]);
  const theirs = commentDoc([cmt()]);
  mine.comments[0].replies = [{ id: "rpM", body: "mine", createdAt: "2026-01-02T00:00:00.000Z" }];
  mine.comments[1].replies = [{ id: "rpX", body: "only mine", createdAt: "2026-01-02T00:00:00.000Z" }];
  theirs.comments[0].replies = [{ id: "rpT", body: "theirs", createdAt: "2026-01-03T00:00:00.000Z" }];
  const before = JSON.stringify([base, mine, theirs]);
  const out = mergeStates(base, mine, theirs).merged.comments;
  assert.equal(JSON.stringify([base, mine, theirs]), before, "no input changed");
  const both = out.find((c) => c.id === "c1").replies;
  assert.notEqual(both[0], mine.comments[0].replies[0], "the merged reply is a copy of mine's");
  assert.notEqual(both[1], theirs.comments[0].replies[0], "and of theirs'");
  assert.deepEqual(both.map((r) => r.author), ["Anonymous", "Anonymous"], "migrateRows wrote into the copies");
  assert.equal("author" in mine.comments[0].replies[0], false);
  assert.equal("author" in theirs.comments[0].replies[0], false);
  assert.equal("author" in mine.comments[1].replies[0], false, "a comment only one side holds is copied too");
});

test("a comment I deleted and they replied to comes back; one nobody touched does not", () => {
  const base = commentDoc([cmt()]);
  const mine = commentDoc([]);
  const withReply = commentDoc([cmt({ replies: [{ id: "rp1", body: "hi", author: "Bo", createdAt: "2026-01-04T00:00:00.000Z" }] })]);
  assert.equal(mergeStates(base, mine, withReply).merged.comments.filter((c) => c.id === "c1").length, 1);

  const untouched = commentDoc([cmt()]);
  assert.equal(mergeStates(base, mine, untouched).merged.comments.filter((c) => c.id === "c1").length, 0);
});

test("rev is max of both sides plus one", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.rev = 4; theirs.rev = 7;
  assert.equal(mergeStates(base, mine, theirs).merged.rev, 8);
});

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function pic(w, h) {
  return intern(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
    ...be32(w), ...be32(h), 8, 6, 0, 0, 0, ...be32(0), ...be32(0), 0x49, 0x45, 0x4e, 0x44]));
}
function imgDoc(ref) {
  return rowDoc([{ id: "r1", audioText: "a", imageRef: ref }]);
}

test("pictures compare by sha: two records of the same bytes are the same picture", () => {
  const a = pic(10, 10);
  const x = imgDoc(a), y = imgDoc({ ...a });
  assert.notEqual(x.rows[0].imageRef, y.rows[0].imageRef);
  assert.ok(rowContentEqual(x.rows[0], y.rows[0]));
  assert.ok(!rowContentEqual(x.rows[0], imgDoc(pic(11, 10)).rows[0]));
  assert.ok(!rowContentEqual(x.rows[0], imgDoc(null).rows[0]));
});

test("a picture only one side changed: that side wins, with no conflict", () => {
  const a = pic(20, 10), b = pic(21, 10);
  const mineChanged = mergeStates(imgDoc(a), imgDoc(b), imgDoc(a));
  assert.deepEqual(mineChanged.merged.rows[0].imageRef, b);
  assert.equal(mineChanged.conflicts.length, 0);
  assert.equal(mineChanged.stats.rowsFromMe, 1);
  const theirsChanged = mergeStates(imgDoc(a), imgDoc(a), imgDoc(b));
  assert.deepEqual(theirsChanged.merged.rows[0].imageRef, b);
  assert.equal(theirsChanged.conflicts.length, 0);
  const removedByMe = mergeStates(imgDoc(a), imgDoc(null), imgDoc(a));
  assert.equal(removedByMe.merged.rows[0].imageRef, null);
  const mine = imgDoc(b);
  assert.notEqual(mergeStates(imgDoc(a), mine, imgDoc(a)).merged.rows[0].imageRef, mine.rows[0].imageRef);
});

test("both sides changed the picture: theirs is live, mine is a card holding it as imageValue", () => {
  const a = pic(30, 10), b = pic(31, 10), c = pic(32, 10);
  const res = mergeStates(imgDoc(a), imgDoc(b), imgDoc(c));
  assert.deepEqual(res.merged.rows[0].imageRef, c);
  assert.equal(res.conflicts.length, 1);
  const card = res.merged.comments.find((k) => k.kind === "conflict");
  assert.equal(card.field, "visualImage", "the comment's field keeps its old name");
  assert.equal(card.conflictField, "Visual image");
  assert.deepEqual(card.imageValue, b);
  assert.equal(card.body, '<img class="comment-img" data-blob="' + b.sha256 + '" data-w="31" data-h="10" data-mime="image/png">');
  assert.equal(card.emptyValue, false);
  const again = migrateRows(cloneState(res.merged));
  assert.deepEqual(again.comments.find((k) => k.id === card.id).imageValue, b);
  const cleared = mergeStates(imgDoc(a), imgDoc(null), imgDoc(c)).merged.comments.find((k) => k.kind === "conflict");
  assert.equal(cleared.imageValue, null);
  assert.equal(cleared.body, "");
  assert.equal(cleared.emptyValue, true);
});

test("a stash carries the pictures the store does not hold, and they come back", () => {
  const b = pic(40, 10);
  const url = "data:image/png;base64," + Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
    ...be32(41), ...be32(10), 8, 6, 0, 0, 0, ...be32(0), ...be32(0), 0x49, 0x45, 0x4e, 0x44])).toString("base64");
  const stash = { mine: imgDoc(b), blobs: { ["0".repeat(64)]: url } };
  acceptStash(stash, imgDoc(null));
  assert.equal(stash.mine.rows[0].imageRef.sha256, b.sha256);
});

test("stashLocalWork writes refs, plus the bytes of every picture not durably stored", () => {
  setBackend(createMemoryBackend());
  const b = pic(60, 10), c = pic(61, 10);
  const was = { state: S.state, base: S.baseState };
  S.state = imgDoc(b);
  S.baseState = imgDoc(c);
  try {
    assert.equal(stashLocalWork(), true);
    const st = readStash();
    assert.deepEqual(st.mine.rows[0].imageRef, b);
    assert.equal(JSON.stringify(st.mine).indexOf("data:image"), -1, "the document itself holds refs");
    assert.deepEqual(Object.keys(st.blobs).sort(), [b.sha256, c.sha256].sort());
    assert.equal(st.blobs[b.sha256], dataUrlForSync(b.sha256));
    assert.equal(st.imagesStripped, undefined);
  } finally {
    S.state = was.state;
    S.baseState = was.base;
    sessionStorage.clear();
  }
});

test("one release: an older stash's \"__IMAGE__\" sentinels take theirs' picture", () => {
  const a = pic(50, 10), c = pic(51, 10);
  const stash = {
    imagesStripped: true,
    base: { title: "R", schema: 2, rows: [{ id: "r1", audioText: "a", visualImage: "__IMAGE__" }] },
    mine: { title: "R", schema: 2, rows: [{ id: "r1", audioText: "mine", visualImage: "__IMAGE__" }, { id: "r2", audioText: "new", visualImage: null }] }
  };
  const theirs = imgDoc(c);
  acceptStash(stash, theirs);
  assert.equal(stash.imagesStripped, undefined);
  assert.deepEqual(stash.mine.rows[0].imageRef, c);
  assert.equal("visualImage" in stash.mine.rows[0], false);
  const res = mergeStates(migrateRows(stash.base), migrateRows(stash.mine), theirs);
  assert.deepEqual(res.merged.rows[0].imageRef, c, "their picture is kept");
  assert.equal(res.merged.rows[0].audioText, "mine", "and my text still merges");
  assert.equal(res.conflicts.length, 0, "no empty card for a picture nobody can know about");
  void a;
});

const span = (cat, name, text) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${text || name}</span>`;
function cellDoc(audioText, productionTags) {
  return migrateRows({
    title: "R", schema: 2,
    rows: [{ id: "r1", audioText: audioText }],
    productionTags: productionTags || []
  });
}

test("a word changed on each side of one cell: both words are kept, no conflict", () => {
  const base = cellDoc("the cat sat on the mat");
  const mine = cellDoc("the dog sat on the mat");
  const theirs = cellDoc("the cat sat on the rug");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "the dog sat on the rug");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.merged.comments.length, 0, "no Unmerged edit card");
  assert.equal(res.stats.rowsFromMe, 1);
  assert.equal(res.stats.rowsFromThem, 0);
});

test("#85: a tag wrapped round words on one side, a word fixed elsewhere on the other — both", () => {
  const base = cellDoc("Put the red mug on the tabel");
  const mine = cellDoc("Put the " + span("prop", "red mug") + " on the tabel");
  const theirs = cellDoc("Put the red mug on the table");
  assert.equal(mine.productionTags.length, 1, "tagging registered the item on my side");
  for (const [m, t] of [[mine, theirs], [theirs, mine]]) {
    const res = mergeStates(base, cloneState(m), cloneState(t));
    assert.equal(res.merged.rows[0].audioText, "Put the " + span("prop", "red mug") + " on the table");
    assert.equal(res.conflicts.length, 0);
    assert.deepEqual(res.merged.productionTags.map((x) => x.name), ["red mug"]);
  }
});

test("the same words changed differently on both sides: the conflict card, exactly as before", () => {
  const base = cellDoc("the cat sat on the mat");
  const mine = cellDoc("the dog sat on the mat, <strong>twice</strong>");
  const theirs = cellDoc("the cow sat on the mat");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "the cow sat on the mat", "theirs stays live");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].field, "audioText");
  const card = res.merged.comments.find((c) => c.kind === "conflict");
  assert.equal(card.rowId, "r1");
  assert.equal(card.conflictField, "Audio");
  assert.equal(card.body, "the dog sat on the mat, <strong>twice</strong>", "the card holds my whole cell");
  assert.equal(res.stats.rowsFromMe, 0);
  assert.equal(res.stats.rowsFromThem, 1);
});

test("a tag renamed on one side and the cell edited on the other: both, under the new name", () => {
  const base = cellDoc("Pour the " + span("prop", "Mug", "mug") + " out now");
  const id = base.productionTags[0].id;
  const renamed = cellDoc("Pour the " + span("prop", "Cup", "mug") + " out now",
    [{ id: id, cat: "prop", name: "Cup", owner: "", notes: "", status: "needed" }]);
  const edited = cellDoc("Pour the " + span("prop", "Mug", "mug") + " out slowly");
  const want = "Pour the " + span("prop", "Cup", "mug") + " out slowly";
  for (const [m, t] of [[renamed, edited], [edited, renamed]]) {
    const res = mergeStates(base, cloneState(m), cloneState(t));
    assert.equal(res.merged.rows[0].audioText, want);
    assert.equal(res.conflicts.length, 0);
    assert.deepEqual(res.merged.productionTags.map((x) => [x.id, x.name]), [[id, "Cup"]],
      "one entry, renamed — the old name is not healed back in beside it");
  }
});

test("a formatting change on one side and a text change on the other: both", () => {
  const base = cellDoc("a quick brown fox");
  const mine = cellDoc("a <strong>quick</strong> brown fox");
  const theirs = cellDoc("a quick brown dog");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "a <strong>quick</strong> brown dog");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.stats.rowsFromMe, 1);
});

const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;

test("both set a different link on the same word: the merged cell is live, a card holds mine", () => {
  const base = cellDoc("see the docs for more");
  const mine = cellDoc("see the " + link("https://mine.example/", "docs") + " for more");
  const theirs = cellDoc("see the " + link("https://theirs.example/", "docs") + " for more");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, theirs.rows[0].audioText, "their link stays live");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].field, "audioText");
  const card = res.merged.comments.find((c) => c.kind === "conflict");
  assert.equal(card.rowId, "r1");
  assert.equal(card.conflictField, "Audio");
  assert.equal(card.body, mine.rows[0].audioText, "the card holds my whole cell, my link in it");
  assert.equal(res.stats.rowsFromMe, 0);
  assert.equal(res.stats.rowsFromThem, 1);
});

test("different links on one word and different words edited elsewhere: both words live, a card for my link", () => {
  const base = cellDoc("see the docs for more");
  const mine = cellDoc("see the " + link("https://mine.example/", "docs") + " for more");
  const theirs = cellDoc("see the " + link("https://theirs.example/", "docs") + " for less");
  const mine2 = cellDoc("look at the " + link("https://mine.example/", "docs") + " for more");
  const res = mergeStates(base, mine2, theirs);
  assert.equal(res.merged.rows[0].audioText, "look at the " + link("https://theirs.example/", "docs") + " for less",
    "everything else merged; their link on the word both linked");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.merged.comments.find((c) => c.kind === "conflict").body, mine2.rows[0].audioText);
  assert.equal(res.stats.rowsFromMe, 1);
  const ctx = textMergeContext(base, mine, theirs);
  const r = mergeTextField(base.rows[0].audioText, mine.rows[0].audioText, theirs.rows[0].audioText, ctx);
  assert.equal(r.outcome, "conflict");
  assert.equal(r.marks, true);
});

test("both set a different tag on the same word: theirs is live, a card holds mine", () => {
  const base = cellDoc("pour the mug out now");
  const mine = cellDoc("pour the " + span("prop", "Mug", "mug") + " out now");
  const theirs = cellDoc("pour the " + span("prop", "Cup", "mug") + " out now");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, theirs.rows[0].audioText);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.merged.comments.find((c) => c.kind === "conflict").body, mine.rows[0].audioText);
  assert.deepEqual(res.merged.productionTags.map((x) => x.name).sort(), ["Cup", "Mug"]);
});

test("one side links a word, the other edits a different word: both, no card", () => {
  const base = cellDoc("see the docs for more");
  const mine = cellDoc("see the " + link("https://mine.example/", "docs") + " for more");
  const theirs = cellDoc("see the docs for less");
  for (const [m, t] of [[mine, theirs], [theirs, mine]]) {
    const res = mergeStates(base, cloneState(m), cloneState(t));
    assert.equal(res.merged.rows[0].audioText, "see the " + link("https://mine.example/", "docs") + " for less");
    assert.equal(res.conflicts.length, 0);
    assert.equal(res.merged.comments.length, 0, "no Unmerged edit card");
  }
});

test("both set the same link on a word: no card, whatever else changed", () => {
  const base = cellDoc("see the docs for more");
  const mine = cellDoc("see the " + link("https://same.example/", "docs") + " for more");
  let res = mergeStates(base, mine, cloneState(mine));
  assert.equal(res.merged.rows[0].audioText, mine.rows[0].audioText);
  assert.equal(res.conflicts.length, 0);
  const theirs = cellDoc("see the " + link("https://same.example/", "docs") + " for less");
  res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, theirs.rows[0].audioText);
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.merged.comments.length, 0);
});

test("a link conflict touches only its own cell, so undo forgets only that one (design D4)", () => {
  const two = (a1, a2) => migrateRows({ title: "R", schema: 2, rows: [{ id: "r1", audioText: a1 }, { id: "r2", audioText: a2 }] });
  const base = two("see the docs", "second scene");
  const mine = two("see the " + link("https://mine.example/", "docs"), "second scene, mine");
  const theirs = two("see the " + link("https://theirs.example/", "docs"), "second scene");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.conflicts.length, 1);
  const touched = changedBetween(mine, res.merged);
  assert.deepEqual(Object.keys(touched.rowFields), ["r1\u0000audioText"],
    "my edit in the other scene is untouched, so its undo entry survives");
  assert.equal(touched.structure, false);
});

test("formatting both sides toggled on the same word is never a conflict", () => {
  const base = cellDoc("a quick brown fox");
  const mine = cellDoc("one <strong>quick</strong> brown fox");
  const theirs = cellDoc("a <em>quick</em> brown dog");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "one <strong><em>quick</em></strong> brown dog");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.merged.comments.length, 0);
  const ctx = textMergeContext(base, mine, theirs);
  const r = mergeTextField(base.rows[0].audioText, mine.rows[0].audioText, theirs.rows[0].audioText, ctx);
  assert.equal(r.outcome, "merged");
  assert.equal(r.marks, undefined);
});

test("a re-serialisation is not a change: the same content, nested differently", () => {
  const old = "<em><strong>x</strong></em> y";
  const canon = "<strong><em>x</em></strong> y";
  assert.notEqual(cellDoc(old).rows[0].audioText, cellDoc(canon).rows[0].audioText, "the fixture really differs as a string");

  let res = mergeStates(cellDoc(old), cellDoc(canon), cellDoc("<em><strong>x</strong></em> z"));
  assert.equal(res.merged.rows[0].audioText, "<em><strong>x</strong></em> z");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.stats.rowsFromMe, 0);

  res = mergeStates(cellDoc(old), cellDoc(canon), cellDoc(old));
  assert.equal(res.merged.rows[0].audioText, old);
  assert.equal(res.stats.rowsFromMe, 0);
  assert.equal(res.stats.rowsFromThem, 0);

  res = mergeStates(cellDoc(old), cellDoc("<em><strong>x</strong></em> w"), cellDoc(canon));
  assert.equal(res.merged.rows[0].audioText, "<em><strong>x</strong></em> w");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.stats.rowsFromMe, 1);

  res = mergeStates(null, cellDoc(canon), cellDoc(old));
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.merged.rows[0].audioText, old, "theirs' string is preferred");
});

test("mergeTextField names each outcome the way mergeRow acts on it", () => {
  const b = cellDoc("one two three"), ctx = textMergeContext(b, b, b);
  const f = (base, mine, theirs) => mergeTextField(base, mine, theirs, ctx);
  assert.deepEqual(f("one two three", "one two three", "one two three"), { html: "one two three", outcome: "same" });
  assert.deepEqual(f("one two three", "one 2 three", "one two three"), { html: "one 2 three", outcome: "mine" });
  assert.deepEqual(f("one two three", "one two three", "one two 3"), { html: "one two 3", outcome: "theirs" });
  assert.deepEqual(f("one two three", "1 two three", "one two 3"), { html: "1 two 3", outcome: "merged" });
  assert.deepEqual(f("one two three", "one 2 three", "one II three"), { html: "one II three", outcome: "conflict" });
  assert.deepEqual(f("one two three", "one 2 three", "one 2 three"), { html: "one 2 three", outcome: "same" });
  assert.equal(f(undefined, "one 2 three", "one two three").outcome, "conflict");
});

test("a cell holding a picture is compared whole, as a string — the model has no place for one", () => {
  const img = '<img class="comment-img" data-blob="' + "a".repeat(64) + '" data-w="1" data-h="1" data-mime="image/png">';
  const b = cellDoc("one two"), ctx = textMergeContext(b, b, b);
  assert.deepEqual(mergeTextField("one two", "one two " + img, "one two", ctx), { html: "one two " + img, outcome: "mine" });
  assert.equal(mergeTextField("one two", "1 two " + img, "one 2", ctx).outcome, "conflict");
});


function withProps(names) {
  const s = mk();
  s.productionTags.push({ cat: "prop", name: "Ladder", owner: "", notes: "", status: "needed" });
  const out = migrateRows(s);
  out.brollShots[0].props = names.map((n) => ({ id: out.productionTags.find((t) => t.name === n).id, name: n }));
  return out;
}
const propNames = (s) => s.brollShots[0].props.map((p) => p.name);

test("b-roll props: both sides' additions are kept", () => {
  const base = withProps([]), mine = withProps(["Kettle"]), theirs = withProps(["Ladder"]);
  assert.deepEqual(propNames(mergeStates(base, mine, theirs).merged).sort(), ["Kettle", "Ladder"]);
});

test("b-roll props: a prop I took off stays off, and so does one they took off", () => {
  const base = withProps(["Kettle", "Ladder"]);
  assert.deepEqual(propNames(mergeStates(base, withProps(["Ladder"]), withProps(["Kettle", "Ladder"])).merged), ["Ladder"]);
  assert.deepEqual(propNames(mergeStates(base, withProps(["Kettle", "Ladder"]), withProps(["Kettle"])).merged), ["Kettle"]);
});

test("b-roll props: a removal on one side and an addition on the other both land", () => {
  const base = withProps(["Kettle"]);
  assert.deepEqual(propNames(mergeStates(base, withProps([]), withProps(["Kettle", "Ladder"])).merged), ["Ladder"]);
});

test("b-roll props: with no base copy of the shot, the two lists union", () => {
  const base = mk();
  base.brollShots = [];
  assert.deepEqual(propNames(mergeStates(base, withProps(["Kettle"]), withProps(["Ladder"])).merged).sort(), ["Kettle", "Ladder"]);
});

test("b-roll props: a copy from before props (no list at all) never removes one", () => {
  const base = withProps(["Kettle"]), mine = withProps(["Kettle"]), theirs = withProps(["Kettle"]);
  delete base.brollShots[0].props;
  delete theirs.brollShots[0].props;
  assert.deepEqual(propNames(mergeStates(base, mine, theirs).merged), ["Kettle"]);
});

test("b-roll props: one side's name-only copy and the other's id'd one are one prop", () => {
  const base = withProps([]), mine = withProps(["Kettle"]), theirs = withProps([]);
  theirs.brollShots[0].props = [{ id: "", name: "kettle" }];
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.brollShots[0].props.length, 1);
  assert.deepEqual(out.brollShots[0].props[0], mine.brollShots[0].props[0]);
});

test("b-roll props: the other fields of a shot still merge the way they did", () => {
  const base = withProps([]), mine = withProps(["Kettle"]), theirs = withProps([]);
  theirs.brollShots[0].status = "shot";
  mine.brollShots[0].notes = "wide and tight";
  const out = mergeStates(base, mine, theirs).merged.brollShots[0];
  assert.equal(out.status, "shot");
  assert.equal(out.notes, "wide and tight");
  assert.deepEqual(out.props.map((p) => p.name), ["Kettle"]);
});
