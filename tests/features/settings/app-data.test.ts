import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mountAppData } from "../../../src/features/settings/app-data.ts";
import { appDataActions } from "../../../src/features/settings/actions.ts";
import { createActionRegistry } from "../../../src/application/actions.ts";
import { appDataActions as wiredAppDataActions, mountAppDataFeature, stopAppDataFeature } from "../../../src/bootstrap/wiring/settings.ts";
import type { AppDataMount, AppDataPorts } from "../../../src/features/settings/ports.ts";
import type { ScreenState } from "../../../src/application/screen.ts";
import { fakeNotices, fakeScreen } from "../fakes.ts";

interface Probe {
  readonly build: () => Promise<{ readonly appVersion: string }>;
  readonly importText: (text: string) => Promise<unknown>;
  readonly useBlobBackend: (backend: null) => boolean;
}

function probe(): Probe {
  return (window as unknown as { readonly __appDataTest: Probe }).__appDataTest;
}

function setup() {
  localStorage.clear();
  document.body.innerHTML = '<input id="import-app-data-input" type="file"><div id="connect-modal"></div>';
  const calls: { name: string; args: unknown[] }[] = [];
  const shown: [string, string | undefined][] = [];
  const actionNotices = fakeNotices();
  const note = (name: string, ...args: unknown[]): void => { calls.push({ name, args }); };
  const ports: AppDataPorts = {
    notices: { show: (message, kind) => { shown.push([message, kind]); return { isConnected: false, dismiss: () => undefined, removeEventListener: () => undefined }; }, showAction: actionNotices.notices.showAction },
    fileDelivery: { deliver: () => Promise.resolve(true) },
    preferences: {
      appDataExport: (extra) => { note("preferences.export", extra); return {}; },
      appDataImport: (incoming, extra) => { note("preferences.import", incoming, extra); return ["commentsSort", "writerSize"]; },
      panelGrouping: () => null,
      commentsSort: () => { note("preferences.commentsSort"); return "recent"; }
    },
    desktop: () => false,
    launchFacts: { appVersion: () => "desktop-version" },
    commentSorting: { choose: (mode) => { note("comments.choose", mode); return "recent"; } },
    history: {
      exportAll: () => { note("history.export"); return Promise.resolve({ docs: [], older: [] }); },
      normalizeSnapshots: (raw) => { note("history.normalize", raw); return [{ legacy: true }]; },
      importBundle: (bundle) => {
        note("history.import", bundle);
        return Promise.resolve({ docs: 1, added: 1, older: 0, skipped: 0, failed: 0, blobs: { stored: 0, refused: [], failed: [] } });
      }
    },
    writer: { size: () => { note("writer.read"); return 20; }, setSize: (size, persist) => { note("writer.apply", size, persist); } },
    embeddedVersion: () => "embedded-version",
    useBlobBackend: (backend) => { note("blob.backend", backend); }
  };
  return { ports, calls, shown, choices: actionNotices.shown };
}

function readFailure() {
  return Object.assign(new Error("locked"), { code: "read-failed", canExportRest: true });
}

test("only one export gathers data at a time", async () => {
  const { ports } = setup();
  const gate = deferred<undefined>();
  const started = deferred<undefined>();
  let reads = 0;
  const mounted = mountAppData({ ...ports, history: { ...ports.history, exportAll: async () => {
    reads++;
    started.resolve(undefined);
    await gate.promise;
    throw new Error("unavailable");
  } } });
  const first = mounted.exportAppData();
  await started.promise;
  const second = mounted.exportAppData();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reads, 1);
  } finally {
    gate.resolve(undefined);
    await Promise.all([first, second]);
    mounted.dispose();
  }
});

