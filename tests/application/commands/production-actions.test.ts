import "../../../src/test/_dom.mjs";
import { text } from "../../../src/bootstrap/wiring/ports/text.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { newBrollRecord, removeBrollProp, removeTag, renameTag } from "../../../src/application/commands/production-actions.ts";
import type { NewBrollPorts, RemoveTagPorts } from "../../../src/application/commands/production-actions.ts";
import { brollPropKey } from "../../../src/core/document/broll.ts";
import { SCHEMA_VERSION } from "../../../src/core/document/fields.ts";
import { retagMentions, retagRewrites } from "../../../src/application/commands/tag-rewrites.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import type { StampPorts } from "../../../src/application/session/ports.ts";
import { harness, runConfined } from "../session-fakes.ts";
import type { Harness } from "../session-fakes.ts";

const STAMP = "2026-10-15T12:00:00.000Z";

function stamps(): StampPorts {
  return {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { return "Adam"; } }
  };
}

function tag(cat: string, name: string, content: string): string {
  return '<span class="tag-anchor" data-tag-cat="' + cat + '" data-tag-name="' + name + '" contenteditable="false">' + content + "</span>";
}

function opened(extra: Record<string, unknown> = {}): Harness {
  const h = harness();
  h.session.adopt({
    title: "Harbour",
    schema: SCHEMA_VERSION,
    docId: "d" + "1".repeat(32),
    rows: [
      { id: "r1", visualText: "pour from " + tag("prop", "Mug", "the mug"), audioText: "" },
      { id: "r2", visualText: "plain", audioText: "" }
    ],
    productionTags: [{ cat: "prop", name: "Mug" }],
    brollShots: [],
    ...extra
  });
  return h;
}

interface Rig {
  ports: RemoveTagPorts & NewBrollPorts;
  runs: Command[];
}

function rig(h: Harness, firstId = 1): Rig {
  const runs: Command[] = [];
  let issued = firstId;
  return {
    runs: runs,
    ports: {
      run: function (command) {
        runs.push(command);
        const out = runConfined(h.session, command);
        return out.kind === "applied" || out.kind === "committed";
      },
      rewrites: function (tags, name) { return retagRewrites(text, tags, name); },
      stamps: stamps(),
      read: function (select) { return h.session.read(select); },
      mentions: function (doc, tags) { return retagMentions(text, doc, tags); },
      ids: { id: function (prefix) { return prefix + "-" + issued++; }, docId: function () { return "d"; } }
    }
  };
}

function rowHtml(h: Harness, rowId: string): string {
  return h.session.read(function (doc) { return doc?.rows.find(function (r) { return r.id === rowId; })?.visualText ?? ""; });
}

function registryNames(h: Harness): string[] {
  return h.session.read(function (doc) { return (doc?.productionTags ?? []).map(function (t) { return String(t?.name); }); });
}

function shots(h: Harness): { id: string; name: string; status: string; props: readonly unknown[] }[] {
  return h.session.read(function (doc) { return JSON.parse(JSON.stringify(doc?.brollShots ?? [])) as { id: string; name: string; status: string; props: readonly unknown[] }[]; });
}

test("renaming a tag rewrites its mentions and its registry entry through one command", () => {
  const h = opened();
  const r = rig(h);
  assert.equal(renameTag("prop", "Mug", "Cup", r.ports), true);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0]?.name, "rename-tag");
  assert.equal(rowHtml(h, "r1"), "pour from " + tag("prop", "Cup", "the mug"));
  assert.deepEqual(registryNames(h), ["Cup"]);
});

test("the new name is trimmed before it is used", () => {
  const h = opened();
  assert.equal(renameTag("prop", "Mug", "  Cup  ", rig(h).ports), true);
  assert.deepEqual(registryNames(h), ["Cup"]);
});

