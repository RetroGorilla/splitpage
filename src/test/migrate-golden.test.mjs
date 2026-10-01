import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migrateRows } from "../js/02-state.js";
import { deriveDocId, migrateDocument } from "../js/02b-doc-id.js";
import { has, recordFor, setBackend } from "../js/02c-blobs.js";
import { refsIn } from "../../shared/blob-policy.js";
import { createIdMasker, goldenText, image, settleGolden } from "./golden-helpers.mjs";

const SEED_TEXT = readFileSync(new URL("../seed-state.json", import.meta.url), "utf8");

const S1 = {
  row: image("png", 61, 7),
  annotation: image("jpeg", 62, 7),
  more: image("gif", 63, 7),
  moreAnnotation: image("webp", 64, 7),
  body: image("png", 65, 7),
  reply: image("jpeg", 66, 7),
  conflict: image("png", 67, 7),
  row2: image("jpeg", 68, 7)
};
const S2 = {
  cell: image("png", 71, 9),
  comment: image("gif", 72, 9),
  reply: image("webp", 73, 9)
};
const S5 = { row: image("png", 81, 3) };
const ALL_IMAGES = [...Object.values(S1), ...Object.values(S2), ...Object.values(S5)];

const UNKNOWN_REF = { sha256: "b2".repeat(32), width: 3, height: 4, mime: "image/png" };
const UNKNOWN_CELL = "b4".repeat(32);
const MARKS = [
  { kind: "pen", color: "#E5383B", width: 0.01, points: [0.1, 0.2, 0.3, 0.45678] },
  { kind: "highlight", color: "#123456", width: 0.05, points: [0, 0, 1, 1] },
  { kind: "text", color: "#ffffff", size: 0.05, x: 0.5, y: 2, text: "Hi\r\nthere\u0001!" },
  { kind: "pen", color: "#111111", width: 0.5, points: [0.5, 0.5, 0.25] },
  { kind: "circle", color: "#111111" }
];

function schemaOneDocument() {
  return {
    schema: 1,
    title: "<b>Legacy</b> script",
    rows: [
      {
        id: "r1",
        status: "shot",
        lengthSeconds: 12.4,
        visualText: "**Wide** shot of *the* ~~old~~ house\nwith <u>care</u> & <b>raw</b> tags",
        audioText: "Say [hello](https://example.com/?a=1&b=2) and [bad](javascript:alert(1)) <mark>now</mark><br>B-roll: drone",
        visualImage: S1.row.dataUrl,
        imageName: "  house\u0001.png ",
        imageLinks: [
          { href: "https://youtu.be/x", poster: true, duration: 12.345 },
          { href: "javascript:x" },
          { name: "clip.mp4", size: 10.7 },
          { href: "https://youtu.be/x" },
          { href: "https://youtu.be/y", poster: true }
        ],
        imageAnnotation: { visualImage: S1.annotation.dataUrl, marks: MARKS },
        moreImages: [
          { visualImage: S1.more.dataUrl, name: "gif one", annotation: { visualImage: S1.moreAnnotation.dataUrl, marks: MARKS.slice(2, 3) },
            links: [{ name: "clip.mp4", size: 1234.5, duration: 3.14159 }] },
          { visualImage: S1.row.dataUrl, name: "duplicate of the first" },
          { imageRef: Object.assign({ extra: true }, UNKNOWN_REF), name: "kept by reference", annotation: { imageRef: UNKNOWN_REF, marks: MARKS } },
          { links: [{ href: "https://youtu.be/p", poster: true }], name: "a video slot" },
          "junk",
          { visualImage: "data:image/png;base64,AAAA" }
        ]
      },
      {
        status: "nonsense",
        lengthSeconds: -1,
        visualText: "no id row\nsecond line",
        audioText: "plain *em* **b**",
        updatedBy: "<i>Ann</i>",
        updatedAt: "2026-01-02T03:04:05.000Z",
        visualImage: "data:image/jpg;base64," + S1.row2.base64.replace(/(.{10})/g, "$1\n")
      },
      null,
      {
        id: "r4",
        visualImage: "https://evil.test/x.png",
        imageRef: "junk",
        lengthSeconds: 30.6,
        audioText: "~~cut~~ <mark>hi</mark> [link](https://e.x/) *a* **b** <em>c</em>"
      }
    ],
    comments: [
      {
        id: "c1", rowId: "r1", field: "visualText", author: "<b>Sam</b>",
        body: 'look <img src="' + S1.body.dataUrl + '">', quotedText: "<i>Wide</i>", createdAt: "2026-01-01T00:00:00.000Z",
        replies: [
          { id: "rp1", body: 'and <img src="' + S1.reply.dataUrl + '">', author: "" },
          { body: "no id reply", author: "Kim" },
          null,
          7
        ]
      },
      {
        rowId: "r1", field: "visualImage", kind: "conflict", conflictField: "Visual image", createdAt: "2026-01-03T00:00:00.000Z",
        body: '<img class="comment-img" src="' + S1.conflict.dataUrl + '">'
      },
      { id: "c3", field: "title", kind: "conflict", body: "Old <b>title</b>", rowId: "r1", anchorId: "x" },
      {
        id: "c4", rowId: "r 1", field: "whatever", resolved: true, resolvedBy: "<b>Kim</b>", resolvedAt: "2026-02-02T00:00:00.000Z",
        assignee: "  Lee  ", imageValue: S1.row.record
      },
      { id: "c5", rowId: "r1", resolved: "yes", resolvedBy: "Ann", resolvedAt: "2026-02-03", kind: "other" }
    ],
    people: [{ id: "p1", name: " <b>Sam</b> " }, { name: "No Id" }, { id: "p3", name: "   " }, null],
    wordsPerMinute: "175"
  };
}

