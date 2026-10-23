import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import { createHash } from "node:crypto";
import { mockClock } from "./_m4-matrix.mjs";
import { assertGolden, image, jsonCopy } from "./golden-helpers.mjs";

const RealDateTimeFormat = Intl.DateTimeFormat;
function PinnedDateTimeFormat(locale, opts) {
  return new RealDateTimeFormat("en-US", Object.assign({}, opts, { timeZone: "UTC" }));
}
PinnedDateTimeFormat.supportedLocalesOf = RealDateTimeFormat.supportedLocalesOf;
Intl.DateTimeFormat = PinnedDateTimeFormat;

await bootApp();
after(closeApp);

const { STARTERS, LONG_DEMO } = await import("../js/_starters.js");
const { migrateRows } = await import("../js/02-state.js");
const { standaloneHtmlFor } = await import("../js/02b-doc-id.js");
const { intern } = await import("../adapters/storage/02c-blobs.js");
const { confirmSavedNow } = await import("../legacy/save-bridge.ts");
const { flushEdits } = await import("../js/12a-undo.js");
const { exportMetaLine, markdownExportImages, toMarkdownDoc, toMarkdownTableDoc } = await import("../adapters/formats/export-text.ts");
const { captureExportDocument } = await import("../js/14b-export-kit.js");
const { exportAssetsNow } = await import("../adapters/formats/export-assets.ts");
const { exportFacts } = await import("../adapters/formats/export-kit.ts");
const { buildMarkdownProject, buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { loadTestDocument } = await import("./_document.mjs");

const EM_DASH = String.fromCharCode(0x2014);
const CAPTURED_AT = Date.UTC(2026, 9, 13, 17, 30);

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

const FIXTURES = [
  ...STARTERS.map((s) => ({ name: s.id, state: () => s.state })),
  { name: LONG_DEMO.id, state: () => LONG_DEMO.state },
  { name: "crafted", state: crafted }
];

function useDocument(raw) {
  loadTestDocument(migrateRows(Object.assign({ docId: "d" + "5".repeat(32) }, jsonCopy(raw))));
  flushEdits();
  confirmSavedNow();
}

const sha = (text) => createHash("sha256").update(text).digest("hex");
const digest = (text) => ({ bytes: Buffer.byteLength(text), sha256: sha(text) });

function htmlParts(html) {
  const data = /<script id="state-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  const description = /<meta name="description" content="([^"]*)"/.exec(html);
  return {
    stateData: digest(data ? data[1] : ""),
    title: title ? title[1] : null,
    description: description ? description[1] : null
  };
}

function outputs() {
  const doc = captureExportDocument();
  const head = { title: (doc.title || "Untitled Script") + " " + EM_DASH + " SplitShare", description: exportMetaLine(exportFacts(doc)) };
  return {
    splitpage: digest(buildSplitpageFile(doc)),
    markdownProject: digest(buildMarkdownProject(doc)),
    standaloneHtml: htmlParts(standaloneHtmlFor(doc, head)),
    markdownExport: digest(toMarkdownDoc(doc)),
    markdownExportPreview: digest(toMarkdownDoc(doc, { scenes: 3 })),
    markdownTableExport: digest(toMarkdownTableDoc(doc, { export: true })),
    markdownImages: markdownExportImages(doc, exportAssetsNow(doc)).map((img) => ({ path: img.path, bytes: img.bytes.length })),
    facts: exportFacts(doc)
  };
}

for (const fixture of FIXTURES) {
  test("the export bytes of " + fixture.name + " match their record", (t) => {
    mockClock(t, CAPTURED_AT);
    useDocument(fixture.state());
    assertGolden("exports-" + fixture.name, jsonCopy(outputs()));
  });
}
