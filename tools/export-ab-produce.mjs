import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeClockAndRandom, image, jsonCopy } from "../src/test/golden-helpers.mjs";
import { CAPTURED_ISO, clockProblems, pinnedDateTimeFormat } from "./export-ab-environment.mjs";

Intl.DateTimeFormat = pinnedDateTimeFormat(Intl.DateTimeFormat);
freezeClockAndRandom(1414);

const [outDir, protoDir] = process.argv.slice(2);
if (!outDir || !protoDir) throw new Error("usage: node tools/export-ab-produce.mjs <out-dir> <canonical-documents-dir>");

const { systemClock } = await import("../src/adapters/identity/ids.ts");
systemClock.nowIso = () => CAPTURED_ISO;

const { bootApp, closeApp } = await import("../src/test/_app-boot.mjs");
await bootApp();

const { STARTERS, LONG_DEMO } = await import("../src/starters/index.ts");
const { migrateRows } = await import("../src/bootstrap/document-ports.ts");
const { intern } = await import("../src/adapters/storage/02c-blobs.ts");
const { confirmSavedNow } = await import("../src/bootstrap/wiring/save-owners.ts");
const { undoOwner } = await import("../src/bootstrap/wiring/undo.ts");
const { captureExportDocument, loadExportAssets } = await import("../src/bootstrap/wiring/export-capture.ts");
const { buildMarkdownProject, buildSplitpageFile } = await import("../src/adapters/formats/project-file.ts");
const { exportFormats } = await import("../src/bootstrap/wiring/export-registry.ts");
const { registerBuiltInExporters } = await import("../src/bootstrap/wiring/exporters.ts");
const { localFileMenuControls } = await import("../src/bootstrap/wiring/local-files.ts");
const { loadTestDocument } = await import("../src/test/_document.mjs");

