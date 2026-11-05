import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startLocalMerge } from "../../../src/features/merge/local-merge.ts";
import type { MergeReviewPorts } from "../../../src/features/merge/ports.ts";
import type { Home } from "../../../src/application/location/document-location.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";
import { jsonCopy, migratedThenSet } from "../../core/migrate-ports.ts";
import { textMergeContext } from "../../../src/core/merge/text-field.ts";
import type { TagSide } from "../../../src/core/merge/text-field.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { mergeStates } from "../../../src/core/merge-states.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

const DOC_ID = "d" + "1".repeat(32);

interface Row { id: string; audioText: string; visualText: string; status: string; imageRef?: unknown; paragraphStart?: true; lengthSeconds?: number }
interface Doc { schema: number; title: string; docId: string; rows: Row[]; sections?: DocumentScene[]; productionTags: unknown[]; people: unknown[]; brollShots: unknown[]; comments: unknown[] }

function row(id: string, audioText: string, extra: Partial<Row> = {}): Row {
  return { id, audioText, visualText: "", status: "todo", ...extra };
}

function validated(raw: Doc): Doc & ValidatedDocument {
  return jsonCopy(migratedThenSet(raw));
}

function doc(rows: Row[], docId = DOC_ID): Doc & ValidatedDocument {
  return validated({ schema: 2, title: "T", docId, rows, productionTags: [], people: [], brollShots: [], comments: [] });
}

function copy<T>(v: T): T {
  return jsonCopy(v);
}

const decode = (html: string): Run[] => (html ? [{ text: html, marks: {} }] : []);

function page(): void {
  win.document.body.innerHTML =
    '<div id="file-conflict-modal"><button id="file-conflict-merge" hidden></button></div>' +
    '<div id="merge-review-modal" hidden><p id="merge-review-detail"></p><div id="merge-review-list"></div>' +
    '<button id="merge-review-confirm"></button></div>';
}

const el = (id: string) => win.document.getElementById(id) as HTMLElement;

interface Setup {
  mine: Doc & ValidatedDocument;
  parsed: () => ReturnType<MergeReviewPorts["files"]["parse"]>;
  mergeBase?: (Doc & ValidatedDocument) | null;
  fileHome?: Home | null;
}

function setup(opts: Setup) {
  page();
  const calls = {
    parsed: [] as { file: unknown; opts: unknown }[],
    contexts: [] as { base: unknown; mine: unknown; theirs: unknown }[],
    amended: [] as { record: Home; fields: unknown }[],
    migrated: [] as unknown[],
    migratedTo: [] as unknown[],
    applied: [] as { disk: unknown; work: unknown; apply: unknown }[],
    pictures: [] as string[],
    plain: [] as unknown[],
    closed: 0
  };
  const ports: MergeReviewPorts = {
    document: { current: () => opts.mine },
    session: { mergeBase: () => (opts.mergeBase === undefined ? null : opts.mergeBase) },
    place: { fileHome: () => (opts.fileHome === undefined ? null : opts.fileHome) },
    homes: { amendHome: (record, fields) => { calls.amended.push({ record, fields }); return record; } },
    conflicts: { close: () => { calls.closed++; } },
    pictures: {
      imgHtml: (ref, cls) => {
        calls.pictures.push(ref.sha256);
        return '<img class="' + String(cls) + '" data-blob="' + ref.sha256 + '">';
      }
    },
    text: { htmlToPlainText: (html) => { calls.plain.push(html); return String(html ?? ""); } },
    entry: {
      migrate: (raw) => {
        const out = validated(raw as Doc);
        calls.migrated.push(raw);
        calls.migratedTo.push(out);
        return out;
      }
    },
    files: { parse: (file, o) => { calls.parsed.push({ file, opts: o }); return opts.parsed(); } },
    recovery: {
      applyStashedWork: (disk, work, apply) => {
        calls.applied.push({ disk, work, apply });
        return { state: disk, report: null, snapshot: null };
      }
    },
    textMergeContext: (base, m, t) => {
      calls.contexts.push({ base, mine: m, theirs: t });
      return textMergeContext(decode, base as TagSide | null, m as TagSide, t as TagSide);
    }
  };
  return { ports, calls };
}

function file(name = "disk.splitpage", lastModified = 1234): { name: string; lastModified: number } {
  return { name, lastModified };
}

function heads(): string[] {
  return Array.from(win.document.querySelectorAll("#merge-review-list .merge-group-head"), (h) => (h.firstChild as Text).textContent ?? "");
}

