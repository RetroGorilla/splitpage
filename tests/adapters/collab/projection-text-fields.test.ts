import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fieldMappingSource } from "./mapping-source.ts";
import { withFullProjectedFixture } from "./projection-roundtrip-support.ts";

const probes: readonly [string, Readonly<Record<string, unknown>>][] = [
  ["`title`", { title: "Document title sentinel" }],
  ["`sections`", { "sections.length": 1, "sections.0.id": "Hprobe", "sections.0.name": "Heading sentinel", "sections.0.firstSceneId": "Rprobe" }],
  ["`rows[].audioText` (narration)", { "rows.0.audioText#contains": "plain<br>tail" }],
  ["`rows[].visualText` (visual)", { "rows.0.visualText#contains": "plain<br>tail" }],
  ["`sections[].name`", { "sections.0.name": "Heading sentinel" }],
  ["Characters and line breaks", { "rows.0.audioText#contains": "plain<br>tail", "comments.0.body": "Comment body sentinel", "comments.0.replies.0.body": "Reply body sentinel" }],
  ["Bold, italic, underline, strike, highlight", { "rows.0.audioText#contains": "<mark><strong><em><u><s>format sentinel</s></u></em></strong></mark>" }],
  ["Link", { "rows.0.audioText#contains": '<a href="https://example.test/text-link" target="_blank" rel="noopener">link sentinel</a>' }],
  ["Comment mark", { "rows.0.audioText#contains": '<span class="cmt-anchor" data-cmt="Canchor">comment sentinel</span>' }],
  ["Tag", { "rows.0.audioText#contains": '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Prop sentinel" contenteditable="false">tag sentinel</span>' }],
  ["Stage direction", { "rows.0.audioText#contains": '<span class="stage-dir">direction sentinel</span>' }],
  ["Audio cue", { "rows.0.audioText#contains": '<span class="audio-cue">SFX: cue sentinel</span>' }],
  ["B-roll key", { "rows.0.visualText#contains": '<span class="broll-key" data-broll-id="Sprobe" contenteditable="false">B-roll:</span>' }],
  ["`@Name`", { "rows.0.visualText#contains": '<span class="who-anchor" data-who="Person sentinel" contenteditable="false">@Person sentinel</span>' }]
];
test("projection literal probes complete the remaining 14 of 96 field rows", () => {
  const inventory = readFileSync(new URL("../../../docs/collaboration/stage-0/2-fields.md", import.meta.url), "utf8").split("## Marks with identity")[0]; assert.ok(inventory);
  const names = probes.map(([name]) => name);
  assert.equal(probes.length, 14); assert.equal(new Set(names).size, 14);
  assert.deepEqual(inventory.split(/\r?\n/).filter(line => line.startsWith("| ")).map(line => line.split("|")[1]?.trim()).filter(name => names.includes(String(name))), names);
  const source = fieldMappingSource();
  for (const row of source.rows) for (const field of ["audioText", "visualText"] as const) row[field] = row[field]?.replace('|<span class="audio-cue">cue sentinel</span>|', '<br><span class="audio-cue">SFX: cue sentinel</span><br>');
  withFullProjectedFixture(source, projected => {
    for (const [field, paths] of probes) for (const [probe, expected] of Object.entries(paths)) {
      const [path, mode] = probe.split("#"); assert.ok(path); let value: unknown = projected;
      for (const key of path.split(".")) { assert.ok(value !== null && typeof value === "object" && Object.hasOwn(value, key), field); value = (value as Record<string, unknown>)[key]; }
      if (mode === "contains") assert.ok(typeof value === "string" && value.includes(String(expected)), field);
      else assert.deepEqual(value, expected, field);
    }
  });
});
