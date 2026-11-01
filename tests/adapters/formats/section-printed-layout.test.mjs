import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, freemem } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { scriptFixture } from "./fixtures/script-print-fixture.mjs";
import { inspectPrintedFixtures } from "./fixtures/inspect-script-print.mjs";
import { migratedThenSet } from "../../core/migrate-ports.ts";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import { buildScriptPrintPage } from "../../../src/adapters/formats/script-print.ts";

test("section headings repeat across printed pages while all scenes retain their order", { timeout: 120000 }, async () => {
  assert.ok(freemem() >= 4 * 1024 ** 3, "Printed PDF checks require at least 4 GB free RAM");
  const fixture = scriptFixture("long");
  const source = migratedThenSet({ ...fixture.source, sections: [
    { id: "s1", name: "Opening section", firstSceneId: "r1" },
    { id: "s2", name: "Ending section " + "long ".repeat(35), firstSceneId: "r10" }
  ] });
  const doc = buildExportDocument(source, "2026-10-31T12:00:00Z",
    { production: [], commentNumbers: { c1: 1 }, broll: [] }, { clockMode: "24" });
  const path = fileURLToPath(new URL("./fixtures/_script-print-sections-long.html", import.meta.url));
  writeFileSync(path, buildScriptPrintPage({ ...fixture.input, doc }));
  const out = mkdtempSync(join(tmpdir(), "splitpage-section-print-"));
  const result = await inspectPrintedFixtures({ out, lists: false, cases: ["sections-long"] });
  assert.equal(result.fixtures, 1);
  const report = JSON.parse(readFileSync(join(out, "sections-long-pages.json"), "utf8"));
  const pages = report.pages.map(page => page.lines.map(line => line.text).join(""));
  assert.ok(pages.filter(text => text.includes("Opening section")).length >= 2);
  assert.equal(pages.findIndex(text => text.includes("Opening section")), pages.findIndex(text => text.includes("Captured words")));
  assert.equal(pages.findIndex(text => text.includes("Ending section")), pages.findIndex(text => text.includes("Scene 10 audio")));
  rmSync(out, { recursive: true, force: true });
});