for (const field of ["paragraphStart", "lengthSeconds"] as const) {
  for (const audioText of ["Text", ""]) {
    for (const editedSide of ["mine", "theirs"] as const) {
      test(`merge review keeps ${editedSide}'s ${field}-only edited ${audioText ? "text" : "blank"} beat against deletion`, async () => {
        const base = doc([row("a", audioText)]);
        const changed = doc([row("a", audioText, field === "paragraphStart" ? { paragraphStart: true } : { lengthSeconds: 12 })]);
        const deleted = doc([]);
        const mine = editedSide === "mine" ? changed : deleted, theirs = editedSide === "mine" ? deleted : changed;
        const { ports } = setup({ mine, mergeBase: base, parsed: () => Promise.resolve({ state: copy(theirs) }) });
        const merge = startLocalMerge(ports);
        try {
          await merge.offer(file(), { kind: "file", diskBase: base } as Home);
          merge.open();
          assert.deepEqual(heads(), ["Beat A.1"]);
          const entries = Array.from(win.document.querySelectorAll(".merge-entry"));
          assert.equal(entries.length, 1);
          assert.equal(entries[0]?.getAttribute("data-outcome"), editedSide);
          assert.equal(entries[0]?.querySelector(".merge-entry-outcome")?.textContent,
            editedSide === "mine" ? "Your version is kept" : "The file's version is taken");
          assert.match(el("merge-review-detail").textContent ?? "", /^One field differs/);
          assert.match(el("merge-review-list").textContent ?? "", editedSide === "mine" ? /your version stays/ : /it comes back/);
          const migration = fakeMigration();
          const merged = mergeStates(base, mine, theirs, { migrate: migration.ports, ids: migration.ids, decode,
            clock: { nowIso: () => "2030-01-01T00:00:00.000Z" }, editor: () => "Bob" });
          assert.deepEqual(merged.merged.rows, migrateRows(copy(changed), migration.ports).rows);
        } finally {
          merge.dispose();
        }
      });
    }
  }
}

test("merge review gives every text and media entry the whole beat's retained or deleted fate", async () => {
  const imageRef = { sha256: "a".repeat(64), width: 10, height: 10, mime: "image/png" };
  const withMedia = { ...row("a", "Audio", { visualText: "Visual", imageRef }),
    moreImages: [{ imageRef, name: "Extra" }], imageLinks: [{ href: "https://example.com/video", name: "Clip" }] };
  const base = doc([withMedia]);
  for (const retained of [false, true]) {
    const changed = copy(base);
    if (retained) Object.assign(changed.rows[0] as object, { paragraphStart: true });
    for (const presentSide of ["mine", "theirs"] as const) {
      const mine = presentSide === "mine" ? changed : doc([]), theirs = presentSide === "mine" ? doc([]) : changed;
      const { ports } = setup({ mine, parsed: () => Promise.resolve({ state: copy(theirs) }) });
      const merge = startLocalMerge(ports);
      try {
        await merge.offer(file(), { kind: "file", diskBase: base } as Home);
        merge.open();
        const outcomes = Array.from(win.document.querySelectorAll(".merge-entry"), entry => entry.getAttribute("data-outcome"));
        const expected = retained ? presentSide : presentSide === "mine" ? "theirs" : "mine";
        assert.deepEqual(outcomes, Array(5).fill(expected));
      } finally {
        merge.dispose();
      }
    }
  }
});

test("merge review numbers a locally inserted beat from its actual scene", async () => {
  const base = doc([row("a", "A"), row("c", "C")]);
  const mine = validated({ ...copy(base), rows: [row("a", "A"), row("b", "Inserted"), row("c", "C")],
    sections: [{ id: "local", name: "Local scene", firstSceneId: "b" }] });
  const { ports, calls } = setup({ mine, mergeBase: base, parsed: () => Promise.resolve({ state: copy(base) }) });
  const merge = startLocalMerge(ports);
  try {
    await merge.offer(file(), null);
    merge.open();
    assert.deepEqual(heads(), ["Beat B.1"]);
    assert.match(el("merge-review-list").textContent ?? "", /Inserted/);
    assert.equal(calls.applied.length, 0);
    assert.deepEqual(mine.rows.map(r => r.id), ["a", "b", "c"]);
  } finally {
    merge.dispose();
  }
});

test("merge review identifies both actual references when only the local header changes membership", async () => {
  const base = doc([row("a", "A"), row("b", "Original")]);
  const mine = validated({ ...copy(base), rows: [row("a", "A"), row("b", "Local words")],
    sections: [{ id: "local", name: "Local scene", firstSceneId: "b" }] });
  const theirs = doc([row("a", "A"), row("b", "Disk words")]);
  const { ports } = setup({ mine, mergeBase: base, parsed: () => Promise.resolve({ state: copy(theirs) }) });
  const merge = startLocalMerge(ports);
  try {
    await merge.offer(file(), null);
    merge.open();
    assert.deepEqual(heads(), ["Beat B.1 (Open here) / A.2 (On disk)"]);
    assert.deepEqual(Array.from(win.document.querySelectorAll(".merge-side-body"), side => side.textContent),
      ["Local words", "Disk words"]);
  } finally {
    merge.dispose();
  }
});