test("a new export dismisses the older prompt and invalidates its action", async () => {
  const { ports, choices } = setup();
  let deliveries = 0;
  const mounted = mountAppData({ ...ports,
    history: { ...ports.history, exportAll: (options) => options?.allowOmissions ? Promise.resolve({ docs: [], older: [{ stateJson: "fresh" }], omittedSnapshots: 1 }) : Promise.reject(readFailure()) },
    fileDelivery: { deliver: () => { deliveries++; return Promise.resolve(true); } }
  });
  try {
    await mounted.exportAppData();
    const old = choices[0];
    assert.ok(old?.action);
    await mounted.exportAppData();
    const current = choices[1];
    assert.ok(current?.action);
    assert.equal(old.notice.isConnected, false);
    await old.action();
    assert.equal(deliveries, 0);
    await Promise.all([current.action(), current.action()]);
    await old.action();
    await current.action();
    assert.equal(deliveries, 1);
  } finally { mounted.dispose(); }
});

test("an export stays exclusive until file delivery finishes", async () => {
  const { ports } = setup();
  const started = deferred<undefined>();
  const delivery = deferred<boolean>();
  let deliveries = 0;
  const mounted = mountAppData({ ...ports, fileDelivery: { deliver: () => { deliveries++; started.resolve(undefined); return delivery.promise; } } });
  const first = mounted.exportAppData();
  await started.promise;
  try {
    await mounted.exportAppData();
    assert.equal(deliveries, 1);
  } finally { delivery.resolve(true); await first; mounted.dispose(); }
});

test("temporary failures cancel with a retry message even during an opt-in rerun", async () => {
  for (const offerFirst of [false, true]) {
    const { ports, shown, choices } = setup();
    let deliveries = 0;
    const mounted = mountAppData({ ...ports,
      history: { ...ports.history, exportAll: (options) => Promise.reject(offerFirst && !options?.allowOmissions ? readFailure() : Object.assign(new Error("timed out"), { code: "temporary-read-failed" })) },
      fileDelivery: { deliver: () => { deliveries++; return Promise.resolve(true); } }
    });
    try {
      await mounted.exportAppData();
      if (offerFirst) { assert.ok(choices[0]?.action); await choices[0].action(); }
      assert.equal(choices.length, offerFirst ? 1 : 0);
      assert.equal(deliveries, 0);
      assert.deepEqual(shown.at(-1), ["Export cancelled — history or image data could not be read right now. Please try again. Nothing was downloaded.", "error"]);
    } finally { mounted.dispose(); }
  }
});

test("read failure offers an explicit choice and downloads the readable data only once after choosing", async () => {
  const { ports, shown, choices } = setup();
  const delivered: string[] = [];
  const partial = { docs: [{ snapshots: [{ stateJson: "readable" }] }], older: [], omittedSnapshots: 2, missingBlobs: ["unreadable-image"] };
  const modes: boolean[] = [];
  const mounted = mountAppData({ ...ports,
    history: { ...ports.history, exportAll: (options) => { modes.push(options?.allowOmissions === true); return options?.allowOmissions ? Promise.resolve(partial) : Promise.reject(readFailure()); } },
    fileDelivery: { deliver: (_name, text) => { delivered.push(String(text)); return Promise.resolve(true); } }
  });
  try {
    await mounted.exportAppData();
    assert.deepEqual(delivered, []);
    assert.equal(choices.length, 1);
    const choice = choices[0];
    assert.equal(choice?.label, "Export the rest anyway");
    assert.ok(choice?.action);
    partial.docs[0]?.snapshots.push({ stateJson: "added after the prompt" });
    partial.omittedSnapshots = 3;
    partial.missingBlobs.push("another-unreadable-image");
    await Promise.all([choice.action(), choice.action()]);
    await choice.action();
    assert.equal(delivered.length, 1);
    assert.deepEqual(modes, [false, true]);
    const bundle = JSON.parse(delivered[0] || "null") as { history: typeof partial; missingBlobs: string[] };
    assert.equal(bundle.history.docs[0]?.snapshots[0]?.stateJson, "readable");
    assert.equal(bundle.history.docs[0]?.snapshots[1]?.stateJson, "added after the prompt");
    assert.equal(bundle.history.omittedSnapshots, 3);
    assert.deepEqual(bundle.missingBlobs, ["unreadable-image", "another-unreadable-image"]);
    assert.match(shown.at(-1)?.[0] || "", /3 damaged or unreadable history snapshots/);
    assert.match(shown.at(-1)?.[0] || "", /2 images were missing or unreadable/);
  } finally { mounted.dispose(); }
});

