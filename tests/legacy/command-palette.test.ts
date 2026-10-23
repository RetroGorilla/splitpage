import "../../src/test/_dom.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { commandResults } from "../../src/js/18d-command-menu.js";
import { appActions } from "../../src/legacy/app-actions.ts";
import { wireRegistries } from "../../src/test/_registries.mjs";
import { mountFileMenuExportFeature, stopFileMenuExportFeature } from "../../src/bootstrap/wiring/file-menu-export.ts";

const wired = wireRegistries();
mountFileMenuExportFeature();
after(() => {
  stopFileMenuExportFeature();
  wired.dispose();
});

interface Listed {
  readonly group: string;
  readonly id: string;
  readonly label: string;
  readonly why: string;
}

interface ResultItem {
  readonly cmd: { readonly id: string };
  readonly view: { readonly label: string; readonly why: string };
}

interface ResultGroup {
  readonly group: string;
  readonly items: readonly ResultItem[];
}

function results(query: string): readonly ResultGroup[] {
  return commandResults(query);
}

function listed(query: string): Listed[] {
  return results(query).flatMap((g) => g.items.map((it) => ({ group: g.group, id: it.cmd.id, label: it.view.label, why: it.view.why })));
}

test("an action registered anywhere is listed under its group, with no change to the command menu", () => {
  const off = appActions.register({ id: "test-zebra", label: "Zebra stripes", group: "View", icon: "i-panel", words: "stripes", run: () => {} });
  try {
    assert.deepEqual(listed("zebra"), [{ group: "View", id: "test-zebra", label: "Zebra stripes", why: "" }]);
    assert.deepEqual(listed("stripes").map((l) => l.id), ["test-zebra"]);
  } finally {
    off();
  }
  assert.deepEqual(listed("zebra"), []);
});

test("a group the command menu does not know yet is listed after the ones it does", () => {
  const offs = [
    appActions.register({ id: "test-herd", label: "Herd zebras", group: "Zebras", run: () => {} }),
    appActions.register({ id: "test-guide", label: "Zebra guide", group: "Help", run: () => {} })
  ];
  try {
    assert.deepEqual(results("").map((g) => g.group), ["Export", "Help", "Zebras"]);
  } finally {
    for (const off of offs) off();
  }
});

test("what an action shows is read each time the menu lists, never kept from the first time", () => {
  let label = "Zebra stripes";
  let enabled = true;
  const off = appActions.register({
    id: "test-zebra", label: () => label, group: "View", run: () => {},
    availability: () => (enabled ? { enabled: true } : { enabled: false, reason: "No zebras here" })
  });
  try {
    assert.deepEqual(listed("zebra"), [{ group: "View", id: "test-zebra", label: "Zebra stripes", why: "" }]);
    label = "Zebra spots";
    enabled = false;
    assert.deepEqual(listed("zebra"), [{ group: "View", id: "test-zebra", label: "Zebra spots", why: "No zebras here" }]);
  } finally {
    off();
  }
});

test("the command menu does not list itself, nor an action that asks not to be listed", () => {
  const offs = [
    appActions.register({ id: "command-menu", label: "Search commands… zebra", group: "File", run: () => {} }),
    appActions.register({ id: "test-hidden", label: "Hidden zebra", group: "View", availability: () => ({ enabled: true, visible: false }), run: () => {} })
  ];
  try {
    assert.deepEqual(listed("zebra"), []);
  } finally {
    for (const off of offs) off();
  }
});
