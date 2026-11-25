import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fileService from "../desktop/file-service.ts";
import { bootApp, closeApp } from "../src/test/_app-boot.mjs";

const count = 25;
const beats = 900;
const sha256 = data => createHash("sha256").update(data).digest("hex");
const directory = await mkdtemp(join(tmpdir(), "splitpage-copy-cost-"));
const file = join(directory, "cost.splitpage");

function summary(samples) {
  const ordered = samples.toSorted((a, b) => a - b);
  const select = rank => Number(ordered[rank - 1].toFixed(1));
  return { median: select(13), p95: select(24), max: select(25) };
}

try {
  await bootApp();
  const { loadTestDocument } = await import("../src/test/_document.mjs");
  const { migrateRows } = await import("../src/bootstrap/document-ports.ts");
  const { captureExportDocument } = await import("../src/bootstrap/wiring/export-capture.ts");
  const { buildSplitpageFile } = await import("../src/adapters/formats/project-file.ts");
  const demo = JSON.parse(await readFile(new URL("../src/starters/long-demo.json", import.meta.url), "utf8"));
  const rows = Array.from({ length: beats }, (_, i) => ({ ...demo.rows[i % demo.rows.length], id: "beat-" + i }));
  const doc = migrateRows({ ...demo, title: "File copy benchmark", rows });
  loadTestDocument(doc);
  await writeFile(file, "starting file");
  let expected = sha256("starting file"), bytes = 0;
  const captureAndFormat = [], desktopWrite = [], total = [];
  for (let i = 0; i < count + 3; i++) {
    const start = performance.now();
    const capture = captureExportDocument({ docId: doc.docId, stamp: { rev: i, lastEditedBy: "Editor", lastEditedAt: "" } });
    const body = Buffer.from(buildSplitpageFile(capture));
    const formatted = performance.now();
    if (sha256(await readFile(file)) !== expected) throw new Error("File copy changed before staging");
    await fileService.writeFileEntry(file, body, undefined, async () => {
      if (sha256(await readFile(file)) !== expected) throw new Error("File copy changed before rename");
    });
    expected = sha256(body);
    if (sha256(await readFile(file)) !== expected) throw new Error("File copy readback differs");
    const checked = performance.now();
    if (i >= 3) {
      captureAndFormat.push(formatted - start);
      desktopWrite.push(checked - formatted);
      total.push(checked - start);
    }
    bytes = body.length;
  }
  console.log(JSON.stringify({
    beats, bytes, samples: count,
    milliseconds: { captureAndFormat: summary(captureAndFormat), desktopWrite: summary(desktopWrite), total: summary(total) }
  }, null, 2));
} finally {
  closeApp();
  await rm(directory, { force: true, recursive: true });
}