test("dismissing the partial-export choice never downloads a file", async () => {
  const { ports, choices } = setup();
  let deliveries = 0;
  const partial = { docs: [], older: [{ stateJson: "readable" }], omittedSnapshots: 1 };
  const mounted = mountAppData({ ...ports,
    history: { ...ports.history, exportAll: (options) => options?.allowOmissions ? Promise.resolve(partial) : Promise.reject(readFailure()) },
    fileDelivery: { deliver: () => { deliveries++; return Promise.resolve(true); } }
  });
  try {
    await mounted.exportAppData();
    assert.equal(choices.length, 1);
    choices[0]?.notice.dismiss();
    assert.equal(deliveries, 0);
  } finally { mounted.dispose(); }
});

test("an empty remainder or unavailable store never offers a partial export", async () => {
  for (const error of [
    Object.assign(new Error("locked"), { code: "read-failed", canExportRest: false }),
    Object.assign(new Error("store unavailable"), { code: "io" })
  ]) {
    const { ports, choices } = setup();
    let deliveries = 0;
    const mounted = mountAppData({ ...ports,
      history: { ...ports.history, exportAll: () => Promise.reject(error) },
      fileDelivery: { deliver: () => { deliveries++; return Promise.resolve(true); } }
    });
    try {
      await mounted.exportAppData();
      assert.equal(choices.length, 0);
      assert.equal(deliveries, 0);
    } finally { mounted.dispose(); }
  }
});

test("disposing the feature dismisses its partial-export choice and prevents stale delivery", async () => {
  const { ports, choices } = setup();
  let deliveries = 0;
  const partial = { docs: [], older: [{ stateJson: "readable" }], omittedSnapshots: 1 };
  const mounted = mountAppData({ ...ports,
    history: { ...ports.history, exportAll: (options) => options?.allowOmissions ? Promise.resolve(partial) : Promise.reject(readFailure()) },
    fileDelivery: { deliver: () => { deliveries++; return Promise.resolve(true); } }
  });
  await mounted.exportAppData();
  const choice = choices[0];
  assert.ok(choice?.action);
  mounted.dispose();
  assert.equal(choice.notice.isConnected, false);
  await choice.action();
  assert.equal(deliveries, 0);
});

test("disposing while the opt-in rerun gathers prevents delivery after its reads finish", async () => {
  const { ports, choices } = setup();
  const reading = deferred<Awaited<ReturnType<AppDataPorts["history"]["exportAll"]>>>();
  const started = deferred<undefined>();
  let deliveries = 0;
  const mounted = mountAppData({ ...ports,
    history: { ...ports.history, exportAll: (options) => {
      if (!options?.allowOmissions) return Promise.reject(readFailure());
      started.resolve(undefined);
      return reading.promise;
    } },
    fileDelivery: { deliver: () => { deliveries++; return Promise.resolve(true); } }
  });
  try {
    await mounted.exportAppData();
    assert.ok(choices[0]?.action);
    const rerun = choices[0].action();
    await started.promise;
    mounted.dispose();
    reading.resolve({ docs: [], older: [{ stateJson: "readable" }], omittedSnapshots: 1 });
    await rerun;
    assert.equal(deliveries, 0);
  } finally { mounted.dispose(); }
});

