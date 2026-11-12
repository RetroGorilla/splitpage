import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command, DocumentView } from "../../src/application/session/document-session.ts";
import type { Capability, CapabilityPort } from "../../src/application/session/ports.ts";
import type { CellRewrite } from "../../src/application/commands/document-edit.ts";
import { addCommentCommand, addReplyCommand, unwrapCommentAnchorCommand } from "../../src/application/commands/comments.ts";
import { harness, rawScript, runConfined } from "./session-fakes.ts";
import { viewOf } from "./plan-views.ts";

const CLOCK = { nowIso: function () { return "2026-11-11T12:00:00.000Z"; } };
const NO_ACCESS = "no access";

interface CommentCase {
  readonly name: string;
  readonly changing: (order: string[]) => Command;
  readonly idle: (order: string[]) => Command;
}

function unwrapTo(html: string, order: string[]): (doc: DocumentView) => readonly CellRewrite[] {
  return function () {
    order.push("unwrap");
    return [{ rowId: "r1", field: "audioText", html: html }];
  };
}

const CASES: readonly CommentCase[] = [
  {
    name: "add-comment",
    changing: function () { return addCommentCommand({ id: "c2", rowId: "r2", field: "audioText", body: "Why?", replies: [] }); },
    idle: function () { return addCommentCommand({ id: "c1", body: "again" }); }
  },
  {
    name: "add-reply",
    changing: function () { return addReplyCommand("c1", { id: "x1", body: "Done" }, CLOCK); },
    idle: function () { return addReplyCommand("c9", { id: "x1" }, CLOCK); }
  },
  {
    name: "unwrap-comment-anchor",
    changing: function (order) { return unwrapCommentAnchorCommand(unwrapTo("Every morning!", order)); },
    idle: function (order) { return unwrapCommentAnchorCommand(unwrapTo("Every morning.", order)); }
  }
];

function asking(order: string[], comment: Capability): CapabilityPort {
  return {
    edit: function () { order.push("edit"); return { allowed: false, reason: "review" }; },
    comment: function () { order.push("comment"); return comment; }
  };
}

function watched(order: string[]): DocumentView {
  return new Proxy(viewOf(rawScript("Harbour")), {
    get: function (target, key, receiver): unknown {
      order.push("document");
      return Reflect.get(target, key, receiver);
    }
  });
}

function opened(): ReturnType<typeof harness> {
  const h = harness();
  h.session.adopt(rawScript("Harbour"));
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function snapshot(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

test("the three comment commands are the audited ones and none needs edit capability", () => {
  assert.deepEqual(CASES.map(function (c) { return c.changing([]).name; }), CASES.map(function (c) { return c.name; }));
  for (const c of CASES) assert.equal(c.changing([]).needs, "nothing", c.name);
});

test("each comment command asks whether commenting is allowed once, before it reads the document, and never asks about editing", () => {
  for (const c of CASES) {
    const order: string[] = [];
    const plan = c.changing(order).plan(watched(order), asking(order, { allowed: true }));
    assert.ok(plan && !("refused" in plan), c.name + " plans its change");
    assert.equal(order[0], "comment", c.name + " asks first");
    assert.equal(order.filter(function (step) { return step === "comment"; }).length, 1, c.name + " asks once");
    assert.equal(order.includes("edit"), false, c.name + " does not ask about editing");
    assert.equal(order.includes("document"), true, c.name + " reads the document after asking");
  }
});

test("a refused comment capability ends each command with the port's reason before it reads the document or its rewrite planner", () => {
  for (const c of CASES) {
    for (const make of [c.changing, c.idle]) {
      const order: string[] = [];
      assert.deepEqual(make(order).plan(watched(order), asking(order, { allowed: false, reason: NO_ACCESS })), { refused: NO_ACCESS }, c.name);
      assert.deepEqual(order, ["comment"], c.name);
    }
  }
});

test("allowed, a command with nothing to do is still a no-op and asked first", () => {
  for (const c of CASES) {
    const order: string[] = [];
    assert.equal(c.idle(order).plan(watched(order), asking(order, { allowed: true })), null, c.name);
    assert.equal(order[0], "comment", c.name);
  }
});

test("a session whose comment capability refuses rejects each comment command and writes nothing", () => {
  for (const c of CASES) {
    for (const make of [c.changing, c.idle]) {
      const h = opened();
      const before = snapshot(h);
      h.denyComment(NO_ACCESS);
      assert.deepEqual(runConfined(h.session, make([])), { kind: "rejected", reason: NO_ACCESS }, c.name);
      assert.equal(h.session.generation(), 0, c.name);
      assert.deepEqual(h.log, [], c.name + " records no undo and runs no effects");
      assert.deepEqual(h.published, [], c.name);
      assert.equal(snapshot(h), before, c.name);
    }
  }
});

test("the comment answer and the edit answer are independent: commenting applies while editing is refused, and is refused while editing is allowed", () => {
  for (const c of CASES) {
    const reviewing = opened();
    reviewing.deny("review");
    assert.equal(runConfined(reviewing.session, c.changing([])).kind, "applied", c.name + " while editing is refused");
    const removed = opened();
    removed.denyComment(NO_ACCESS);
    assert.deepEqual(runConfined(removed.session, c.changing([])), { kind: "rejected", reason: NO_ACCESS }, c.name + " while editing is allowed");
    const both = opened();
    both.deny("review");
    both.denyComment(NO_ACCESS);
    assert.deepEqual(runConfined(both.session, c.changing([])), { kind: "rejected", reason: NO_ACCESS }, c.name + " with both refused");
  }
});
