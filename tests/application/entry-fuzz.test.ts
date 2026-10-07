import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import type { Command, CommandOutcome, DocumentView } from "../../src/application/session/document-session.ts";
import { cellEdit, changeSet } from "../../src/application/session/change-set.ts";
import { createRichText } from "../../src/adapters/richtext/richtext.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import { createImageIngestion } from "../../src/core/document/media.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { mergeStates } from "../../src/core/merge-states.ts";
import type { MergeStatesPorts } from "../../src/core/merge-states.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import type { MigratePorts } from "../../src/core/migrate.ts";
import { createProductionReaders } from "../../src/core/production/readers.ts";
import { jsdomParser } from "../adapters/richtext/jsdom.mjs";
import { EDITOR, fixedClock } from "../core/merge/fakes.ts";
import { countingIds, jsonCopy } from "../core/migrate-ports.ts";
import { TABLE_304, chance, judge, pick, rawDocument, rawObject, seeded, table304Document } from "./raw-inputs.ts";
import type { Json, Random } from "./raw-inputs.ts";
import { harness, runConfined } from "./session-fakes.ts";

const SEEDS = Number(process.env.SPLITPAGE_FUZZ_SEEDS) || 150;
const STEPS = 8;

type Kind = "adopt" | "server" | "merge" | "recovery" | "reload" | "edit" | "insert";

const KINDS: readonly Kind[] = ["adopt", "server", "merge", "recovery", "reload", "edit", "insert"];

const Parser: new () => DOMParser = jsdomParser();

const images = createImageIngestion(function () { return null; });
const rt = createRichText({ DOMParser: Parser, images: images, ids: countingIds() });
const readers = createProductionReaders(rt.createCellReader(deepFreeze), deepFreeze);
const sanitized = new Map<string, string>();

function sanitize(html: unknown): string {
  const key = typeof html === "string" ? html : null;
  const known = key === null ? undefined : sanitized.get(key);
  if (known !== undefined) return known;
  const out = rt.sanitize(html);
  if (key !== null) sanitized.set(key, out);
  return out;
}

function adapterPorts(): MigratePorts {
  return {
    images: images,
    sanitize: sanitize,
    decode: function (html, opts) { return rt.decode(html, opts); },
    videoCardHtml: function (href) { return rt.videoCardHtml(href); },
    readers: readers,
    ids: countingIds()
  };
}

function migrate(raw: unknown): ValidatedDocument {
  return migrateRows(raw, adapterPorts());
}

function fuzzHarness(): ReturnType<typeof harness> {
  return harness(undefined, { entry: migrate });
}

function mergePorts(): MergeStatesPorts {
  const ports = adapterPorts();
  return { decode: ports.decode, ids: ports.ids, clock: fixedClock, editor: function () { return EDITOR; }, migrate: ports };
}

function setAudio(pickRow: (doc: DocumentView) => string | null, text: string): Command {
  return {
    name: "set-audio",
    needs: "edit",
    plan: function (doc) {
      const rowId = pickRow(doc);
      if (rowId === null) return { refused: "no scene" };
      return {
        changes: cellEdit(rowId, "audioText", ["production"]),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === rowId; });
          if (target) target.audioText = text;
        }
      };
    }
  };
}

function insertRow(id: string): Command {
  return {
    name: "insert-row",
    needs: "edit",
    plan: function () {
      return {
        changes: changeSet({ rowsInserted: [id] }),
        apply: function (live) {
          live.rows.push({ id: id, visualText: "", audioText: "", status: "todo", imageRef: null, updatedAt: "", updatedBy: null });
        }
      };
    }
  };
}

function plain(log: readonly string[]): string[] {
  return log.map(function (e) { return e.replace(/^(undo\.(?:adopt|server)):.*$/s, "$1"); });
}