test("the partial export is checked for credentials again when the user chooses it", async () => {
  const { ports, choices, shown } = setup();
  const prefs: Record<string, unknown> = {};
  let deliveries = 0;
  const partial = { docs: [], older: [{ stateJson: "readable" }], omittedSnapshots: 1 };
  const mounted = mountAppData({ ...ports,
    preferences: { ...ports.preferences, appDataExport: () => prefs },
    history: { ...ports.history, exportAll: (options) => options?.allowOmissions ? Promise.resolve(partial) : Promise.reject(readFailure()) },
    fileDelivery: { deliver: () => { deliveries++; return Promise.resolve(true); } }
  });
  try {
    await mounted.exportAppData();
    const choice = choices[0];
    assert.ok(choice?.action);
    prefs.apiKey = "must not leave the app";
    await choice.action();
    assert.equal(deliveries, 0);
    assert.match(shown.at(-1)?.[0] || "", /credential \(apiKey\)/);
  } finally { mounted.dispose(); }
});

test("history read failures cancel app-data delivery", async () => {
  const { ports, shown } = setup();
  let deliveries = 0;
  const mounted = mountAppData({ ...ports,
    history: { ...ports.history, exportAll: () => Promise.reject(new Error("unreadable")) },
    fileDelivery: { deliver: () => { deliveries++; return Promise.resolve(true); } }
  });
  try {
    await mounted.exportAppData();
    assert.equal(deliveries, 0);
    assert.deepEqual(shown.at(-1), ["Export cancelled — history or image data could not be read. Nothing was downloaded.", "error"]);
  } finally { mounted.dispose(); }
});

test("a partial history export delivers intact data with an explicit damage warning", async () => {
  const { ports, shown } = setup();
  let delivered = "", savedMessage = "";
  const mounted = mountAppData({ ...ports,
    history: { ...ports.history, exportAll: () => Promise.resolve({ docs: [{ snapshots: [{ stateJson: "intact" }] }], older: [], omittedSnapshots: 1 }) },
    fileDelivery: { deliver: (_name, data, options) => { delivered = String(data); savedMessage = options?.savedMsg || ""; return Promise.resolve(true); } }
  });
  try {
    await mounted.exportAppData();
    const bundle = JSON.parse(delivered) as { history: { docs: unknown[]; omittedSnapshots: number } };
    assert.deepEqual(bundle.history.docs, [{ snapshots: [{ stateJson: "intact" }] }]);
    assert.equal(bundle.history.omittedSnapshots, 1);
    assert.equal(savedMessage, "Exported your Splitpage app data with omissions");
    assert.deepEqual(shown.at(-1), ["Exported, but 1 damaged or unreadable history snapshot could not be included. Intact versions and their available images are included.", "warn"]);
  } finally { mounted.dispose(); }
});

test("damage without any exportable history cancels delivery", async () => {
  const { ports, shown } = setup();
  let deliveries = 0;
  const mounted = mountAppData({ ...ports,
    history: { ...ports.history, exportAll: () => Promise.resolve({ docs: [], older: [], omittedSnapshots: 2 }) },
    fileDelivery: { deliver: () => { deliveries++; return Promise.resolve(true); } }
  });
  try {
    await mounted.exportAppData();
    assert.equal(deliveries, 0);
    assert.deepEqual(shown.at(-1), ["Export cancelled — history or image data could not be read. Nothing was downloaded.", "error"]);
  } finally { mounted.dispose(); }
});

test("export size limits are disclosed alongside damage and missing images", async () => {
  const { ports, shown } = setup();
  const mounted = mountAppData({ ...ports,
    history: { ...ports.history, exportAll: () => Promise.resolve({ docs: [{ snapshots: [{}] }], older: [], omittedSnapshots: 2, truncated: true, missingBlobs: ["missing"] }) }
  });
  try {
    await mounted.exportAppData();
    const warning = shown.at(-1);
    assert.equal(warning?.[1], "warn");
    assert.match(warning?.[0] || "", /1 image was missing/);
    assert.match(warning?.[0] || "", /2 damaged or unreadable history snapshots/);
    assert.match(warning?.[0] || "", /older history snapshots were left out/);
  } finally { mounted.dispose(); }
});

