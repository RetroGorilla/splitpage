import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("../../src/core/", import.meta.url));

const globalsBefore = new Set(Reflect.ownKeys(globalThis));

const modules: Record<string, Record<string, unknown>> = {
  "collab/base-reference.ts": await import("../../src/core/collab/base-reference.ts"),
  "collab/buffer.ts": await import("../../src/core/collab/buffer.ts"),
  "collab/buffer-operations.ts": await import("../../src/core/collab/buffer-operations.ts"),
  "collab/operations.ts": await import("../../src/core/collab/operations.ts"),
  "collab/removal-state.ts": await import("../../src/core/collab/removal-state.ts"),
  "collab/text-records.ts": await import("../../src/core/collab/text-records.ts"),
  "collab/projection/canonical.ts": await import("../../src/core/collab/projection/canonical.ts"),
  "collab/projection/changes.ts": await import("../../src/core/collab/projection/changes.ts"),
  "collab/projection/blocks.ts": await import("../../src/core/collab/projection/blocks.ts"),
  "collab/projection/fields.ts": await import("../../src/core/collab/projection/fields.ts"),
  "collab/projection/join-glue.ts": await import("../../src/core/collab/projection/join-glue.ts"),
  "collab/projection/join-layout.ts": await import("../../src/core/collab/projection/join-layout.ts"),
  "collab/projection/joins.ts": await import("../../src/core/collab/projection/joins.ts"),
  "collab/projection/gallery.ts": await import("../../src/core/collab/projection/gallery.ts"),
  "collab/projection/broll.ts": await import("../../src/core/collab/projection/broll.ts"),
  "collab/projection/tag-extents.ts": await import("../../src/core/collab/projection/tag-extents.ts"),
  "collab/projection/text.ts": await import("../../src/core/collab/projection/text.ts"),
  "collab/projection/units.ts": await import("../../src/core/collab/projection/units.ts"),
  "collab/read-operation.ts": await import("../../src/core/collab/read-operation.ts"),
  "collab/recovery.ts": await import("../../src/core/collab/recovery.ts"),
  "collab/refusals.ts": await import("../../src/core/collab/refusals.ts"),
  "collab/structure-key.ts": await import("../../src/core/collab/structure-key.ts"),
  "collab/undo-record.ts": await import("../../src/core/collab/undo-record.ts"),
  "document/broll.ts": await import("../../src/core/document/broll.ts"),
  "document/clone.ts": await import("../../src/core/document/clone.ts"),
  "document/comments.ts": await import("../../src/core/document/comments.ts"),
  "document/export-document.ts": await import("../../src/core/document/export-document.ts"),
  "document/fields.ts": await import("../../src/core/document/fields.ts"),
  "document/file-title.ts": await import("../../src/core/document/file-title.ts"),
  "document/freeze.ts": await import("../../src/core/document/freeze.ts"),
  "document/gallery.ts": await import("../../src/core/document/gallery.ts"),
  "document/id-map.ts": await import("../../src/core/document/id-map.ts"),
  "document/ids.ts": await import("../../src/core/document/ids.ts"),
  "document/load-ids.ts": await import("../../src/core/document/load-ids.ts"),
  "document/media.ts": await import("../../src/core/document/media.ts"),
  "document/memo.ts": await import("../../src/core/document/memo.ts"),
  "document/numbering.ts": await import("../../src/core/document/numbering.ts"),
  "document/people.ts": await import("../../src/core/document/people.ts"),
  "document/person-colors.ts": await import("../../src/core/document/person-colors.ts"),
  "document/ports.ts": await import("../../src/core/document/ports.ts"),
  "document/rows.ts": await import("../../src/core/document/rows.ts"),
  "document/scene-items.ts": await import("../../src/core/document/scene-items.ts"),
  "document/scenes.ts": await import("../../src/core/document/scenes.ts"),
  "document/tags.ts": await import("../../src/core/document/tags.ts"),
  "document/text-policy.ts": await import("../../src/core/document/text-policy.ts"),
  "document/timing.ts": await import("../../src/core/document/timing.ts"),
  "document/validated.ts": await import("../../src/core/document/validated.ts"),
  "flow/find-replace.ts": await import("../../src/core/flow/find-replace.ts"),
  "flow/flow.ts": await import("../../src/core/flow/flow.ts"),
  "flow/operations.ts": await import("../../src/core/flow/operations.ts"),
  "flow/remove-empty-heading.ts": await import("../../src/core/flow/remove-empty-heading.ts"),
  "flow/visual.ts": await import("../../src/core/flow/visual.ts"),
  "merge-states.ts": await import("../../src/core/merge-states.ts"),
  "merge/cells.ts": await import("../../src/core/merge/cells.ts"),
  "merge/lists.ts": await import("../../src/core/merge/lists.ts"),
  "merge/review.ts": await import("../../src/core/merge/review.ts"),
  "merge/rows.ts": await import("../../src/core/merge/rows.ts"),
  "merge/scalars.ts": await import("../../src/core/merge/scalars.ts"),
  "merge/scenes.ts": await import("../../src/core/merge/scenes.ts"),
  "merge/shape.ts": await import("../../src/core/merge/shape.ts"),
  "merge/state-fields.ts": await import("../../src/core/merge/state-fields.ts"),
  "merge/states.ts": await import("../../src/core/merge/states.ts"),
  "merge/text-field.ts": await import("../../src/core/merge/text-field.ts"),
  "migrate.ts": await import("../../src/core/migrate.ts"),
  "production/broll-view.ts": await import("../../src/core/production/broll-view.ts"),
  "production/broll.ts": await import("../../src/core/production/broll.ts"),
  "production/index.ts": await import("../../src/core/production/index.ts"),
  "production/looks.ts": await import("../../src/core/production/looks.ts"),
  "production/owners.ts": await import("../../src/core/production/owners.ts"),
  "production/ports.ts": await import("../../src/core/production/ports.ts"),
  "production/readers.ts": await import("../../src/core/production/readers.ts"),
  "production/records.ts": await import("../../src/core/production/records.ts"),
  "production/tags.ts": await import("../../src/core/production/tags.ts"),
  "production/timing.ts": await import("../../src/core/production/timing.ts"),
  "text/anchors.ts": await import("../../src/core/text/anchors.ts"),
  "text/cues.ts": await import("../../src/core/text/cues.ts"),
  "text/directions.ts": await import("../../src/core/text/directions.ts"),
  "text/edits.ts": await import("../../src/core/text/edits.ts"),
  "text/html.ts": await import("../../src/core/text/html.ts"),
  "text/ports.ts": await import("../../src/core/text/ports.ts"),
  "text/projections.ts": await import("../../src/core/text/projections.ts"),
  "text/runs.ts": await import("../../src/core/text/runs.ts"),
  "text/search.ts": await import("../../src/core/text/search.ts"),
  "text/sentences.ts": await import("../../src/core/text/sentences.ts"),
  "text/selection.ts": await import("../../src/core/text/selection.ts"),
  "text/steps.ts": await import("../../src/core/text/steps.ts"),
  "text/tree.ts": await import("../../src/core/text/tree.ts"),
  "text/who.ts": await import("../../src/core/text/who.ts")
};