function expectedLog(kind: Kind, migrated: boolean, outcome: CommandOutcome | null, generation: number): string[] {
  const entered = migrated ? ["entry"] : [];
  if (kind === "adopt") return entered.concat(["undo.adopt", "publish:adopt"]);
  if (kind === "server" || kind === "merge") return entered.concat(["undo.server", "publish:server"]);
  if (kind === "recovery") return entered.concat(["undo.server", "publish:recovery"]);
  if (kind === "reload") return ["undo.reload", "publish:reload"];
  if (!outcome || outcome.kind !== "applied") return [];
  const effects = ["undo.record", "dirty:" + generation, "draft:" + generation, "save:" + generation, "publish:edit"];
  return kind === "insert" ? ["reconcile"].concat(effects) : effects;
}

export interface Tally {
  steps: number;
  kinds: Record<string, number>;
  known: Record<string, number>;
  typed: Record<string, number>;
}

function newTally(): Tally {
  return { steps: 0, kinds: {}, known: {}, typed: {} };
}

function bump(into: Record<string, number>, key: string): void {
  into[key] = (into[key] || 0) + 1;
}

function rowIdOf(r: Random): (doc: DocumentView) => string | null {
  const roll = r();
  return function (doc) {
    if (!doc.rows.length) return null;
    const row = doc.rows[Math.floor(roll * doc.rows.length)];
    return row ? row.id : null;
  };
}

export function runSeed(seed: number, tally: Tally = newTally()): Tally {
  const r = seeded(seed);
  const h = fuzzHarness();
  const session = h.session;
  let base: unknown = null;
  for (let step = 0; step < STEPS; step++) {
    let kind: Kind = pick(r, KINDS);
    const held = session.read(function (d) { return d; });
    if (!held && (kind === "merge" || kind === "reload")) kind = "adopt";
    const where = "seed " + seed + ", step " + step + " (" + kind + ")";
    const epoch = session.epoch(), generation = session.generation();
    const heldText = JSON.stringify(held);
    h.log.length = 0;
    h.published.length = 0;
    let raw: unknown;
    let returned: ValidatedDocument | null | undefined;
    let outcome: CommandOutcome | null = null;
    try {
      if (kind === "adopt" || kind === "server" || kind === "recovery") {
        raw = rawDocument(r);
        returned = kind === "adopt" ? session.adopt(raw) : kind === "server" ? session.absorbServer(raw) : session.absorbRecovery(raw);
      } else if (kind === "merge") {
        const theirs = rawObject(r);
        const mine = migrate(jsonCopy(held));
        const ancestor = base && chance(r, 0.7) ? migrate(jsonCopy(base)) : null;
        const inputs = JSON.stringify([ancestor, mine, theirs]);
        const result = mergeStates(ancestor, mine, migrate(jsonCopy(theirs)), mergePorts());
        assert.equal(JSON.stringify([ancestor, mine, theirs]), inputs, where + ": the merge wrote into an input");
        returned = session.absorbServer(result.merged);
      } else if (kind === "reload") {
        session.absorbReload();
      } else if (kind === "edit") {
        outcome = runConfined(session, setAudio(rowIdOf(r), "Fuzzed " + seed + "-" + step + "."));
      } else {
        outcome = runConfined(session, insertRow("f" + seed + "x" + step));
      }
    } catch (error) {
      assert.fail(where + " threw: " + (error instanceof Error ? error.stack : String(error)));
    }
    tally.steps++;
    bump(tally.kinds, kind);
    const now = session.read(function (d) { return d; });
    const applied = !!outcome && outcome.kind === "applied";
    const opens = kind === "adopt" || kind === "recovery";
    assert.equal(session.epoch(), epoch + (opens ? 1 : 0), where + ": epoch");
    assert.equal(session.generation(), generation + (applied ? 1 : 0), where + ": generation");
    const migrated = kind === "merge" || (raw !== null && raw !== undefined);
    assert.deepEqual(plain(h.log), expectedLog(kind, migrated, outcome, session.generation()), where + ": ports and publication");
    if (kind === "edit" || kind === "insert") {
      const want = !held ? "rejected" : kind === "edit" && !held.rows.length ? "rejected" : "applied";
      assert.equal(outcome && outcome.kind, want, where + ": command outcome");
      if (outcome && outcome.kind === "rejected") {
        bump(tally.typed, outcome.reason);
        if (!held) assert.equal(outcome.reason, NO_DOCUMENT, where);
      }
      assert.equal(now, held, where + ": a command keeps the document");
    } else if (kind === "reload") {
      assert.equal(now, held, where + ": a reload keeps the document");
      assert.equal(JSON.stringify(now), heldText, where + ": the session writes nothing on a reload");
    } else {
      assert.equal(now, returned, where + ": the session holds what it returned");
      assert.equal(returned === null, raw === null, where + ": only a missing document closes the session");
      assert.equal(JSON.stringify(held), heldText, where + ": the document it replaced was not written into");
      if (returned === null) bump(tally.typed, "closed");
    }
    if (now) {
      const verdict = judge(now, migrate);
      assert.deepEqual(verdict.problems, [], where + ": " + JSON.stringify(now).slice(0, 400));
      verdict.known.forEach(function (k) { bump(tally.known, k); });
      if (kind !== "edit" && kind !== "insert" && kind !== "reload") base = jsonCopy(now);
    }
  }
  return tally;
}