test("app data export reads legacy storage, history and preferences in the same order, and writes no server bookmarks", async () => {
  const { ports, calls } = setup();
  const storage = Object.getPrototypeOf(localStorage) as Storage;
  const getItem = storage.getItem;
  storage.getItem = function (key: string): string | null {
    calls.push({ name: "storage.get", args: [key] });
    return getItem.call(this, key);
  };
  localStorage.setItem("splitpage-server-bookmarks", JSON.stringify([{ name: "Team", url: "https://server.test/" }]));
  calls.length = 0;
  const mounted = mountAppData(ports);
  try {
    const bundle = await probe().build();
    assert.equal(bundle.appVersion, "embedded-version");
    assert.equal("bookmarks" in bundle, false);
    assert.deepEqual(calls.map((call) => call.name), ["storage.get", "history.export", "preferences.export"]);
    assert.deepEqual(calls[0]?.args, ["splitpage-snapshots"]);
    const extra = calls[2]?.args[0] as readonly { readonly name: string }[];
    assert.equal(extra[0]?.name, "theme");
    assert.equal(extra.at(-1)?.name, "scriptScale");
  } finally {
    storage.getItem = getItem;
    mounted.dispose();
  }
});

test("app data import preserves each history, preference and writer call and argument, and ignores old server bookmarks", async () => {
  const { ports, calls, shown } = setup();
  const mounted = mountAppData(ports);
  const snapshots = [{ old: "snapshot" }];
  const docs = [{ docId: "doc", title: "Title", lastOpenedAt: 3, snapshots: [] }];
  const older = [{ old: "history" }];
  try {
    await probe().importText(JSON.stringify({
      format: "splitpage-app-data", version: 1, snapshots,
      history: { docs, older }, blobs: {},
      bookmarks: [{ name: "Server", url: "https://server.test", ssh: { userHost: "adam@server", remotePort: "9000", localPort: 9001 } }],
      prefs: { commentsSort: "recent", writerSize: "20" }
    }));
    assert.deepEqual(calls.map((call) => call.name), ["history.normalize", "history.import", "preferences.import", "preferences.commentsSort", "comments.choose", "writer.read", "writer.apply"]);
    assert.deepEqual(calls[0]?.args, [JSON.stringify(snapshots)]);
    assert.deepEqual(calls[1]?.args, [{ docs, older: [...older, { legacy: true }], blobs: {} }]);
    assert.deepEqual(calls[4]?.args, ["recent"]);
    assert.deepEqual(calls[6]?.args, [20, false]);
    const incoming = calls[2]?.args[0] as Record<string, unknown>;
    assert.equal(incoming.commentsSort, "recent");
    assert.equal(incoming.writerSize, "20");
    assert.equal(localStorage.getItem("splitpage-server-bookmarks"), null);
    assert.deepEqual(shown, [["Imported 1 version-history snapshot across 1 document and your preferences.", "ok"]]);
  } finally {
    mounted.dispose();
  }
});

test("app data mount releases the lazy change listener and probe across dispose and remount", () => {
  const { ports, calls } = setup();
  const input = document.getElementById("import-app-data-input");
  assert.ok(input);
  const events: string[] = [];
  const add = input.addEventListener.bind(input);
  const remove = input.removeEventListener.bind(input);
  input.addEventListener = (...args: Parameters<typeof add>) => { events.push("add " + args[0]); add(...args); };
  input.removeEventListener = (...args: Parameters<typeof remove>) => { events.push("remove " + args[0]); remove(...args); };
  for (let i = 0; i < 2; i++) {
    const mounted = mountAppData(ports);
    assert.equal(probe().useBlobBackend(null), true);
    mounted.openImportAppData();
    mounted.openImportAppData();
    mounted.dispose();
    mounted.dispose();
    mounted.openImportAppData();
    assert.equal("__appDataTest" in window, false);
  }
  assert.deepEqual(events, ["add change", "remove change", "add change", "remove change"]);
  assert.deepEqual(calls, [{ name: "blob.backend", args: [null] }, { name: "blob.backend", args: [null] }]);
});