test("merge review numbers a disk-only beat from the complete disk layout", async () => {
  const mine = doc([row("a", "A"), row("c", "C")]);
  const theirs = validated({ ...copy(mine), rows: [row("a", "A"), row("b", "Disk insertion"), row("c", "C")],
    sections: [{ id: "disk", name: "Disk scene", firstSceneId: "b" }] });
  const { ports } = setup({ mine, parsed: () => Promise.resolve({ state: copy(theirs) }) });
  const merge = startLocalMerge(ports);
  try {
    await merge.offer(file(), null);
    merge.open();
    assert.deepEqual(heads(), ["Beat B.1"]);
  } finally {
    merge.dispose();
  }
});

test("merge review keeps side references when a common beat has moved", async () => {
  const base = doc([row("a", "A"), row("b", "B")]);
  const mine = doc([row("b", "Local words"), row("a", "A")]);
  const theirs = doc([row("a", "A"), row("b", "Disk words")]);
  const { ports } = setup({ mine, mergeBase: base, parsed: () => Promise.resolve({ state: copy(theirs) }) });
  const merge = startLocalMerge(ports);
  try {
    await merge.offer(file(), null);
    merge.open();
    assert.deepEqual(heads(), ["Beat A.1 (Open here) / A.2 (On disk)"]);
  } finally {
    merge.dispose();
  }
});