const tag = (cat, name, text) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${text === undefined ? name : text}</span>`;
const key = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const anchor = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;

function crafted() {
  const first = intern(image("png", 4, 3).bytes);
  const second = intern(image("jpeg", 2, 2).bytes);
  const inComment = intern(image("gif", 1, 1).bytes);
  return {
    schema: 5, title: "Every export path", docId: "d" + "6".repeat(32), rev: 7,
    targetSeconds: 30, wordsPerMinute: 150,
    people: [{ id: "p1", name: "Ana" }, { id: "p2", name: "Ben" }],
    productionTags: [
      { id: "t1", cat: "prop", name: "Lamp", owner: "p1", notes: "The brass one", status: "have" },
      { id: "t2", cat: "location", name: "Kitchen", owner: "p2", notes: "", status: "sourcing" },
      { id: "t3", cat: "cast", name: "Chef", owner: "", notes: "Line two\nand three", status: "needed" },
      { id: "t4", cat: "wardrobe", name: "Apron", owner: "", notes: "", status: "returned" }
    ],
    brollShots: [
      { id: "bs1", name: "Steam rising", desc: "", status: "shot", reshoot: true, notes: "Too dark", owner: "p1",
        audioRef: "", location: "Kitchen", props: [{ id: "t1", name: "Lamp" }], origin: "script" },
      { id: "bs9", name: "A shot with no scene", desc: "", status: "unshot", reshoot: false, notes: "", owner: "p2",
        audioRef: "", location: "", props: [], origin: "list" }
    ],
    rows: [
      {
        id: "r1", status: "shot", lengthSeconds: 7,
        visualText: `Wide on the ${tag("location", "Kitchen")} | with a pipe<br>${key("bs1")} Steam rising`,
        audioText: `The ${anchor("c1", tag("cast", "Chef"))} lights the ${tag("prop", "Lamp")}.`,
        imageRef: first, imageName: "plate.png",
        imageLinks: [{ href: "https://www.youtube.com/watch?v=abc123" }],
        moreImages: [{ imageRef: second, name: "second.jpg" }, { links: [{ name: "take-2.mov", poster: true }] }]
      },
      {
        id: "r2", status: "ready",
        visualText: `${anchor("c2", "Close")} on hands in an ${tag("wardrobe", "Apron")}`,
        audioText: "<b>Bold</b> and <i>italic</i> words, then a long line that runs on for a while to make the read time count."
      },
      { id: "r3", status: "todo", visualText: "", audioText: "" }
    ],
    comments: [
      { id: "c1", rowId: "r1", field: "audioText", author: "Ana", body: "Is the chef <b>cast</b>?", quotedText: "Chef",
        assignee: "Ben", createdAt: "2026-10-01T09:00:00.000Z",
        replies: [{ id: "c1r1", author: "Ben", body: "Yes.", createdAt: "2026-10-01T10:15:00.000Z" }] },
      { id: "c2", rowId: "r2", field: "visualText", author: "Ben", resolved: true, resolvedBy: "Ana",
        body: `See this <img class="comment-img" data-blob="${inComment.sha256}">`, quotedText: "Close",
        createdAt: "2026-10-02T09:00:00.000Z", replies: [] },
      { id: "c3", rowId: null, field: "title", author: "", body: "Title idea", createdAt: "2026-10-03T09:00:00.000Z", replies: [] },
      { id: "c4", rowId: "gone", field: "audioText", author: "Ana", body: "On a deleted scene",
        createdAt: "2026-10-04T09:00:00.000Z", replies: [] }
    ]
  };
}

const canonical = readdirSync(protoDir).filter((name) => name.endsWith(".splitpage")).sort();
const FIXTURES = [
  ...STARTERS.map((s) => ({ name: s.id, state: () => s.state })),
  { name: LONG_DEMO.id, state: () => LONG_DEMO.state },
  { name: "crafted", state: crafted },
  ...canonical.map((name) => ({ name: "canonical-" + name.replace(/\.splitpage$/, ""), state: () => JSON.parse(readFileSync(join(protoDir, name), "utf8")) }))
];

function useDocument(raw) {
  loadTestDocument(migrateRows(Object.assign({ docId: "d" + "5".repeat(32) }, jsonCopy(raw))));
  undoOwner().flush();
  confirmSavedNow();
}

function bytesOf(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("an export gave " + Object.prototype.toString.call(data) + ", not text or bytes");
}

const builtIn = [];
registerBuiltInExporters({ defineCard: () => () => {}, register: (e) => { builtIn.push(e); return () => {}; } });
const registered = [...builtIn, ...exportFormats.exporters()]
  .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
  .map((e) => ({ id: e.id, build: !!e.build, printPage: !!e.printPage }));
const outputs = [
  { id: "splitpage-save", make: async () => buildSplitpageFile(captureExportDocument()) },
  { id: "md-project", make: async () => buildMarkdownProject(captureExportDocument()) },
  ...registered.filter((e) => e.build).map((e) => ({
    id: e.id, make: async () => (await localFileMenuControls().buildFileData(e.id, "export", { allowImageBundle: true })).data
  })),
  ...registered.filter((e) => e.printPage).map((e) => ({
    id: e.id + " print page", make: async () => {
      const request = localFileMenuControls().exportRequest(e.id, {});
      const assets = await loadExportAssets(request.assets);
      return exportFormats.byId(e.id).printPage({ doc: request.doc, options: request.options, assets });
    }
  }))
];

const manifest = { registered, fixtures: [] };
for (const fixture of FIXTURES) {
  useDocument(fixture.state());
  const results = {};
  mkdirSync(join(outDir, fixture.name), { recursive: true });
  for (const [index, output] of outputs.entries()) {
    try {
      const file = join(fixture.name, String(index));
      writeFileSync(join(outDir, file), bytesOf(await output.make()));
      results[output.id] = { file };
    } catch (error) {
      results[output.id] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const clock = { capturedAt: captureExportDocument().capturedAt, now: new Date().toISOString() };
  manifest.fixtures.push({ name: fixture.name, clock, outputs: results });
}
const clockTrouble = clockProblems("producer", manifest.fixtures);
if (clockTrouble.length) throw new Error(clockTrouble.join("\n"));
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
closeApp();