test("app data actions invoke their mounted controls and retain import visibility", () => {
  const calls: string[] = [];
  let shown = false;
  const definitions = appDataActions(() => ({ exportAppData: () => { calls.push("export"); return Promise.resolve(); }, openImportAppData: () => { calls.push("import"); }, dispose: () => undefined }), { screen: () => ({}) as ScreenState, importShown: () => shown });
  assert.deepEqual(definitions.map((definition) => definition.id), ["export-app-data", "import-app-data"]);
  for (const definition of definitions) void definition.run("button");
  assert.deepEqual(calls, ["export", "import"]);
  const availability = definitions[1]?.availability;
  assert.ok(availability);
  assert.equal(availability("button").visible, false);
  shown = true;
  assert.notEqual(availability("button").visible, false);
});

test("app data pickers refuse dialogs and tours while retaining loading and import visibility safeguards", () => {
  const view = fakeScreen();
  let shown = true;
  const calls: string[] = [];
  const current: AppDataMount = { exportAppData: async () => { calls.push("export"); }, openImportAppData: () => { calls.push("import"); }, dispose: () => undefined };
  const registry = createActionRegistry();
  for (const action of appDataActions(() => current, { screen: view.screen, importShown: () => shown })) registry.register(action);
  for (const blocker of ["dialog", "tour", "loading"] as const) {
    view.state[blocker] = true;
    for (const id of ["export-app-data", "import-app-data"]) assert.equal(registry.invoke(id, "native-menu").kind, "unavailable", blocker + ":" + id);
    view.state[blocker] = false;
  }
  assert.deepEqual(calls, []);
  shown = false;
  assert.equal(registry.view("import-app-data")?.visible, false);
  shown = true;
  for (const blocker of ["writer", "prompter", "shotlist"] as const) {
    view.state[blocker] = true;
    for (const id of ["export-app-data", "import-app-data"]) assert.equal(registry.view(id)?.enabled, true);
    view.state[blocker] = false;
  }
});

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("No promise"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const emptyBundle = JSON.stringify({ format: "splitpage-app-data", version: 1, history: { docs: [], older: [] }, prefs: {} });

test("a pending history export completes through its original ports after dispose and remount", async () => {
  const original = setup();
  const history = deferred<Awaited<ReturnType<AppDataPorts["history"]["exportAll"]>>>();
  const mounted = mountAppData({ ...original.ports, history: { ...original.ports.history, exportAll: () => history.promise } } satisfies AppDataPorts);
  const building = probe().build();
  mounted.dispose();
  const replacement = setup();
  const next = mountAppData(replacement.ports);
  history.resolve({ docs: [], older: [] });
  await building;
  assert.deepEqual(original.calls.map((call) => call.name), ["preferences.export"]);
  assert.deepEqual(replacement.calls, []);
  next.dispose();
});

test("a pending history import finishes the required preference writes through its original ports", async () => {
  const original = setup();
  const history = deferred<Awaited<ReturnType<AppDataPorts["history"]["importBundle"]>>>();
  const mounted = mountAppData({ ...original.ports, history: { ...original.ports.history, importBundle: () => history.promise } } satisfies AppDataPorts);
  const importing = probe().importText(emptyBundle);
  mounted.dispose();
  const replacement = setup();
  const next = mountAppData(replacement.ports);
  history.resolve({ docs: 0, added: 0, older: 0, skipped: 0, failed: 0, blobs: { stored: 0, refused: [], failed: [] } });
  await importing;
  assert.deepEqual(original.calls.map((call) => call.name), ["preferences.import", "preferences.commentsSort", "comments.choose", "writer.read", "writer.apply"]);
  assert.deepEqual(replacement.calls, []);
  next.dispose();
});

test("a pending file delivery finishes without replacing the next mount's export summary", async () => {
  const original = setup();
  const delivery = deferred<boolean>();
  const started = deferred<boolean>();
  const mounted = mountAppData({ ...original.ports, fileDelivery: { deliver: () => { started.resolve(true); return delivery.promise; } } } satisfies AppDataPorts);
  const exporting = mounted.exportAppData();
  await started.promise;
  mounted.dispose();
  const replacement = setup();
  const next = mountAppData(replacement.ports);
  delivery.resolve(true);
  await exporting;
  assert.deepEqual(replacement.calls, []);
  const state = (window as unknown as { readonly __appDataTest: { readonly exportSummary: () => unknown } }).__appDataTest;
  assert.equal(state.exportSummary(), null);
  next.dispose();
});

test("a pending file read imports through its original ports after remount", async () => {
  const original = setup();
  const text = deferred<string>();
  const mounted = mountAppData(original.ports);
  mounted.openImportAppData();
  const input = document.getElementById("import-app-data-input") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [{ size: 10, text: () => text.promise }] });
  input.dispatchEvent(new window.Event("change"));
  mounted.dispose();
  const replacement = setup();
  const next = mountAppData(replacement.ports);
  text.resolve(emptyBundle);
  await new Promise<void>((done) => setTimeout(done, 0));
  assert.deepEqual(original.calls.map((call) => call.name), ["history.import", "preferences.import", "preferences.commentsSort", "comments.choose", "writer.read", "writer.apply"]);
  assert.deepEqual(replacement.calls, []);
  next.dispose();
});