function cellsDocument() {
  return {
    schema: 2,
    docId: "d" + "0123456789abcdef".repeat(2),
    title: "Cells " + "x".repeat(10) + "<script>y</script>",
    rows: [
      {
        id: "r1",
        updatedAt: "2026-05-01T10:00:00.000Z",
        updatedBy: "Sam",
        visualText: 'wide <img src="' + S2.cell.dataUrl + '"> shot <img data-blob="' + UNKNOWN_CELL + '" data-w="4" data-h="3" data-mime="image/png"> end',
        audioText: 'watch <a class="video-embed-card" href="https://www.youtube.com/watch?v=abc"><span>x</span></a> this ' +
          '<a class="video-embed-card" href="javascript:alert(1)">bad</a> and <a class="video-embed-card" href="https://vimeo.com/1">v</a>'
      },
      {
        id: "r2",
        status: "shot",
        lengthSeconds: 45,
        visualText: '<img class="comment-img" data-blob="' + S2.cell.sha256 + '" data-w="1" data-h="1" data-mime="image/gif"> known',
        audioText: '<span class="cmt-anchor">anchor without id</span> and <span class="broll-key">B-roll:</span> city ' +
          '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="gaffer tape">gaffer tape</span> ' +
          '<span class="audio-cue">SFX: <span class="tag-anchor" data-tag-cat="sound" data-tag-name="Thunder">Thunder</span></span>',
        imageRef: { sha256: "b3".repeat(32), width: 10, height: 20, mime: "image/jpeg", extra: 1 },
        imageName: "pic\u0001name.jpg",
        imageAnnotation: { imageRef: { sha256: "b3".repeat(32), width: 10, height: 20, mime: "image/jpeg" }, marks: MARKS }
      },
      {
        id: '" ] , #rows *',
        visualText: "",
        audioText: '<span class="cmt-anchor" data-cmt="c9">anchored</span>'
      }
    ],
    comments: [
      {
        id: "c9", rowId: "r1", field: "audioText", author: "Sam", createdAt: "2026-05-01T09:00:00.000Z",
        body: 'a note <img src="' + S2.comment.dataUrl + '">', replies: "not an array"
      },
      "junk",
      {
        id: "c10", rowId: "r2", field: "visualText", author: "Ann", body: "<p>para</p><div>block</div>",
        replies: [{ id: "rp9", author: "  ", body: '<img src="' + S2.reply.dataUrl + '"><a href="javascript:x">j</a>' }]
      }
    ],
    productionTags: [
      { cat: "prop", name: "Kettle", owner: "p1", status: "have", notes: "<b>n</b>" },
      { cat: "nonsense", name: "X", status: "??", owner: "p9" },
      { cat: "prop", name: "  " },
      { cat: "prop", name: "Gaffer Tape" },
      null
    ],
    people: [{ id: "p1", name: "Sam" }],
    brollShots: [
      { id: "b1", name: "Rooftop", status: "??", reshoot: "yes", origin: "list", owner: "p9", location: " roof ", desc: "d", notes: "n", audioRef: "a",
        props: [{ name: "kettle" }, "Rope", null, { id: "t_zzzz", name: "Tarp" }] },
      { name: "Alley", owner: "p1", reshoot: true },
      { id: "b3", name: "" }
    ],
    personColors: { Sam: "#80bdfb", constructor: "#F9B64F", Bad: "#000", " Ann ": "#cba1fa" },
    targetSeconds: 300.4,
    wordsPerMinute: 1000,
    rev: "7",
    lastEditedBy: "Sam",
    lastEditedAt: "2026-05-02T00:00:00.000Z",
    unknownField: { kept: true }
  };
}

