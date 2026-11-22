import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMarkdownProject, buildSplitpageFile, parseProjectFileState } from "../../../src/adapters/formats/project-file.ts";
import type { MarkdownProject } from "../../../src/adapters/formats/project-file.ts";
import type { InertElement, MarkdownRowChoice, ProjectFileServices } from "../../../src/application/formats/project-file-services.ts";
import type { DocumentOrigin } from "../../../src/core/migrate.ts";
import { editStamp } from "../../../src/application/commands/save-stamps.ts";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";

interface Calls {
  readonly origins: DocumentOrigin[];
  readonly inert: string[];
  readonly asked: (readonly [number, number])[];
}

function fakes(element: InertElement | null = null, choice: MarkdownRowChoice = "keep"): { services: ProjectFileServices; calls: Calls } {
  const calls: Calls = { origins: [], inert: [], asked: [] };
  const services: ProjectFileServices = {
    migrateRows: (raw) => migrateRows(raw),
    migrateDocument: (raw, origin) => {
      calls.origins.push(origin);
      return migrateRows(raw);
    },
    sanitizeHtml: (html) => html,
    tagFieldOccurrences: (html) => ({ hits: 0, html: html }),
    inertBody: (html) => {
      calls.inert.push(html);
      return { ownerDocument: { getElementById: (id) => (id === "state-data" ? element : null) } };
    },
    askMarkdownRows: (blockRows, tableRows) => {
      calls.asked.push([blockRows, tableRows]);
      return Promise.resolve(choice);
    }
  };
  return { services, calls };
}

function file(name: string, text: string | Error): { name: string; text: () => Promise<string> } {
  return { name, text: () => (text instanceof Error ? Promise.reject(text) : Promise.resolve(text)) };
}

const DOC = JSON.stringify({ title: "T", rows: [{ id: "a", visualText: "v", audioText: "a" }] });

test("parseProjectFileState: names that are not project files are not opened, and an unreadable file says so", async () => {
  const { services } = fakes();
  assert.equal(await parseProjectFileState(file("notes.txt", DOC), null, services), null);
  assert.deepEqual(await parseProjectFileState(file("a.splitpage", new Error("gone")), null, services), { error: "unreadable" });
});

test("parseProjectFileState: a .splitpage file goes through the services' document migration as a file", async () => {
  const { services, calls } = fakes();
  const parsed = await parseProjectFileState(file("a.splitpage", DOC), null, services);
  assert.ok(parsed && "state" in parsed);
  assert.equal(parsed.kind, "splitpage");
  assert.equal(parsed.docIdEmbedded, false);
  assert.equal(parsed.state.title, "T");
  assert.deepEqual(calls.origins, [{ kind: "file" }]);
  assert.deepEqual(await parseProjectFileState(file("b.splitpage", "{\"rows\":7}"), null, services), { error: "not-splitpage" });
});

test("parseProjectFileState: a saved page is read from its state-data script without the inert body, which is only the fallback", async () => {
  const { services, calls } = fakes();
  const page = "<!doctype html><title>x</title><script type=\"application/json\" id=\"state-data\">" + DOC + "</script>";
  const parsed = await parseProjectFileState(file("a.html", page), null, services);
  assert.ok(parsed && "state" in parsed);
  assert.equal(parsed.kind, "html");
  assert.deepEqual(calls.inert, []);
  const fallback = fakes({ textContent: DOC });
  const read = await parseProjectFileState(file("b.html", "<p>no script</p>"), null, fallback.services);
  assert.ok(read && "state" in read);
  assert.deepEqual(fallback.calls.inert, ["<p>no script</p>"]);
  assert.deepEqual(await parseProjectFileState(file("c.html", "<p>no script</p>"), null, fakes(null).services), { error: "not-splitpage" });
  assert.deepEqual(await parseProjectFileState(file("d.html", "<p>x</p>"), null, fakes({ textContent: "[]" }).services), { error: "not-splitpage" });
});

test("applyMarkdownProject: a table with a different number of scenes asks the services, unless told not to ask", async () => {
  const project = (): MarkdownProject => ({
    state: migrateRows(JSON.parse(DOC)),
    docIdEmbedded: false,
    table: [{ visualText: "one", audioText: "1", statusText: "" }, { visualText: "two", audioText: "2", statusText: "" }],
    title: "Renamed"
  });
  const kept = fakes(null, "keep");
  const doc = await applyMarkdownProject(project(), null, kept.services);
  assert.deepEqual(kept.calls.asked, [[1, 2]]);
  assert.equal(doc.rows.length, 1);
  assert.equal(doc.title, "Renamed");
  const quiet = fakes(null, "table");
  assert.equal((await applyMarkdownProject(project(), { noAsk: true }, quiet.services)).rows.length, 1);
  assert.deepEqual(quiet.calls.asked, []);
});