test("app data actions refuse before the feature mounts and after its wiring stops", () => {
  stopAppDataFeature();
  const registry = createActionRegistry();
  for (const definition of wiredAppDataActions()) registry.register(definition);
  const ids = ["export-app-data", "import-app-data"];
  const refuse = (): void => {
    for (const id of ids) {
      assert.equal(registry.view(id)?.enabled, false);
      assert.equal(registry.invoke(id, "button").kind, "unavailable");
    }
  };
  refuse();
  mountAppDataFeature();
  stopAppDataFeature();
  refuse();
});

test("mounted app data actions retain loading refusal, import visibility and invocation", () => {
  const calls: string[] = [];
  let loading = false;
  let shown = true;
  const controls: AppDataMount = {
    exportAppData: () => { calls.push("export"); return Promise.resolve(); },
    openImportAppData: () => { calls.push("import"); },
    dispose: () => undefined
  };
  let current: AppDataMount | null = null;
  const registry = createActionRegistry();
  for (const definition of appDataActions(() => current, { screen: () => ({ loading }) as ScreenState, importShown: () => shown })) registry.register(definition);
  const ids = ["export-app-data", "import-app-data"];
  for (const id of ids) {
    assert.equal(registry.view(id)?.enabled, false);
    assert.equal(registry.invoke(id, "button").kind, "unavailable");
  }
  current = controls;
  for (const id of ids) {
    assert.equal(registry.view(id)?.enabled, true);
    assert.equal(registry.view(id)?.visible, true);
    assert.equal(registry.invoke(id, "button").kind, "ran");
  }
  assert.deepEqual(calls, ["export", "import"]);
  loading = true;
  for (const id of ids) {
    assert.equal(registry.view(id)?.reason, "Still loading…");
    assert.equal(registry.invoke(id, "button").kind, "unavailable");
  }
  loading = false;
  shown = false;
  assert.equal(registry.view("import-app-data")?.visible, false);
  assert.equal(registry.view("export-app-data")?.visible, true);
  current = null;
  for (const id of ids) assert.equal(registry.invoke(id, "button").kind, "unavailable");
  assert.deepEqual(calls, ["export", "import"]);
});