test("a blank, markup-only or non-text new name is refused without running a command", () => {
  const h = opened();
  const r = rig(h);
  assert.equal(renameTag("prop", "Mug", "", r.ports), false);
  assert.equal(renameTag("prop", "Mug", "   ", r.ports), false);
  assert.equal(renameTag("prop", "Mug", "<b></b>", r.ports), false);
  assert.equal(renameTag("prop", "Mug", null, r.ports), false);
  assert.equal(renameTag("prop", "Mug", undefined, r.ports), false);
  assert.deepEqual(r.runs, []);
  assert.deepEqual(registryNames(h), ["Mug"]);
});

test("a new name is cut to 80 characters", () => {
  const h = opened();
  assert.equal(renameTag("prop", "Mug", "x".repeat(120), rig(h).ports), true);
  assert.deepEqual(registryNames(h), ["x".repeat(80)]);
});

test("renaming reports false when the command is refused", () => {
  const h = opened();
  h.deny("read-only");
  assert.equal(renameTag("prop", "Mug", "Cup", rig(h).ports), false);
  assert.deepEqual(registryNames(h), ["Mug"]);
});

test("removing a tag returns how many mentions it unwrapped and leaves its registry entry alone", () => {
  const h = opened();
  const r = rig(h);
  assert.equal(removeTag("prop", "Mug", r.ports), 1);
  assert.equal(r.runs[0]?.name, "remove-tag");
  assert.equal(rowHtml(h, "r1"), "pour from the mug");
  assert.deepEqual(registryNames(h), ["Mug"]);
});

test("removing a tag nobody mentions runs nothing and returns zero", () => {
  const h = opened();
  const r = rig(h);
  assert.equal(removeTag("prop", "Kettle", r.ports), 0);
  assert.deepEqual(r.runs, []);
  assert.deepEqual(registryNames(h), ["Mug"]);
});

test("removing a mentioned tag returns zero when the command is refused", () => {
  const h = opened();
  h.deny("read-only");
  assert.equal(removeTag("prop", "Mug", rig(h).ports), 0);
  assert.equal(rowHtml(h, "r1"), "pour from " + tag("prop", "Mug", "the mug"));
});

test("a new shot gets an id with the shot prefix, the defaults, and the given fields, and is added to the document", () => {
  const h = opened();
  const r = rig(h, 7);
  const rec = newBrollRecord({ name: "Nets drying", location: "Quay" }, r.ports);
  assert.equal(rec.id, "bs-7");
  assert.equal(rec.name, "Nets drying");
  assert.equal(rec.location, "Quay");
  assert.equal(rec.origin, "script");
  assert.deepEqual(rec.props, []);
  assert.equal(r.runs[0]?.name, "add-broll-shot");
  assert.deepEqual(shots(h).map(function (s) { return s.id + ":" + s.name; }), ["bs-7:Nets drying"]);
});

test("a new shot with no fields is built from the defaults alone", () => {
  const h = opened();
  const r = rig(h, 8);
  const rec = newBrollRecord(null, r.ports);
  assert.equal(rec.name, "");
  assert.equal(shots(h).length, 1);
});

test("removing a shot prop reports whether anything was removed", () => {
  const h = opened({ brollShots: [{ id: "bs1", name: "Nets drying", props: [{ name: "Mug" }] }] });
  const r = rig(h);
  assert.equal(shots(h)[0]?.props.length, 1);
  assert.equal(removeBrollProp("bs1", "no-such-ref", r.ports), false);
  assert.equal(shots(h)[0]?.props.length, 1);
  const ref = h.session.read(function (doc) {
    const p = doc?.brollShots[0]?.props?.[0];
    return p ? brollPropKey(p.id || "", p.name) : "";
  });
  assert.equal(removeBrollProp("bs1", ref, r.ports), true);
  assert.equal(shots(h)[0]?.props.length, 0);
  assert.equal(r.runs.at(-1)?.name, "remove-broll-prop");
});

test("removing a prop from a shot that does not exist reports false", () => {
  const h = opened();
  assert.equal(removeBrollProp("nope", "n:mug", rig(h).ports), false);
});