test("seeded raw inputs through adoption, server updates, merges, recoveries, reloads and commands end in a valid fixed point, with the epoch and generation exact", (t) => {
  const tally = newTally();
  for (let seed = 1; seed <= SEEDS; seed++) runSeed(seed, tally);
  t.diagnostic(JSON.stringify(tally));
  assert.equal(tally.steps, SEEDS * STEPS);
  KINDS.forEach(function (k) { assert.ok((tally.kinds[k] || 0) > SEEDS / 2, "every entry point is exercised: " + k); });
});

function spoiledPair(spoil: (d: { [key: string]: Json }) => void): { mine: Json; theirs: Json } {
  const mine = table304Document("Mine");
  const theirs = table304Document("Theirs");
  spoil(theirs);
  return { mine: mine, theirs: theirs };
}

TABLE_304.forEach(function (row304) {
  test("#304's table, " + row304.label + ": adoption, a server update, a merge and a recovery each end in a valid fixed point", () => {
    const h = fuzzHarness();
    const pair = spoiledPair(row304.spoil);
    const mineRaw = row304.bothSides ? jsonCopy(pair.theirs) : pair.mine;
    const adopted = h.session.adopt(mineRaw);
    assert.ok(adopted);
    assert.deepEqual(judge(adopted, migrate).problems, [], "adopted");
    const mine = migrate(jsonCopy(adopted));
    const theirs = jsonCopy(pair.theirs);
    const theirsText = JSON.stringify(theirs);
    const result = mergeStates(migrate(table304Document("Base")), mine, migrate(jsonCopy(theirs)), mergePorts());
    assert.equal(JSON.stringify(theirs), theirsText, "the merge wrote into the raw theirs");
    const merged = h.session.absorbServer(result.merged);
    assert.deepEqual(judge(merged, migrate).problems, [], "merged");
    const served = h.session.absorbServer(jsonCopy(pair.theirs));
    assert.deepEqual(judge(served, migrate).problems, [], "server update");
    const recovered = h.session.absorbRecovery(jsonCopy(pair.theirs));
    assert.deepEqual(judge(recovered, migrate).problems, [], "recovery");
    assert.equal(h.session.read(function (d) { return d; }), recovered);
    assert.deepEqual([h.session.epoch(), h.session.generation()], [2, 0]);
    assert.deepEqual(h.published.map(function (c) { return c.kind; }), ["adopt", "server", "server", "recovery"]);
    const edited = runConfined(h.session, setAudio(function (d) { return d.rows[0] ? d.rows[0].id : null; }, "After #304."));
    assert.equal(edited.kind, recovered && recovered.rows.length ? "applied" : "rejected");
  });
});

