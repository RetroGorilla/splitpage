import { test } from "node:test";
import assert from "node:assert/strict";
import { mountTitleRoutes } from "../../../src/features/title/routes.ts";
import type { TitleRoutes } from "../../../src/features/title/routes.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import { harness } from "../../application/session-fakes.ts";
import type { HarnessHooks } from "../../application/session-fakes.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML = '<input id="doc-title" value="Draft"><input id="writer-title" value="Draft">';
  const input = (id: string): HTMLInputElement => win.document.getElementById(id) as HTMLInputElement;
  return { win, main: input("doc-title"), writer: input("writer-title") };
}

function opened(p: ReturnType<typeof page>, hooks?: HarnessHooks) {
  const h = harness(undefined, hooks);
  h.session.adopt({ title: "Draft", docId: "d" + "4".repeat(32), rows: [] });
  h.log.length = 0;
  h.published.length = 0;
  const pages: string[] = [];
  const title = (): string | null => h.session.read((doc) => (doc ? doc.title : null));
  const mount = (): TitleRoutes => mountTitleRoutes({
    main: p.main,
    writer: p.writer,
    ports: {
      run: (command) => h.session.run(command),
      current: title,
      pageTitle: () => { pages.push(String(title())); }
    }
  });
  return { h, pages, title, mount };
}

function type(p: ReturnType<typeof page>, input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new p.win.Event("input", { bubbles: true }));
}

test("title routes: the main title is one set-title edit, then the page title follows", () => {
  const p = page();
  const t = opened(p);
  t.mount();
  type(p, p.main, "Final");
  assert.equal(t.title(), "Final");
  assert.deepEqual(t.h.published.map((c) => c.changes), [changeSet({ docFields: ["title"] })]);
  assert.deepEqual(t.pages, ["Final"]);
});

test("title routes: the Writer's title is one set-title edit, mirrored to the main title", () => {
  const p = page();
  const t = opened(p);
  t.mount();
  type(p, p.writer, "Final");
  assert.equal(t.title(), "Final");
  assert.equal(t.h.published.length, 1);
  assert.equal(p.main.value, "Final");
  assert.deepEqual(t.pages, [], "the Writer's title leaves the page title to the next paint, as before");
});

test("title routes: an unchanged title makes no edit", () => {
  const p = page();
  const t = opened(p);
  t.mount();
  type(p, p.main, "Draft");
  type(p, p.writer, "Draft");
  assert.deepEqual(t.h.published, []);
  assert.deepEqual(t.pages, []);
});

test("title routes: a refused title puts the document's words back in the box", () => {
  const p = page();
  const t = opened(p);
  t.h.deny("review");
  t.mount();
  type(p, p.writer, "Mine");
  assert.equal(p.writer.value, "Draft");
  assert.equal(p.main.value, "Draft", "nothing is mirrored");
  type(p, p.main, "Mine");
  assert.equal(p.main.value, "Draft");
  assert.equal(t.title(), "Draft");
  assert.deepEqual(t.h.published, []);
  assert.deepEqual(t.pages, []);
});

test("title routes: a failed title is rolled back, puts the words back and is thrown", () => {
  const p = page();
  const t = opened(p, {
    attribute: () => ({ changes: changeSet({ docFields: ["personColors"] }), apply: () => { throw new Error("no colour"); } })
  });
  t.mount();
  const reported: unknown[] = [];
  p.win.addEventListener("error", (e) => { reported.push(e.error); e.preventDefault(); });
  type(p, p.writer, "Broken");
  assert.equal(t.title(), "Draft");
  assert.equal(p.writer.value, "Draft");
  assert.equal(p.main.value, "Draft");
  assert.deepEqual(t.h.published, []);
  assert.equal(reported.length, 1);
  assert.match(String((reported[0] as Error).message), /no colour/);
});

test("title routes: with no document open nothing runs and the box is left alone, as before", () => {
  const p = page();
  const h = harness();
  mountTitleRoutes({ main: p.main, writer: p.writer, ports: { run: (c) => h.session.run(c), current: () => null, pageTitle: () => { throw new Error("not reached"); } } });
  type(p, p.main, "Nothing");
  assert.equal(p.main.value, "Nothing");
  assert.deepEqual(h.published, []);
});

test("title routes: dispose removes both registrations, and a remount handles each input once", () => {
  const p = page();
  const t = opened(p);
  const first = t.mount();
  first.dispose();
  first.dispose();
  type(p, p.main, "Gone");
  assert.deepEqual(t.h.published, []);
  t.mount();
  type(p, p.writer, "Back");
  assert.equal(t.h.published.length, 1);
  assert.equal(t.title(), "Back");
});
