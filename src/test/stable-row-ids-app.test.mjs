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
const { buildSplitpageFile, buildMarkdownProject, parseProjectFileState } = await import("../adapters/formats/project-file.ts");
const { projectFileServices } = await import("../application/formats/project-file-services.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");

after(closeApp);

const raw = () => ({ schema: 2, docId: "d" + "9".repeat(32), title: "Recovered", rows: [
  { audioText: "Alpha original." }, { audioText: "Beta original." }
] });

async function recover(disk, base, mine, markdown = false) {
  const fake = window.__desktopTest.makeFakeBackend();
  window.__desktopTest.setBackend(fake);
  try {
    const picked = await fake.saveFileDialog({ suggestedName: markdown ? "idless.md" : "idless.splitpage" });
    const bytes = markdown ? disk : JSON.stringify(disk);
    await fake.writeFile(picked.id, new TextEncoder().encode(bytes));
    const restoring = applyTakenDraft({
      header: { origin: { kind: "file", fileName: picked.name }, docIdWrittenOut: true },
      file: { id: picked.id, name: picked.name }, stateJson: JSON.stringify(mine), baseJson: JSON.stringify(base)
    });
    if (markdown) {
      const modal = document.getElementById("md-rows-modal");
      for (let turn = 0; turn < 100 && modal.hidden; turn++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(modal.hidden, false);
      document.getElementById("md-rows-table").click();
    }
    const outcome = await restoring;
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

test("#1049: restoreFileDraft keeps a hand-added Markdown scene after accepting the same table twice", async () => {
  const block = migrateRows({ schema: 2, docId: "d" + "8".repeat(32), title: "Markdown", rows: [{ id: "a", visualText: "wide", audioText: "Original." }] });
  const text = '# Markdown\n\n| # | Visual | Audio | Status |\n| --- | --- | --- | --- |\n| 1 | wide | Original. | todo |\n| 2 | close | Added original. | todo |\n\n~~~~splitpage\n' + JSON.stringify(block) + '\n~~~~\n';
  const parsed = await parseProjectFileState({ name: "idless.md", text: async () => text }, null,
    { ...projectFileServices(), askMarkdownRows: async () => "table" });
  assert.ok(parsed && "state" in parsed);
  const base = parsed.state;
  const mine = structuredClone(base);
  mine.rows[1].audioText = "Added unsaved.";
  const { outcome, doc } = await recover(text, base, mine, true);
  assert.equal(outcome, "applied");
  assert.deepEqual(doc.rows.map(r => r.audioText), ["Original.", "Added unsaved."]);
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
      ? ["Alpha unsaved.", "Inserted on disk.", "Alpha original.", "Beta original."]
      : ["Alpha unsaved.", "Beta original.", "Alpha original."]);
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

test("#1049: missing comment, reply and b-roll ids are stable for unchanged file bytes", async () => {
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
  const { outcome, doc } = await recover(disk, base, mine);
  assert.equal(outcome, "applied");
  assert.deepEqual(doc.rows.map(r => r.audioText), ["Alpha original.", "Beta original."]);
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
  for (const attribute of ["data-broll-id", "DATA-BROLL-ID"]) {
    const held = { id: "later", visualText: '<span class="broll-key" ' + attribute + '="' + id + '">B-roll:</span> Hands' };
    for (const rows of [[row, held], [held, row]]) {
      const doc = migrateRows({ schema: 2, rows: structuredClone(rows) });
      assert.notEqual(doc.brollShots.find(b => b.name === "Steam").id, id);
      assert.match(doc.brollShots.find(b => b.name === "Steam").id, /^bs-load-[0-9a-f]{24}-[0-9]+$/);
      assert.equal(doc.brollShots.find(b => b.name === "Hands").id, id);
      assert.equal(JSON.stringify(migrateRows(structuredClone(doc))), JSON.stringify(doc));
    }
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

for (const text of ["Repeat.", ""]) {
  test("#1049 review: an edited twin never consumes the untouched " + JSON.stringify(text) + " scene", async () => {
    const disk = { ...raw(), rows: [{ audioText: text }, { audioText: text }] };
    const base = migrateRows(structuredClone(disk));
    const mine = structuredClone(base);
    mine.rows[0].audioText = "Draft first.";
    disk.rows[0].audioText = "Disk first.";
    const { outcome, doc } = await recover(disk, base, mine);
    assert.equal(outcome, "merged");
    assert.deepEqual(doc.rows.map(r => r.audioText).sort(), ["Draft first.", "Disk first.", text].sort());
    assert.deepEqual(doc.comments, []);
  });
}

test("#1049 review: identical missing reply ids never overwrite an unsaved reply", async () => {
  const disk = { ...raw(), rows: [{ id: "scene", audioText: "Script." }], comments: [
    { id: "thread", rowId: "scene", field: "audioText", body: "Thread", replies: [{ body: "Repeat reply." }, { body: "Repeat reply." }] }
  ] };
  const base = migrateRows(structuredClone(disk));
  const mine = structuredClone(base);
  mine.comments[0].replies[0].body = "UNSAVED FIRST REPLY";
  disk.comments[0].replies[0].body = "DISK FIRST REPLY";
  const { outcome, doc } = await recover(disk, base, mine);
  assert.equal(outcome, "merged");
  assert.deepEqual(doc.comments[0].replies.map(r => r.body).sort(), [
    "UNSAVED FIRST REPLY", "DISK FIRST REPLY", "Repeat reply.", "Repeat reply."
  ].sort());
});

test("#1049 review: a title-only disk edit cannot overwrite an id-less reply edit", async () => {
  const disk = { ...raw(), rows: [{ id: "scene", audioText: "Script." }], comments: [
    { id: "thread", field: "title", body: "Thread", replies: [{ body: "Original reply." }] }
  ] };
  const base = migrateRows(structuredClone(disk));
  const mine = structuredClone(base);
  mine.comments[0].replies[0].body = "Unsaved reply.";
  disk.title = "Changed title";
  const { doc } = await recover(disk, base, mine);
  assert.deepEqual(doc.comments[0].replies.map(r => r.body).sort(), ["Original reply.", "Unsaved reply."].sort());
});

test("#1049 review: an older repaired twin base keeps both edits and its untouched twin", async () => {
  const disk = { ...raw(), rows: [{ audioText: "Repeat." }, { audioText: "Repeat." }] };
  const oldId = "r-996c5542d33f32bfadde4b0e";
  const base = migrateRows({ ...structuredClone(disk), rows: disk.rows.map((r, at) => ({ ...r, id: oldId + (at ? "-1" : "") })) });
  const mine = structuredClone(base);
  mine.rows[0].audioText = "Draft first.";
  disk.rows[0].audioText = "Disk first.";
  const { doc } = await recover(disk, base, mine);
  assert.deepEqual(doc.rows.map(r => r.audioText).sort(), ["Draft first.", "Disk first.", "Repeat."].sort());
});

test("#1049 review: removing a reservation cannot lend its old identity to an id-less scene", async () => {
  const disk = { ...raw(), rows: [{ id: "held", audioText: "Explicit." }, { audioText: "Missing." }] };
  const candidate = migrateRows(structuredClone(disk)).rows[1].id;
  disk.rows[0].id = candidate;
  const base = migrateRows(structuredClone(disk));
  const mine = structuredClone(base);
  mine.rows[1].audioText = "Missing unsaved.";
  disk.rows[0].id = "changed-explicit";
  const { doc } = await recover(disk, base, mine);
  assert.deepEqual(doc.rows.map(r => r.audioText).sort(), ["Explicit.", "Missing.", "Missing unsaved."].sort());
  assert.equal(doc.rows.find(r => r.id === candidate), undefined);
});

test("#1049 review: a comment on the edited first twin stays on that scene", async () => {
  const disk = { ...raw(), rows: [{ audioText: "Repeat." }, { audioText: "Repeat." }] };
  const base = migrateRows(structuredClone(disk));
  const mine = structuredClone(base);
  mine.rows[0].audioText = '<span class="cmt-anchor" data-cmt="first-note">Repeat.</span>';
  mine.comments.push({ id: "first-note", anchorId: "first-note", rowId: mine.rows[0].id, field: "audioText", body: "Note on FIRST scene" });
  disk.rows[0].audioText = "Disk first.";
  const { doc } = await recover(disk, base, mine);
  const comment = doc.comments.find(c => c.id === "first-note");
  const anchored = doc.rows.find(r => r.id === comment.rowId);
  assert.equal(anchored.audioText, '<span class="cmt-anchor" data-cmt="' + comment.anchorId + '">Repeat.</span>');
  assert.equal(anchored.id, mine.rows[0].id);
  assert.equal(doc.rows.filter(r => r.audioText === "Repeat.").length, 1);
});

test("#1049 review: a scene comment retains its owner even without a text mark", async () => {
  const disk = { ...raw(), rows: [{ audioText: "Repeat." }, { audioText: "Repeat." }] };
  const base = migrateRows(structuredClone(disk));
  const mine = structuredClone(base);
  mine.comments.push({ id: "scene-note", anchorId: null, rowId: mine.rows[0].id, field: "visualImage", body: "First scene note" });
  disk.rows[0].audioText = "Disk first.";
  const { doc } = await recover(disk, base, mine);
  const note = doc.comments.find(c => c.id === "scene-note");
  assert.equal(note.rowId, mine.rows[0].id);
  assert.equal(doc.rows.find(r => r.id === note.rowId)?.audioText, "Repeat.");
  assert.ok(doc.rows.some(r => r.audioText === "Disk first."));
});

test("#1049 review: nested key order changes neither scene identity nor recovery", async () => {
  const imageRef = { sha256: "a".repeat(64), width: 10, height: 20, mime: "image/png" };
  const disk = { ...raw(), rows: [{ audioText: "Alpha.", imageRef }] };
  const base = migrateRows(structuredClone(disk));
  const mine = structuredClone(base);
  mine.rows[0].audioText = "Alpha unsaved.";
  disk.rows[0].imageRef = { mime: imageRef.mime, height: imageRef.height, width: imageRef.width, sha256: imageRef.sha256 };
  const { outcome, doc } = await recover(disk, base, mine);
  assert.equal(outcome, "applied");
  assert.deepEqual(doc.rows.map(r => r.audioText), ["Alpha unsaved."]);
});

test("#1049 review: seeded twin records retain edits on either side in every repaired collection", async () => {
  let seed = 1049;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const pick = n => (next() >>> 16) % n;
  const covered = new Set();
  for (let run = 0; run < 40; run++) {
    const count = 2 + pick(4);
    const at = pick(count);
    const mode = pick(3);
    const repeated = pick(2) ? "Repeated " + run : "";
    covered.add((repeated ? "text" : "empty") + mode);
    const disk = { ...raw(), rows: Array.from({ length: count }, () => ({ audioText: repeated })),
      comments: [{ id: "thread", field: "title", body: "Thread", replies: Array.from({ length: count }, () => ({ body: repeated })) },
        ...Array.from({ length: count }, () => ({ body: repeated, field: "title" }))],
      people: Array.from({ length: count }, () => ({ name: repeated || "Person" })),
      brollShots: Array.from({ length: count }, () => ({ name: "Shot", notes: repeated, origin: "list" }))
    };
    const base = migrateRows(structuredClone(disk));
    const mine = structuredClone(base);
    const draftText = "Draft " + run, diskText = "Disk " + run;
    if (mode !== 0) {
      mine.rows[at].audioText = draftText;
      mine.comments[0].replies[at].body = draftText;
      mine.people[at].name = draftText;
      mine.brollShots[at].notes = draftText;
      mine.comments[at + 1].body = draftText;
    }
    if (mode !== 1) {
      disk.rows[at].audioText = diskText;
      disk.comments[0].replies[at].body = diskText;
      disk.people[at].name = diskText;
      disk.brollShots[at].notes = diskText;
      disk.comments[at + 1].body = diskText;
    }
    const noteId = "note-" + run;
    mine.rows[at].visualText = '<span class="cmt-anchor" data-cmt="' + noteId + '">Original scene note</span>';
    mine.comments.push({ id: noteId, rowId: mine.rows[at].id, anchorId: noteId, field: "visualText", body: "Original scene note" });
    const { doc } = await recover(disk, base, mine);
    const note = doc.comments.find(c => c.id === noteId);
    assert.equal(note.rowId, mine.rows[at].id, "comment owner " + run);
    assert.equal(doc.rows.find(r => r.id === note.rowId).visualText,
      '<span class="cmt-anchor" data-cmt="' + note.anchorId + '">Original scene note</span>', "comment scene " + run);
    for (const words of [mode !== 0 ? draftText : null, mode !== 1 ? diskText : null].filter(Boolean)) {
      assert.ok(doc.rows.some(r => r.audioText === words), "scene " + words);
      assert.ok(doc.comments.some(c => c.body === words), "comment " + words);
      assert.ok(doc.comments.find(c => c.id === "thread").replies.some(r => r.body === words), "reply " + words);
      assert.ok(doc.people.some(p => p.name === words), "person " + words);
      assert.ok(doc.brollShots.some(b => b.notes === words), "b-roll " + words);
    }
    assert.ok(doc.rows.filter(r => r.audioText === repeated).length >= count - 1, "untouched scenes " + run);
    assert.ok(doc.comments.filter(c => c.body === repeated).length >= count - 1, "untouched comments " + run);
    assert.ok(doc.brollShots.filter(b => b.notes === repeated).length >= count - 1, "untouched shots " + run);
  }
  assert.equal(covered.size, 6);
});

for (const identified of [false, true]) for (const editScene of [false, true]) {
  test("#1049 re-review: retained marked scene copies keep their own comments " + JSON.stringify({ identified, editScene }), async () => {
    const mark = text => '<span class="cmt-anchor" data-cmt="quote">' + text + '</span>';
    const disk = { ...raw(), rows: [{ audioText: mark("Original first.") }],
      comments: [{ ...(identified ? { id: "comment" } : {}), anchorId: "quote", field: "audioText", body: "Original note" }] };
    const base = migrateRows(structuredClone(disk)), mine = structuredClone(base);
    mine.comments[0].body = "DRAFT NOTE";
    if (editScene) mine.rows[0].audioText = mark("Draft first.");
    disk.rows[0].audioText = mark("Disk first.");
    disk.comments[0].body = "DISK NOTE";
    const { doc } = await recover(disk, base, mine);
    assert.equal(doc.rows.length, 2);
    assert.equal(doc.comments.length, 2);
    const draftNote = doc.comments.find(c => c.body === "DRAFT NOTE"), diskNote = doc.comments.find(c => c.body === "DISK NOTE");
    assert.notEqual(draftNote.anchorId, diskNote.anchorId);
    assert.notEqual(draftNote.id, diskNote.id);
    assert.equal(doc.rows.find(r => r.id === draftNote.rowId).audioText,
      '<span class="cmt-anchor" data-cmt="' + draftNote.anchorId + '">' + (editScene ? "Draft first." : "Original first.") + '</span>');
    assert.equal(doc.rows.find(r => r.id === diskNote.rowId).audioText, mark("Disk first."));
  });
}

for (const field of ["resolved", "assignee", "body"]) {
  test("#1049 re-review: ordinary complete-ID deletion still wins over a comment " + field + " edit", async () => {
    const base = migrateRows({ ...raw(), rows: [{ id: "a", audioText: "Original." }, { id: "b", audioText: "Survivor." }],
      comments: [{ id: "c", rowId: "a", field: "visualImage", body: "Note", resolved: false }] });
    const mine = structuredClone(base), disk = structuredClone(base);
    mine.comments[0][field] = field === "resolved" ? true : field === "assignee" ? "Sam" : "Edited note";
    disk.rows.shift(); disk.comments = [];
    const { doc } = await recover(disk, base, mine);
    assert.deepEqual(doc.rows.map(r => r.id), ["b"]);
  });
}

test("#1049 re-review: Markdown without a docId canonicalizes the appended scene's synthetic identity", async () => {
  const block = { schema: 2, title: "Markdown", rows: [{ audioText: "Original." }] };
  const md = data => '# Markdown\n\n| # | Visual | Audio | Status |\n| --- | --- | --- | --- |\n| 1 | | Original. | todo |\n| 2 | | Added. | todo |\n\n~~~~splitpage\n' + JSON.stringify(data) + '\n~~~~\n';
  const services = { ...projectFileServices(), askMarkdownRows: async () => "table" };
  const first = await parseProjectFileState({ name: "source.md", text: async () => md(block) }, null, services);
  const bytes = md({ rows: block.rows, title: block.title, schema: block.schema });
  const second = await parseProjectFileState({ name: "source.md", text: async () => bytes }, null, services);
  assert.equal(first.state.docId, second.state.docId);
  assert.deepEqual(first.state.rows.map(r => r.id), second.state.rows.map(r => r.id));
  const mine = structuredClone(first.state); mine.rows[1].audioText = "Added unsaved.";
  const { outcome, doc } = await recover(bytes, first.state, mine, true);
  assert.equal(outcome, "applied");
  assert.deepEqual(doc.rows.map(r => r.audioText), ["Original.", "Added unsaved."]);
});

test("#1049 re-review: a new id-less disk row cannot undo an explicit scene deletion", async () => {
  const base = migrateRows({ ...raw(), rows: [{ id: "a", audioText: "Original." }, { id: "b", audioText: "Survivor." }],
    comments: [{ id: "c", rowId: "a", field: "visualImage", body: "Note", resolved: false }] });
  const mine = structuredClone(base), disk = structuredClone(base);
  mine.comments[0].assignee = "Sam";
  disk.rows.shift(); disk.comments = []; disk.rows.push({ audioText: "Added." });
  const { doc } = await recover(disk, base, mine);
  assert.deepEqual(doc.rows.map(r => r.audioText), ["Survivor.", "Added."]);
});

test("#1049 re-review: replace-all draft plus revision-only disk change keeps sixty scenes without conflicts", async () => {
  const disk = { ...raw(), rows: Array.from({ length: 30 }, (_, at) => ({ audioText: "Original " + at })) };
  const base = migrateRows(structuredClone(disk)), mine = structuredClone(base);
  mine.rows.forEach((row, at) => { row.audioText = "Draft " + at; });
  disk.rev = 1;
  const { doc } = await recover(disk, base, mine);
  assert.equal(doc.rows.length, 60);
  assert.equal(doc.comments.filter(c => c.kind === "conflict").length, 0);
  for (let at = 0; at < 30; at++) {
    assert.ok(doc.rows.some(row => row.audioText === "Original " + at));
    assert.ok(doc.rows.some(row => row.audioText === "Draft " + at));
  }
  assert.match(document.getElementById("merge-banner").textContent, /30 added by someone else/);
});

test("#1049 re-review: seeded recovery retains each marked comment's original scene owner", async () => {
  let seed = 1049;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const mark = (id, text) => '<span class="cmt-anchor" data-cmt="' + id + '">' + text + '</span>';
  for (let run = 0; run < 100; run++) {
    const count = 2 + (next() >>> 16) % 5, at = (next() >>> 16) % count, mode = (next() >>> 16) % 3;
    const disk = { ...raw(), rows: Array.from({ length: count }, (_, i) => ({ audioText: mark("a" + i, "Original " + i) })),
      comments: Array.from({ length: count }, (_, i) => ({ anchorId: "a" + i, field: "audioText", body: "Comment " + i,
        replies: [{ body: "Reply original " + i }, { body: "Reply twin " + i }] })),
      people: Array.from({ length: count }, (_, i) => ({ name: "Person " + i })),
      brollShots: Array.from({ length: count }, (_, i) => ({ name: "Shot " + i, notes: "Shot note " + i, origin: "list" })) };
    const base = migrateRows(structuredClone(disk)), mine = structuredClone(base);
    for (const [side, label] of [[mine, "Mine"], [disk, "Disk"]]) {
      if ((side === mine && mode === 0) || (side === disk && mode === 1)) continue;
      side.rows[at].audioText = mark("a" + at, label + " scene " + run);
      side.comments[at].body = label + " comment " + run;
      side.comments[at].replies[0].body = label + " reply " + run;
      side.people[at].name = label + " person " + run;
      side.brollShots[at].notes = label + " shot " + run;
    }
    const { doc } = await recover(disk, base, mine);
    assert.deepEqual(migrateRows(structuredClone(doc)), doc);
    for (const label of [mode !== 0 ? "Mine" : null, mode !== 1 ? "Disk" : null].filter(Boolean)) {
      for (const kind of ["scene", "comment", "reply", "person", "shot"]) {
        assert.ok(JSON.stringify(doc).includes(label + " " + kind + " " + run), kind + " " + run);
      }
      const comment = doc.comments.find(c => c.body === label + " comment " + run);
      const owner = doc.rows.find(row => row.id === comment.rowId);
      assert.equal(owner.audioText, mark(comment.anchorId, label + " scene " + run), "owner " + label + " " + run);
    }
  }
});
