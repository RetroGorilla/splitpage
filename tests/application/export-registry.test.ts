import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportRegistry, exportToggleOptions } from "../../src/application/export/registry.ts";
import type { ExporterDecl } from "../../src/application/export/registry.ts";

const CARD = { id: "demo", group: "part", name: "Demo", ext: ".demo", icon: "i-file", purpose: "A throwaway format" } as const;

function exporter(id: string, extra: Partial<ExporterDecl> = {}): ExporterDecl {
  return {
    id,
    action: "export-" + id,
    card: "demo",
    name: id,
    menuLabel: id,
    fileName: (base) => base + "." + id,
    build: () => ({ data: id }),
    ...extra
  };
}

test("an exporter is listed once its card is defined, in the order it was registered", () => {
  const registry = createExportRegistry();
  registry.defineCard(CARD);
  assert.deepEqual(registry.cards(), []);
  registry.register(exporter("one", { choice: { value: "a", label: "A" } }));
  registry.register(exporter("two", { choice: { value: "b", label: "B" } }));
  assert.deepEqual(registry.exporters().map((e) => e.action), ["export-one", "export-two"]);
});

test("a card with several exporters needs a choice on each", () => {
  const registry = createExportRegistry();
  registry.defineCard(CARD);
  registry.register(exporter("one", { choice: { value: "a", label: "A" } }));
  assert.throws(() => registry.register(exporter("two")), /needs a choice/);
  assert.throws(() => registry.register(exporter("three", { choice: { value: "a", label: "Again" } })), /already has a choice a/);
  registry.register(exporter("four", { choice: { value: "b", label: "B" } }));
  assert.deepEqual(registry.card("demo")?.variants.map((v) => v.choice?.value), ["a", "b"]);
});

test("a lone exporter on a card has no choice and a second without one is refused", () => {
  const registry = createExportRegistry();
  registry.defineCard(CARD);
  registry.register(exporter("one"));
  assert.throws(() => registry.register(exporter("two")), /needs a choice/);
  assert.throws(() => registry.register(exporter("two", { choice: { value: "b", label: "B" } })), /has a choice but export-one has none/);
});

test("ids and actions are unique and a card must exist before it is used", () => {
  const registry = createExportRegistry();
  assert.throws(() => registry.register(exporter("one")), /card demo, which is not defined/);
  registry.defineCard(CARD);
  assert.throws(() => registry.defineCard(CARD), /already defined/);
  registry.register(exporter("one"));
  assert.throws(() => registry.register(exporter("one", { action: "export-other" })), /exporter one is already registered/);
  assert.throws(() => registry.register(exporter("other", { action: "export-one" })), /action export-one is already registered/);
});

test("an exporter with no action is a provider only: nothing lists it, but it can be looked up", () => {
  const registry = createExportRegistry();
  registry.register({ id: "txt", writeback: true, fileName: (base) => base + ".txt", build: () => ({ data: "x" }) });
  assert.deepEqual(registry.exporters(), []);
  assert.equal(registry.byId("txt")?.writeback, true);
  assert.equal(registry.isAction("txt"), false);
  assert.throws(() => registry.register({ id: "odd", card: "demo", fileName: () => "", build: () => ({ data: "" }) }), /card without an action/);
});

test("isAction answers only for registered action ids", () => {
  const registry = createExportRegistry();
  registry.defineCard(CARD);
  registry.register(exporter("one"));
  assert.equal(registry.isAction("export-one"), true);
  assert.equal(registry.isAction("one"), false);
  assert.equal(registry.isAction(""), false);
  assert.equal(registry.isAction("toString"), false);
  assert.equal(registry.isAction(null), false);
});

test("unregistering removes the exporter and tells listeners; a card with exporters cannot go", () => {
  const registry = createExportRegistry();
  const seen: number[] = [];
  const stop = registry.onChange(() => seen.push(registry.exporters().length));
  const dropCard = registry.defineCard(CARD);
  const drop = registry.register(exporter("one"));
  assert.throws(() => dropCard(), /still has exporters/);
  drop();
  dropCard();
  stop();
  registry.defineCard(CARD);
  assert.deepEqual(seen, [0, 1, 0, 0]);
  assert.deepEqual(registry.cards(), []);
});

test("the registry hands out frozen exporters so a caller cannot edit a declaration", () => {
  const registry = createExportRegistry();
  registry.defineCard(CARD);
  registry.register(exporter("one"));
  const found = registry.byAction("export-one");
  assert.ok(found && Object.isFrozen(found));
});

test("toggle options: a card's toggle gives its stored value unless the caller passes a boolean for it", () => {
  const registry = createExportRegistry();
  let stored = true;
  registry.defineCard({ ...CARD, toggle: { id: "directions", label: "Include", on: () => stored, set: (on) => { stored = on; } } });
  registry.defineCard({ ...CARD, id: "plain" });
  registry.register(exporter("a"));
  registry.register(exporter("b", { card: "plain" }));
  const a = registry.byId("a");
  assert.deepEqual(exportToggleOptions(registry, a), { directions: true });
  stored = false;
  assert.deepEqual(exportToggleOptions(registry, a), { directions: false });
  assert.deepEqual(exportToggleOptions(registry, a, { directions: true }), { directions: true });
  assert.deepEqual(exportToggleOptions(registry, a, { directions: "yes" }), { directions: false });
  assert.deepEqual(exportToggleOptions(registry, registry.byId("b"), { directions: true }), {});
  assert.deepEqual(exportToggleOptions(registry, undefined), {});
  assert.deepEqual(exportToggleOptions(registry, registry.byId("missing")), {});
});