test("#1049: accepting the same hand-added Markdown scenes twice preserves their ids", async () => {
  const project = (): MarkdownProject => ({
    state: migrateRows({ schema: 2, docId: "d" + "a".repeat(32), title: "T", rows: [] }), docIdEmbedded: false, title: null,
    table: [{ visualText: "v", audioText: "a", statusText: "" }, { visualText: "new", audioText: "added", statusText: "" }]
  });
  const { services, calls } = fakes(null, "table");
  const first = await applyMarkdownProject(project(), null, services);
  const second = await applyMarkdownProject(project(), null, services);
  assert.deepEqual(first.rows, second.rows);
  assert.deepEqual(first.rows.map(r => [r.visualText, r.audioText]), [["v", "a"], ["new", "added"]]);
  assert.deepEqual(calls.asked, [[0, 2], [0, 2]]);
});

function saveCapturedProject(source: ValidatedDocument) {
  const exported = buildExportDocument(source, "2026-01-01T00:00:00Z", { production: [], commentNumbers: {}, broll: [] });
  return parseSavedProject(buildSplitpageFile(exported, fakes().services));
}

function parseSavedProject(json: string): Record<string, unknown> & { rows: Record<string, unknown>[] } {
  return JSON.parse(json) as Record<string, unknown> & { rows: Record<string, unknown>[] };
}

test("project capture preserves legacy attribution values and their explicit assignment order", () => {
  for (const value of [null, 123, "2026-01-02T03:04:05Z", true, [1, null], { legacy: 2 }]) {
    const source = migrateRows({ rows: [{ id: "R1", updatedAt: value, updatedBy: "Row editor" }], lastEditedAt: value });
    const saved = saveCapturedProject(source);
    assert.equal(Object.hasOwn(saved, "lastEditedAt"), true);
    assert.deepEqual(saved.lastEditedAt, value);
    assert.deepEqual(saveCapturedProject(migrateRows(saved)).lastEditedAt, value);
    assert.deepEqual(saved.rows[0]?.updatedAt, value ?? "");
    assert.equal(saved.rows[0]?.updatedBy, "Row editor");
  }

  const source = migrateRows({ rows: [{ id: "R1" }] });
  const plan = editStamp({ rev: 7, lastEditedBy: "Editor", lastEditedAt: "2026-01-02T03:04:05Z" }).plan(source);
  assert.ok(plan);
  plan.apply(source);
  const saved = saveCapturedProject(source);
  assert.deepEqual(Object.keys(saved).filter(key => ["rev", "lastEditedBy", "lastEditedAt"].includes(key)),
    ["rev", "lastEditedBy", "lastEditedAt"]);
  assert.deepEqual([saved.rev, saved.lastEditedBy, saved.lastEditedAt], [7, "Editor", "2026-01-02T03:04:05Z"]);
});

test("project capture normalizes scalar boundaries and preserves absent fields", () => {
  const docId = "d" + "1".repeat(32);
  const keys = ["rev", "lastEditedBy", "lastEditedAt", "personColors", "titleOrigin", "titleVersion", "wordsPerMinute",
    "targetSeconds", "paragraphsDecided", "schema", "docId"];
  const rowKeys = ["lengthSeconds", "paragraphStart", "updatedAt", "updatedBy"];
  const pick = (record: Record<string, unknown>, fields: string[]) =>
    Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
  const normalized = saveCapturedProject(migrateRows({ docId, rev: -1.5, lastEditedBy: " Editor ", personColors: { Editor: "#80bdfb" },
    titleOrigin: "file", titleVersion: "V12", wordsPerMinute: "222.6", targetSeconds: 1.6, paragraphsDecided: true,
    rows: [{ id: "R1", lengthSeconds: 1.6, paragraphStart: true }] }));
  assert.deepEqual(pick(normalized, keys), { docId, schema: 2, rev: -1.5, lastEditedBy: "Editor", personColors: { Editor: "#80BDFB" },
    titleOrigin: "file", titleVersion: "v12", wordsPerMinute: 223, targetSeconds: 2, paragraphsDecided: true });
  assert.ok(normalized.rows[0]);
  assert.deepEqual(pick(normalized.rows[0], rowKeys), { lengthSeconds: 2, paragraphStart: true, updatedAt: "", updatedBy: null });

  const absent = saveCapturedProject(migrateRows({ docId, rev: null, lastEditedBy: 12, personColors: null, titleOrigin: null,
    titleVersion: 12, wordsPerMinute: null, targetSeconds: 0, paragraphsDecided: false,
    rows: [{ id: "R1", lengthSeconds: null, paragraphStart: false }] }));
  assert.deepEqual(pick(absent, keys), { docId, schema: 2, rev: 0, wordsPerMinute: 150 });
  assert.ok(absent.rows[0]);
  assert.deepEqual(pick(absent.rows[0], rowKeys), { updatedAt: "", updatedBy: null });
});