test("the fuzz's judge finds what it should: a raw document, a bad status and a changed re-migration are problems", () => {
  assert.deepEqual(judge({ title: "x", rows: [] }, migrate).problems.slice(0, 2), ["docId", "rev"]);
  const doc = migrate({ rows: [{ id: "r1", status: "todo" }] });
  const bad = jsonCopy(doc);
  if (bad.rows[0]) bad.rows[0].status = "bogus";
  assert.deepEqual(judge(bad, migrate).problems.slice(0, 1), ["rows[0].status"]);
  const unmigrated = jsonCopy(doc);
  Reflect.deleteProperty(unmigrated.rows[0] || {}, "status");
  assert.match(String(judge(unmigrated, migrate).problems.join(" ")), /not a migrateRows fixed point/);
  assert.deepEqual(judge({ ...doc, rows: [{ id: "r1" }] }, migrate).problems.slice(0, 1), ["rows[0].status"]);
  const spaced = jsonCopy(migrate({ rows: [{ id: "r1", status: "todo" }], productionTags: [{ cat: "prop", name: "kettle" }] }));
  if (spaced.rows[0]) spaced.rows[0].audioText = "a".repeat(199) + " ";
  if (spaced.productionTags[0]) spaced.productionTags[0].name = "n".repeat(79) + " ";
  const trimEnds = function (raw: unknown): unknown { return JSON.parse(JSON.stringify(raw).replace(/ "/g, '"')); };
  const cell = judge(spaced, trimEnds);
  assert.equal(cell.problems.length, 1);
  assert.match(String(cell.problems[0]), /^not a migrateRows fixed point: \.rows\[0\]\.audioText "a+ became "a+, \.productionTags\[0\]\.name "n+ " became "n+"$/);
  assert.deepEqual(cell.known, []);
  assert.deepEqual(judge({ ...doc, rows: [[]] }, migrate).problems.slice(0, 1), ["rows[0] is an array"]);
  assert.deepEqual(judge([doc], migrate).problems.slice(0, 1), ["the document is an array"]);
  assert.deepEqual(judge({ ...doc, rev: NaN }, migrate).problems.slice(0, 1), ["rev"]);
  const stamped = migrate({ rows: [], comments: [{ id: "c1", rowId: "r1", replies: [{ id: "rp1" }] }] });
  const comment = stamped.comments[0];
  assert.ok(comment && comment.replies && comment.replies[0]);
  assert.deepEqual(judge(stamped, migrate), { problems: [], known: [] });
  assert.deepEqual(judge({ ...stamped, comments: [{ ...comment, createdAt: 5 }] }, migrate).problems.slice(0, 1), ["comments[0].createdAt"]);
  assert.deepEqual(judge({ ...stamped, comments: [{ ...comment, replies: [{ ...comment.replies[0], createdAt: {} }] }] }, migrate).problems.slice(0, 1), ["comments[0].replies[0].createdAt"]);
});

test("migrateRows trims what the cut at a name's cap leaves, so the name ends in no space and a second migration keeps it (#406)", () => {
  const name = "n".repeat(59) + " x";
  const once = migrate({ rows: [], people: [{ id: "p1", name: name }] });
  assert.equal(JSON.stringify(once.people), JSON.stringify([{ id: "p1", name: "n".repeat(59) }]));
  assert.equal(JSON.stringify(migrate(jsonCopy(once)).people), JSON.stringify(once.people));
  assert.deepEqual(judge(once, migrate), { problems: [], known: [] });
});

test("a JSON object whose toString is not a function is no text: each of the session's entries takes the document, and nothing throws (#408)", () => {
  const h = fuzzHarness();
  assert.ok(h.session.adopt(table304Document("Kept")));
  const served = h.session.absorbServer(JSON.parse('{"title":{"toString":1},"rows":[]}'));
  const recovered = h.session.absorbRecovery(JSON.parse('{"rows":[],"comments":[{"rowId":{"valueOf":null,"toString":null}}]}'));
  const adopted = h.session.adopt(JSON.parse('{"rows":[{"id":{"toString":"r1"}}]}'));
  assert.ok(served && recovered && adopted);
  assert.equal(served.title, "");
  assert.equal(recovered.comments.length, 1);
  assert.notEqual(adopted.rows[0]?.id, "r1");
  for (const doc of [served, recovered, adopted]) assert.deepEqual(judge(doc, migrate), { problems: [], known: [] });
  assert.equal(h.session.read(function (d) { return d; }), adopted);
  assert.deepEqual([h.session.epoch(), h.session.generation()], [3, 0]);
  assert.deepEqual(h.published.map(function (c) { return c.kind; }), ["adopt", "server", "recovery", "adopt"]);
});

test("a reply whose createdAt is a number migrates to null, and merging a comment both sides hold sorts its replies (#409)", () => {
  const raw = table304Document("Replies");
  raw.comments = [{ id: "c1", rowId: "r1", field: "audioText", body: "Tighter", replies: [{ id: "rp1", body: "a", createdAt: "2026-10-07" }, { id: "rp2", body: "b", createdAt: 5 }] }];
  const h = fuzzHarness();
  const mine = h.session.adopt(jsonCopy(raw));
  assert.ok(mine);
  assert.equal(JSON.stringify(mine.comments[0]?.replies?.map(function (rep) { return rep.createdAt; })), '["2026-10-07",null]');
  assert.deepEqual(judge(mine, migrate), { problems: [], known: [] });
  const theirs = migrate(jsonCopy(raw));
  if (theirs.comments[0]) theirs.comments[0].body = "Theirs";
  const result = mergeStates(migrate(jsonCopy(raw)), migrate(jsonCopy(mine)), theirs, mergePorts());
  assert.deepEqual(result.merged.comments[0]?.replies?.map(function (rep) { return rep.id; }), ["rp2", "rp1"]);
  const merged = h.session.absorbServer(result.merged);
  assert.equal(h.session.read(function (d) { return d; }), merged);
  assert.deepEqual(judge(merged, migrate), { problems: [], known: [] });
});

test("a rev that is not a finite number enters the session as 0, so the session never holds a rev that JSON saves as null (#412)", () => {
  const h = fuzzHarness();
  for (const rev of [NaN, Infinity, "seven"]) {
    const held = h.session.absorbServer({ ...table304Document("Rev"), rev: rev });
    assert.ok(held);
    assert.equal(held.rev, 0, String(rev));
    assert.deepEqual(judge(held, migrate), { problems: [], known: [] });
  }
});

const FOUND: readonly (readonly [number, string])[] = [
  [3, "#406"],
  [5, "#407"],
  [44, "#412"],
  [52, "#408"],
  [4103, "#409"]
];

FOUND.forEach(function ([seed, issue]) {
  test("seed " + seed + ", which found " + issue + ", now ends every step in a valid fixed point", () => {
    const tally = runSeed(seed);
    assert.equal(tally.steps, STEPS);
    assert.deepEqual(tally.known, {});
  });
});

test("an array is no document: adopting one opens an empty script, and an array scene is dropped (#407)", () => {
  const h = fuzzHarness();
  const held = h.session.adopt([{ id: "r1", audioText: "x" }]);
  assert.ok(held);
  assert.equal(Array.isArray(held), false);
  assert.deepEqual([held.title, held.rows], ["Untitled Script", []]);
  assert.deepEqual(judge(held, migrate), { problems: [], known: [] });
  const scene = h.session.absorbServer({ rows: [[], { id: "r2" }] });
  assert.ok(scene);
  assert.equal(JSON.stringify(scene.rows), '[{"id":"r2","status":"todo","visualText":"","audioText":"","imageRef":null,"updatedAt":"","updatedBy":null}]');
  assert.deepEqual(judge(scene, migrate), { problems: [], known: [] });
});
