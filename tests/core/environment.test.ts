import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("../../src/core/", import.meta.url));

const globalsBefore = new Set(Reflect.ownKeys(globalThis));

const modules: Record<string, Record<string, unknown>> = {
  "document/broll.ts": await import("../../src/core/document/broll.ts"),
  "document/comments.ts": await import("../../src/core/document/comments.ts"),
  "document/fields.ts": await import("../../src/core/document/fields.ts"),
  "document/gallery.ts": await import("../../src/core/document/gallery.ts"),
  "document/ids.ts": await import("../../src/core/document/ids.ts"),
  "document/media.ts": await import("../../src/core/document/media.ts"),
  "document/memo.ts": await import("../../src/core/document/memo.ts"),
  "document/person-colors.ts": await import("../../src/core/document/person-colors.ts"),
  "document/ports.ts": await import("../../src/core/document/ports.ts"),
  "document/tags.ts": await import("../../src/core/document/tags.ts"),
  "document/text-policy.ts": await import("../../src/core/document/text-policy.ts"),
  "document/timing.ts": await import("../../src/core/document/timing.ts"),
  "merge-states.ts": await import("../../src/core/merge-states.ts"),
  "merge/cells.ts": await import("../../src/core/merge/cells.ts"),
  "merge/lists.ts": await import("../../src/core/merge/lists.ts"),
  "merge/rows.ts": await import("../../src/core/merge/rows.ts"),
  "merge/scalars.ts": await import("../../src/core/merge/scalars.ts"),
  "merge/shape.ts": await import("../../src/core/merge/shape.ts"),
  "merge/states.ts": await import("../../src/core/merge/states.ts"),
  "merge/text-field.ts": await import("../../src/core/merge/text-field.ts"),
  "migrate.ts": await import("../../src/core/migrate.ts"),
  "production/broll.ts": await import("../../src/core/production/broll.ts"),
  "production/ports.ts": await import("../../src/core/production/ports.ts"),
  "production/readers.ts": await import("../../src/core/production/readers.ts"),
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
  "text/steps.ts": await import("../../src/core/text/steps.ts"),
  "text/tree.ts": await import("../../src/core/text/tree.ts")
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
  const { parseSceneLength } = await import("../../src/core/document/timing.ts");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(plainText("<b>x</b>"), "x");
  assert.equal(safeHref("javascript:x"), null);
  assert.deepEqual(normalizeBrollProps(["Mug"], []), [{ id: "", name: "Mug" }]);
  assert.equal(decodeImageDataUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw=")?.ref.mime, "image/gif");
  assert.deepEqual(normalizeVideoLinks([{ href: "https://example.com/v" }]), [{ href: "https://example.com/v" }]);
  assert.equal(parseSceneLength("1:30"), 90);
});
