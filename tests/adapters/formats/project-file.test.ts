import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMarkdownProject, parseProjectFileState } from "../../../src/adapters/formats/project-file.ts";
import type { MarkdownProject } from "../../../src/adapters/formats/project-file.ts";
import type { InertElement, MarkdownRowChoice, ProjectFileServices } from "../../../src/application/formats/project-file-services.ts";
import type { DocumentOrigin } from "../../../src/core/migrate.ts";
import { migrateRows } from "../../../src/js/02-state.js";

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