const globalsAfter = new Set(Reflect.ownKeys(globalThis));

function coreScripts(): string[] {
  return readdirSync(CORE, { recursive: true, encoding: "utf8" })
    .map((f) => f.split("\\").join("/"))
    .filter((f) => /\.[cm]?[jt]s$/.test(f) && !/\.test\.[cm]?[jt]s$/.test(f) && !/\.d\.[cm]?ts$/.test(f))
    .sort();
}

test("every script under src/core, whatever its extension, is loaded here", () => {
  assert.deepEqual(Object.keys(modules).sort(), coreScripts());
});

test("loading core adds no globals", () => {
  assert.deepEqual([...globalsAfter].filter((k) => !globalsBefore.has(k)), []);
});

test("core's policies run in this process", async () => {
  const { sha256Hex } = await import("../../src/core/document/ids.ts");
  const { plainText, safeHref } = await import("../../src/core/document/text-policy.ts");
  const { normalizeBrollProps } = await import("../../src/core/document/broll.ts");
  const { decodeImageDataUrl } = await import("../../src/core/document/media.ts");
  const { normalizeVideoLinks } = await import("../../src/core/document/gallery.ts");
  const { parseBeatLength } = await import("../../src/core/document/timing.ts");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(plainText("<b>x</b>"), "x");
  assert.equal(safeHref("javascript:x"), null);
  assert.deepEqual(normalizeBrollProps(["Mug"], []), [{ id: "", name: "Mug" }]);
  assert.equal(decodeImageDataUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw=")?.ref.mime, "image/gif");
  assert.deepEqual(normalizeVideoLinks([{ href: "https://example.com/v" }]), [{ href: "https://example.com/v" }]);
  assert.equal(parseBeatLength("1:30"), 90);
});
