import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { retagMentions, retagRewrites } from "../../../src/application/commands/tag-rewrites.ts";
import type { DocumentView } from "../../../src/application/session/document-session.ts";
import { sharedPorts } from "../../../src/bootstrap/wiring/shared-ports.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const text = sharedPorts().text;
const mug = { cat: "prop", name: "MUG" };

function tag(cat: string, name: string, content: string): string {
  return '<span class="tag-anchor" data-tag-cat="' + cat + '" data-tag-name="' + name + '" contenteditable="false">' + content + "</span>";
}

function documentWith(rows: DocumentView["rows"]): DocumentView {
  return { ...migrateRows({}, fakeMigration().ports), rows };
}

test("rename and removal preserve exact cell output, field order and input", () => {
  const kettle = tag("prop", "Kettle", "kettle");
  const html = tag("prop", "mug", "the mug") + " and " + kettle + " <em><strong>x</strong></em>";
  const doc = documentWith([
    { id: "r1", visualText: html, audioText: tag("prop", "Mug", "a") + tag("prop", "Mug", "b") },
    { id: "r2", visualText: "<em><strong>untouched</strong></em>", audioText: null }
  ]);
  const before = structuredClone(doc);
  assert.deepEqual(retagRewrites(text, [mug], "Cup")(doc), [
    { rowId: "r1", field: "visualText", html: tag("prop", "Cup", "the mug") + " and " + kettle + " <strong><em>x</em></strong>" },
    { rowId: "r1", field: "audioText", html: tag("prop", "Cup", "ab") }
  ]);
  assert.deepEqual(retagRewrites(text, [mug], null)(doc), [
    { rowId: "r1", field: "visualText", html: "the mug and " + kettle + " <strong><em>x</em></strong>" },
    { rowId: "r1", field: "audioText", html: "ab" }
  ]);
  assert.equal(retagMentions(text, doc, [mug]), 2);
  assert.deepEqual(doc, before);
});

test("successive tags retain only the final rewrite for each cell", () => {
  const doc = documentWith([
    { id: "r1", visualText: tag("prop", "Mug", "mug") + " " + tag("prop", "Cup", "cup"), audioText: "" },
    { id: "r2", visualText: tag("prop", "Cup", "second"), audioText: "" }
  ]);
  const tags = [mug, { cat: "prop", name: "Cup" }];
  assert.deepEqual(retagRewrites(text, tags, "Bowl")(doc), [
    { rowId: "r1", field: "visualText", html: tag("prop", "Bowl", "mug") + " " + tag("prop", "Bowl", "cup") },
    { rowId: "r2", field: "visualText", html: tag("prop", "Bowl", "second") }
  ]);
  assert.deepEqual(retagRewrites(text, tags, null)(doc), [
    { rowId: "r1", field: "visualText", html: "mug cup" },
    { rowId: "r2", field: "visualText", html: "second" }
  ]);
  assert.equal(retagMentions(text, doc, tags), 3);
});

test("sound cue rename and removal keep exact cue text", () => {
  const doc = documentWith([{ id: "r1", visualText: "", audioText: '<span class="audio-cue">SFX: door slam</span>' }]);
  const tags = [{ cat: "sound", name: "door slam" }];
  assert.deepEqual(retagRewrites(text, tags, "Knock")(doc), [
    { rowId: "r1", field: "audioText", html: '<span class="audio-cue">SFX: Knock</span>' }
  ]);
  assert.deepEqual(retagRewrites(text, tags, null)(doc), [
    { rowId: "r1", field: "audioText", html: "SFX: door slam" }
  ]);
  assert.equal(retagMentions(text, doc, tags), 1);
});

test("media cells retain the exact video card when renaming or unwrapping tags", () => {
  const video = '<a class="video-embed-card" href="https://youtu.be/x" target="_blank" rel="noopener"><span class="vec-play">▶</span><span>Watch video</span><span class="vec-host">· youtu.be</span></a>';
  const doc = documentWith([{ id: "r1", visualText: tag("prop", "Mug", "mug") + " " + video, audioText: "" }]);
  assert.deepEqual(retagRewrites(text, [mug], "Cup")(doc), [
    { rowId: "r1", field: "visualText", html: tag("prop", "Cup", "mug") + " " + video }
  ]);
  assert.deepEqual(retagRewrites(text, [mug], null)(doc), [
    { rowId: "r1", field: "visualText", html: "mug " + video }
  ]);
  assert.equal(retagMentions(text, doc, [mug]), 1);
});

test("null documents, absent tags and empty selections return exact empty results", () => {
  const doc = documentWith([{ id: "r1", visualText: "plain", audioText: null }]);
  assert.equal(retagMentions(text, null, [mug]), 0);
  assert.equal(retagMentions(text, doc, [mug]), 0);
  assert.equal(retagMentions(text, doc, []), 0);
  assert.deepEqual(retagRewrites(text, [mug], "Cup")(doc), []);
  assert.deepEqual(retagRewrites(text, [], null)(doc), []);
});
