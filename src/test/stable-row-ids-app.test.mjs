import { test, after } from "node:test";
import assert from "node:assert/strict";
import { bootApp, closeApp } from "./_app-boot.mjs";

await bootApp();

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { applyTakenDraft } = await import("../bootstrap/wiring/drafts.ts");
const { currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { confirmSavedNow } = await import("../bootstrap/wiring/save-owners.ts");
const { setHome } = await import("../bootstrap/wiring/location-owner.ts");
const { makeId } = await import("../adapters/identity/ids.ts");
const { buildSplitpageFile, buildMarkdownProject } = await import("../adapters/formats/project-file.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");

after(closeApp);

const raw = () => ({ schema: 2, docId: "d" + "9".repeat(32), title: "Recovered", rows: [
  { audioText: "Alpha original." }, { audioText: "Beta original." }
] });

async function recover(disk, base, mine) {
  const fake = window.__desktopTest.makeFakeBackend();
  window.__desktopTest.setBackend(fake);
  try {
    const picked = await fake.saveFileDialog({ suggestedName: "idless.splitpage" });
    const bytes = JSON.stringify(disk);
    await fake.writeFile(picked.id, new TextEncoder().encode(bytes));
    const outcome = await applyTakenDraft({
      header: { origin: { kind: "file", fileName: picked.name }, docIdWrittenOut: true },
      file: { id: picked.id, name: picked.name }, stateJson: JSON.stringify(mine), baseJson: JSON.stringify(base)
    });
    assert.equal(fake._text(picked.id), bytes);
    return { outcome, doc: structuredClone(currentDocument()) };
  } finally {
    confirmSavedNow();
    setHome("none");
    window.__desktopTest.restoreBackend();
  }
}

test("#1049: restoreFileDraft restores an independently loaded id-less file without a second scene", async () => {
  const disk = raw();
  const base = migrateRows(structuredClone(disk));
  const mine = structuredClone(base);
  mine.rows[0].audioText = "Alpha unsaved.";
  const result = await recover(disk, base, mine);
  assert.equal(result.outcome, "applied");
  assert.deepEqual(result.doc.rows.map(r => r.audioText), ["Alpha unsaved.", "Beta original."]);
  assert.deepEqual(result.doc.comments, []);
});

for (const change of ["insert", "reorder"]) {
  test("#1049: hand-" + change + " before recovery retains disk text and unsaved text", async () => {
    const disk = raw();
    const base = migrateRows(structuredClone(disk));
    const mine = structuredClone(base);
    mine.rows[0].audioText = "Alpha unsaved.";
    if (change === "insert") disk.rows.unshift({ audioText: "Inserted on disk." });
    else disk.rows.reverse();
    const { outcome, doc } = await recover(disk, base, mine);
    assert.equal(outcome, "merged");
    assert.deepEqual(doc.rows.map(r => r.audioText), change === "insert"
      ? ["Inserted on disk.", "Alpha unsaved.", "Beta original."]
      : ["Beta original.", "Alpha unsaved."]);
    assert.deepEqual(doc.comments, []);
  });
}

test("#1049: competing hand edits keep both scenes rather than overwriting unsaved text", async () => {
  const disk = raw();
  const base = migrateRows(structuredClone(disk));
  const mine = structuredClone(base);
  mine.rows[0].audioText = "Alpha unsaved.";
  disk.rows[0].audioText = "Alpha changed on disk.";
  const { outcome, doc } = await recover(disk, base, mine);
  assert.equal(outcome, "merged");
  assert.deepEqual(doc.rows.map(r => r.audioText), ["Alpha unsaved.", "Alpha changed on disk.", "Beta original."]);
  assert.deepEqual(doc.comments, []);
});

test("#1049: a draft with old random base ids retains unsaved text when the file loads with repaired ids", async () => {
  const disk = raw();
  const base = migrateRows({ ...structuredClone(disk), rows: disk.rows.map((r, i) => ({ ...r, id: "roldrandom" + i })) });
  const mine = structuredClone(base);
  mine.rows[0].audioText = "Alpha unsaved before the fix.";
  const { outcome, doc } = await recover(disk, base, mine);
  assert.equal(outcome, "merged");
  assert.ok(doc.rows.some(r => r.audioText === "Alpha unsaved before the fix."));
  assert.ok(doc.rows.some(r => r.audioText === "Beta original."));
  assert.ok(doc.rows.some(r => r.audioText === "Alpha original."));
});

test("#1049: missing comment, reply and b-roll ids do not duplicate recovered work", async () => {
  const disk = raw();
  disk.rows[0].id = "stable";
  disk.rows[0].visualText = 'B-roll: Steam<br><span class="broll-key">B-roll:</span> Hands';
  disk.comments = [
    { rowId: "stable", field: "audioText", body: "Comment original." },
    { id: "thread", rowId: "stable", field: "audioText", body: "Thread.", replies: [{ body: "Reply original." }] }
  ];
  disk.brollShots = [{ name: "List shot", origin: "list", notes: "" }];
  const base = migrateRows(structuredClone(disk));
  const mine = structuredClone(base);
  mine.comments[0].body = "Comment unsaved.";
  mine.brollShots.find(b => b.name === "List shot").notes = "Shot unsaved.";
  mine.brollShots.find(b => b.name === "Steam").notes = "Steam unsaved.";
  mine.brollShots.find(b => b.name === "Hands").notes = "Hands unsaved.";
  disk.rows[1].audioText = "Beta changed on disk.";
  const { outcome, doc } = await recover(disk, base, mine);
  assert.equal(outcome, "merged");
  assert.deepEqual(doc.rows.map(r => r.audioText), ["Alpha original.", "Beta changed on disk."]);
  assert.deepEqual(doc.comments.map(c => [c.body, c.replies.map(r => r.body)]), [
    ["Comment unsaved.", []], ["Thread.", ["Reply original."]]
  ]);
  assert.deepEqual(doc.brollShots.map(b => [b.name, b.notes]), [
    ["List shot", "Shot unsaved."], ["Steam", "Steam unsaved."], ["Hands", "Hands unsaved."]
  ]);
});

test("#1049: embedded b-roll ids later in the file are reserved before missing keys are repaired", () => {
  const row = { id: "scene", visualText: '<span class="broll-key">B-roll:</span> Steam' };
  const id = migrateRows({ schema: 2, rows: [structuredClone(row)] }).brollShots[0].id;
  for (const rows of [
    [row, { id: "later", visualText: '<span class="broll-key" data-broll-id="' + id + '">B-roll:</span> Hands' }],
    [{ id: "later", visualText: '<span class="broll-key" data-broll-id="' + id + '">B-roll:</span> Hands' }, row]
  ]) {
    const doc = migrateRows({ schema: 2, rows: structuredClone(rows) });
    assert.equal(doc.brollShots.find(b => b.name === "Steam").id, id + "-1");
    assert.equal(doc.brollShots.find(b => b.name === "Hands").id, id);
    assert.equal(JSON.stringify(migrateRows(structuredClone(doc))), JSON.stringify(doc));
  }
});

test("#1049: editing ids cannot enter the derived namespace, and complete projects save byte-identically", () => {
  const doc = migrateRows(raw());
  for (let i = 0; i < 100; i++) {
    const id = makeId();
    assert.match(id, /^r[a-z0-9]+$/);
    assert.ok(doc.rows.every(r => r.id !== id));
  }
  doc.sections = [{ id: "section", name: "Part", firstSceneId: doc.rows[0].id }];
  for (const writer of [buildSplitpageFile, buildMarkdownProject]) {
    const before = writer(exportDocumentOf(doc));
    const after = writer(exportDocumentOf(migrateRows(structuredClone(doc))));
    assert.equal(after, before);
  }
});