test("merge review: offers a file that parses, lists each side's changes and confirms through the ports", async () => {
  const base = doc([row("r1", "one two"), row("r2", "kept")]);
  const mine = doc([row("r1", "one two"), row("r2", "kept")]);
  const theirs = doc([row("r1", "one three")]);
  const home = { kind: "file", diskBase: copy(base) } as Home;
  const { ports, calls } = setup({ mine, parsed: () => Promise.resolve({ state: copy(theirs) }) });
  const merge = startLocalMerge(ports);
  try {
    await merge.offer(file(), home);
    assert.deepEqual(calls.parsed, [{ file: file(), opts: { noAsk: true } }]);
    assert.equal(el("file-conflict-merge").hidden, false, "the merge is offered");

    merge.open();
    assert.equal(calls.contexts.length, 1);
    assert.deepEqual(calls.contexts[0], { base: base, mine: mine, theirs: theirs }, "the text context is asked for base, mine and theirs");
    assert.deepEqual(heads(), ["Beat A.1", "Beat A.2"]);
    assert.match(el("merge-review-list").innerHTML, /<span class="diff-del">two<\/span>/);
    assert.match(el("merge-review-list").innerHTML, /<span class="diff-add">three<\/span>/);
    assert.match(el("merge-review-list").textContent ?? "", /The file's version is taken/);
    assert.match(el("merge-review-list").textContent ?? "", /Deleted in the file on disk — it goes\./);
    assert.match(el("merge-review-detail").textContent ?? "", /between disk\.splitpage and what you have open\. Nothing is written until you merge\.$/);
    assert.ok(calls.plain.includes("one two") && calls.plain.includes("one three"), "the review reads plain text through the text port");
    assert.equal(el("file-conflict-modal").hidden, true);
    assert.equal(el("merge-review-modal").hidden, false);
    assert.equal(win.document.activeElement, el("merge-review-confirm"));

    merge.confirm();
    assert.equal(calls.closed, 1, "the file conflict is closed");
    assert.equal(el("merge-review-modal").hidden, true);
    assert.equal(el("merge-review-list").innerHTML, "");
    assert.deepEqual(calls.amended, [{ record: home, fields: { diskBase: theirs, lastModified: 1234 } }]);
    assert.deepEqual(calls.migrated, [theirs]);
    assert.equal(calls.applied.length, 1);
    const applied = calls.applied[0] as { disk: unknown; work: unknown; apply: Record<string, unknown> };
    assert.equal(applied.disk, calls.migratedTo[0], "the migrated copy of the file is applied");
    assert.deepEqual(applied.work, { base: base, mine: mine });
    assert.deepEqual(applied.apply, {
      newBase: theirs,
      historyFrom: DOC_ID,
      chips: true,
      noAutoSave: true,
      toast: {
        text: "Merged disk.splitpage into what you have open. Nothing has been saved yet — press Save when you have looked it over.",
        tone: "warn",
        sticky: true
      }
    });

    merge.confirm();
    assert.equal(calls.applied.length, 1, "nothing is applied twice");
    assert.equal(el("file-conflict-modal").hidden, true, "with no offer left, cancel does not bring the conflict back");
  } finally {
    merge.dispose();
  }
});

test("merge review: a file that does not parse, a different embedded id or a reset during the probe offers nothing", async () => {
  const mine = doc([row("r1", "one")]);
  const bad = setup({ mine, parsed: () => Promise.resolve({ error: "unreadable" }) });
  const first = startLocalMerge(bad.ports);
  await first.offer(file(), null);
  assert.equal(el("file-conflict-merge").hidden, true);
  first.dispose();

  const other = setup({ mine, parsed: () => Promise.resolve({ state: doc([row("r1", "two")], "d" + "2".repeat(32)), docIdEmbedded: true }) });
  const second = startLocalMerge(other.ports);
  await second.offer(file(), null);
  assert.equal(el("file-conflict-merge").hidden, true);
  second.dispose();

  let release: (v: Awaited<ReturnType<MergeReviewPorts["files"]["parse"]>>) => void = () => {};
  const slow = setup({ mine, parsed: () => new Promise((resolve) => { release = resolve; }) });
  const third = startLocalMerge(slow.ports);
  const probe = third.offer(file(), null);
  third.reset();
  release({ state: doc([row("r1", "two")]) });
  await probe;
  assert.equal(el("file-conflict-merge").hidden, true, "an overtaken probe offers nothing");
  third.open();
  assert.equal(el("merge-review-modal").hidden, true, "nothing to review");
  third.dispose();
});

test("merge review: the session's merge base stands in for the open file only when its id matches", async () => {
  const mine = doc([row("r1", "one two")]);
  const theirs = doc([row("r1", "one three")]);
  const home = { kind: "file" } as Home;
  const matched = setup({ mine, mergeBase: doc([row("r1", "one two")]), fileHome: home, parsed: () => Promise.resolve({ state: copy(theirs) }) });
  const first = startLocalMerge(matched.ports);
  await first.offer(file(), home);
  first.open();
  assert.doesNotMatch(el("merge-review-detail").textContent ?? "", /no earlier version/);
  assert.match(el("merge-review-list").textContent ?? "", /The file's version is taken/);
  first.dispose();

  const elsewhere = setup({ mine, mergeBase: doc([row("r1", "one two")], "d" + "3".repeat(32)), fileHome: home, parsed: () => Promise.resolve({ state: copy(theirs) }) });
  const second = startLocalMerge(elsewhere.ports);
  await second.offer(file(), home);
  second.open();
  assert.match(el("merge-review-detail").textContent ?? "", /there is no earlier version of this file to compare both against/);
  assert.equal(elsewhere.calls.contexts[0]?.base, null);
  second.dispose();
});

test("merge review: stored pictures are drawn through the pictures port", async () => {
  const ref = (ch: string) => ({ sha256: ch.repeat(64), width: 10, height: 10, mime: "image/png" });
  const mine = doc([row("r1", "one", { imageRef: ref("a") })]);
  const theirs = doc([row("r1", "one", { imageRef: ref("b") })]);
  const { ports, calls } = setup({ mine, parsed: () => Promise.resolve({ state: copy(theirs) }) });
  const merge = startLocalMerge(ports);
  try {
    await merge.offer(file(), null);
    merge.open();
    assert.deepEqual(calls.pictures, ["a".repeat(64), "b".repeat(64)]);
    assert.equal(win.document.querySelectorAll("#merge-review-list img.diff-img[data-blob]").length, 2);
    assert.match(el("merge-review-list").textContent ?? "", /Visual image/);
  } finally {
    merge.dispose();
  }
});

test("merge review: cancel brings the conflict back while an offer stands, and dispose drops the offer", async () => {
  const mine = doc([row("r1", "one")]);
  const { ports, calls } = setup({ mine, parsed: () => Promise.resolve({ state: doc([row("r1", "two")]) }) });
  const merge = startLocalMerge(ports);
  await merge.offer(file(), null);
  merge.open();
  merge.cancel();
  assert.equal(el("merge-review-modal").hidden, true);
  assert.equal(el("merge-review-list").innerHTML, "");
  assert.equal(el("file-conflict-modal").hidden, false);

  merge.dispose();
  merge.dispose();
  assert.equal(el("file-conflict-merge").hidden, true);

  const again = setup({ mine, parsed: () => Promise.resolve({ state: doc([row("r1", "two")]) }) });
  const next = startLocalMerge(again.ports);
  next.open();
  next.confirm();
  assert.equal(calls.applied.length + again.calls.applied.length, 0, "a fresh mount has no offer from the last one");
  next.dispose();
});