function oddShapes() {
  return {
    title: 42, schema: "2", rows: "x", comments: {}, people: 5, productionTags: "y", brollShots: null,
    wordsPerMinute: null, rev: "3", personColors: [], targetSeconds: 0, docId: "../../x"
  };
}

function legacyFileWithPicture() {
  return { title: "Legacy", rows: [{ id: "r1", audioText: "one", visualImage: S5.row.dataUrl }] };
}

const SCENARIOS = [
  { name: "schema 1 document", images: Object.values(S1), mintedDocId: true, migrate: () => migrateRows(schemaOneDocument()) },
  { name: "media in cells", images: Object.values(S2), mintedDocId: false, migrate: () => migrateRows(cellsDocument()) },
  { name: "seed", images: [], mintedDocId: true, migrate: () => migrateRows(JSON.parse(SEED_TEXT)) },
  { name: "odd shapes", images: [], mintedDocId: true, migrate: () => migrateRows(oddShapes()) },
  { name: "null document", images: [], mintedDocId: true, migrate: () => migrateRows(null) },
  { name: "legacy file with a picture", images: Object.values(S5), mintedDocId: false,
    migrate: () => migrateDocument(legacyFileWithPicture(), { kind: "file" }) }
];

function recorder() {
  const log = { puts: [], missing: [] };
  return {
    name: "recorder",
    persistent: true,
    log,
    get: () => Promise.resolve(null),
    put: (sha) => { log.puts.push(sha); return Promise.resolve(); },
    missing: (shas) => { log.missing.push(shas.slice()); return Promise.resolve(shas.slice()); }
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((resolve) => setTimeout(resolve, 0)));

function maskState(s, masker, mintedDocId) {
  const out = JSON.parse(JSON.stringify(s));
  if (mintedDocId) {
    assert.match(out.docId, /^d[0-9a-f]{32}$/, "a minted docId is d and 32 hex digits");
    out.docId = "{minted:docId}";
  }
  for (const r of out.rows) {
    r.id = masker.id(r.id, "r");
    r.visualText = masker.html(r.visualText);
    r.audioText = masker.html(r.audioText);
  }
  for (const c of out.comments) {
    c.id = masker.id(c.id, "c");
    c.rowId = masker.id(c.rowId, "r");
    c.anchorId = masker.id(c.anchorId, "c");
    c.body = masker.html(c.body);
    for (const rep of c.replies) {
      rep.id = masker.id(rep.id, "rp");
      rep.body = masker.html(rep.body);
    }
  }
  for (const p of out.people) p.id = masker.id(p.id, "p");
  for (const t of out.productionTags) t.owner = masker.id(t.owner, "p");
  for (const b of out.brollShots) {
    b.id = masker.id(b.id, "bs");
    b.owner = masker.id(b.owner, "p");
  }
  return out;
}

const fresh = ALL_IMAGES.filter((img) => has(img.sha256)).map((img) => img.sha256);

async function runScenario(sc) {
  const backend = recorder();
  setBackend(backend);
  const before = sc.images.filter((img) => has(img.sha256)).map((img) => img.sha256);
  const started = Date.now();
  const masker = createIdMasker(() => started, () => Date.now());
  const out = sc.migrate();
  await settle();
  const persisted = backend.log.puts.slice();
  const missing = backend.log.missing.slice();
  const shas = [...new Set([...sc.images.map((img) => img.sha256), ...refsIn(out)])];
  const registry = Object.fromEntries(shas.map((sha) => [sha, recordFor(sha)]));
  const golden = { output: maskState(out, masker, sc.mintedDocId), registry, persisted };
  const once = JSON.stringify(out);
  const again = migrateRows(JSON.parse(once));
  await settle();
  return {
    golden,
    before,
    missing,
    minted: masker.minted,
    once,
    again: JSON.stringify(again),
    putsAfterAgain: backend.log.puts.slice(persisted.length)
  };
}

const results = [];
for (const sc of SCENARIOS) results.push([sc.name, await runScenario(sc)]);

const seedRaw = () => JSON.parse(SEED_TEXT);
const docIds = {
  "seed, opened as a file": migrateDocument(seedRaw(), { kind: "file" }).docId,
  "seed, opened from the server": migrateDocument(seedRaw(), { kind: "server", serverId: "srv-1" }).docId,
  "legacy file with a picture, opened as a file": migrateDocument(legacyFileWithPicture(), { kind: "file" }).docId
};

const actual = {
  scenarios: Object.fromEntries(results.map(([name, r]) => [name, r.golden])),
  docIds
};
const expected = settleGolden("migrate", "migrate-golden.json", actual);

test("the registry starts empty: this file runs in a process of its own", () => {
  assert.deepEqual(fresh, []);
  for (const [name, r] of results) assert.deepEqual(r.before, [], name + ": none of its pictures was interned before it ran");
});

test("the fixture holds exactly the scenarios, in order", () => {
  assert.deepEqual(Object.keys(expected.value.scenarios), SCENARIOS.map((sc) => sc.name));
});

for (const [name, r] of results) {
  test("golden: " + name + ": the migrated JSON, its key order included", () => {
    assert.equal(goldenText(r.golden.output), goldenText(expected.value.scenarios[name].output));
  });
  test("golden: " + name + ": the registry's records and the shas queued for persistence", () => {
    assert.equal(goldenText(r.golden.registry), goldenText(expected.value.scenarios[name].registry));
    assert.equal(goldenText(r.golden.persisted), goldenText(expected.value.scenarios[name].persisted));
    assert.deepEqual(r.missing, [], "every queued sha had bytes to store");
  });
  test("golden: " + name + ": migrating the result again changes no byte and queues nothing", () => {
    assert.equal(r.again, r.once);
    assert.deepEqual(r.putsAfterAgain, []);
  });
}

test("every minted id has its prefix, seven random base-36 digits at most, and a time stamp from this run", () => {
  for (const [, r] of results) {
    for (const m of r.minted) assert.match(m.value, new RegExp("^" + m.prefix + "[0-9a-z]{0,7}[0-9a-z]{8}$"));
  }
});

test("golden: migrateDocument's docIds", () => {
  assert.equal(goldenText(docIds), goldenText(expected.value.docIds));
});

test("#82: a file's docId is derived from its JSON as read, before migration interns its pictures", () => {
  assert.equal(docIds["seed, opened as a file"], deriveDocId("splitpage-file", JSON.stringify(seedRaw())));
  assert.equal(docIds["seed, opened from the server"], deriveDocId("splitpage-server-doc", "srv-1"));
  assert.equal(docIds["legacy file with a picture, opened as a file"], deriveDocId("splitpage-file", JSON.stringify(legacyFileWithPicture())));
  const migrated = migrateRows(legacyFileWithPicture());
  delete migrated.docId;
  assert.notEqual(docIds["legacy file with a picture, opened as a file"], deriveDocId("splitpage-file", JSON.stringify(migrated)));
});

test("migrateDocument of the seed is migrateRows of it with the derived docId", () => {
  const viaDocument = migrateDocument(seedRaw(), { kind: "file" });
  const viaRows = migrateRows(seedRaw());
  viaRows.docId = viaDocument.docId;
  assert.equal(JSON.stringify(viaDocument), JSON.stringify(viaRows));
});

test("the whole fixture file is byte-for-byte what the scenarios produce", () => {
  assert.equal(goldenText(actual), expected.text);
});
