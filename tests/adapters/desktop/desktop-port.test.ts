import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  DESKTOP_PORT_MEMBERS, UNUSED_DESKTOP_MEMBERS, attachDesktop, desktopDrive, desktopPort, restoreDesktop, useDesktopForTest
} from "../../../src/adapters/desktop/desktop-port.ts";
import type { DesktopMember, DesktopPort } from "../../../src/adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../../../src/application/desktop-presence.ts";

const require = createRequire(import.meta.url);
const PRELOAD = fileURLToPath(new URL("../../../desktop/preload.js", import.meta.url));
const { APP_ORIGIN, channelsForOrigin } = require("../../../desktop/ipc-channels.js") as {
  APP_ORIGIN: string;
  channelsForOrigin: (origin: string) => readonly { name: string; direction: string }[];
};

interface Wire {
  readonly direction: "invoke" | "send";
  readonly name: string;
  readonly args: readonly unknown[];
}

interface Loaded {
  readonly bridge: Record<string, unknown>;
  readonly wires: Wire[];
  readonly deliver: (name: string, ...args: unknown[]) => void;
}

const BOOT = {
  tabId: "tab-1",
  windowId: "win-1",
  launchIntent: { type: "open-file" },
  connection: { serverUrl: "http://studio.local:8080", token: "tok", tunnel: null },
  hadPriorSession: true,
  firstTabOfLaunch: true,
  hasDraftToRestore: true
};

function loadPreload(testMode: boolean, answers: Record<string, unknown> = {}): Loaded {
  const wires: Wire[] = [];
  const receivers = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  let exposed: Record<string, unknown> | null = null;
  const sync: Record<string, unknown> = {
    "splitpage:ipc-table-sync": channelsForOrigin(APP_ORIGIN),
    "splitpage:get-app-version-sync": "4.1.0-test",
    "splitpage:tab-boot-sync": BOOT,
    "splitpage:is-test-mode-sync": testMode
  };
  const electron = {
    contextBridge: { exposeInMainWorld: (key: string, value: Record<string, unknown>) => { if (key === "splitpageDesktop") exposed = value; } },
    webUtils: { getPathForFile: (file: { path?: string }) => file.path || "" },
    ipcRenderer: {
      sendSync: (name: string) => sync[name],
      invoke: (name: string, ...args: unknown[]) => { wires.push({ direction: "invoke", name, args }); return Promise.resolve(name in answers ? answers[name] : null); },
      send: (name: string, ...args: unknown[]) => { wires.push({ direction: "send", name, args }); },
      on: (name: string, handler: (event: unknown, ...args: unknown[]) => void) => { receivers.set(name, handler); }
    }
  };
  vm.runInNewContext(readFileSync(PRELOAD, "utf8"), {
    require: (id: string) => { assert.equal(id, "electron"); return electron; },
    location: { origin: APP_ORIGIN },
    process: { platform: "testos" },
    Uint8Array
  });
  assert.ok(exposed, "the preload script exposes splitpageDesktop");
  return {
    bridge: exposed,
    wires,
    deliver: (name, ...args) => {
      const handler = receivers.get(name);
      assert.ok(handler, "the preload script listens on " + name);
      handler({}, ...args);
    }
  };
}

const sorted = (names: Iterable<string>): string[] => [...names].sort();

test("every member the preload script exposes is on the port or listed as unused, and nothing else is", () => {
  const exposed = Object.keys(loadPreload(true).bridge);
  assert.deepEqual(sorted(exposed), sorted([...DESKTOP_PORT_MEMBERS, ...UNUSED_DESKTOP_MEMBERS]));
  assert.equal(new Set(DESKTOP_PORT_MEMBERS).size, DESKTOP_PORT_MEMBERS.length);
  for (const name of UNUSED_DESKTOP_MEMBERS) assert.equal((DESKTOP_PORT_MEMBERS as readonly string[]).includes(name), false, name);
});

test("outside test mode the preload script exposes exactly the port", () => {
  assert.deepEqual(sorted(Object.keys(loadPreload(false).bridge)), sorted(DESKTOP_PORT_MEMBERS));
});

test("the port's values come from the tab's boot answer", () => {
  const b = loadPreload(false).bridge as unknown as DesktopPort;
  assert.equal(b.isDesktop, true);
  assert.equal(b.platform, "testos");
  assert.equal(b.appVersion, "4.1.0-test");
  assert.equal(b.tabId, "tab-1");
  assert.equal(b.windowId, "win-1");
  assert.deepEqual({ ...b.launchIntent }, { type: "open-file" });
  assert.deepEqual({ ...b.connection }, { serverUrl: "http://studio.local:8080", token: "tok", tunnel: null });
  assert.equal(b.hadPriorSession, true);
  assert.equal(b.firstTabOfLaunch, true);
  assert.equal(b.hasDraftToRestore, true);
});

type Call = {
  readonly args: readonly unknown[];
  readonly direction: "invoke" | "send";
  readonly channel: string;
  readonly wire?: readonly unknown[];
};

const CALLS: Partial<Record<DesktopMember, Call>> = {
  openFileDialog: { args: [], direction: "invoke", channel: "splitpage:open-file-dialog" },
  saveFileDialog: { args: [{ suggestedName: "a.splitpage" }], direction: "invoke", channel: "splitpage:save-file-dialog" },
  readFile: { args: ["f1"], direction: "invoke", channel: "splitpage:read-file" },
  writeFile: { args: ["f1", new Uint8Array([1])], direction: "invoke", channel: "splitpage:write-file" },
  statFile: { args: ["f1"], direction: "invoke", channel: "splitpage:stat-file" },
  routeOpen: { args: [{ kind: "file", fileId: "f1" }], direction: "invoke", channel: "splitpage:route-open" },
  listRecents: { args: [], direction: "invoke", channel: "splitpage:recents-list" },
  removeRecent: { args: ["f1"], direction: "invoke", channel: "splitpage:recents-remove" },
  clearRecents: { args: [], direction: "invoke", channel: "splitpage:recents-clear" },
  setDocumentState: { args: [{ title: "T" }], direction: "send", channel: "splitpage:set-document-state" },
  writeDraft: { args: [{ seq: 1 }], direction: "invoke", channel: "splitpage:draft-write" },
  discardDraft: { args: [4], direction: "invoke", channel: "splitpage:draft-discard", wire: [{ seq: 4 }] },
  takeDraft: { args: [], direction: "invoke", channel: "splitpage:draft-take" },
  draftRestoreDone: { args: ["restored"], direction: "send", channel: "splitpage:draft-restore-done", wire: [{ outcome: "restored" }] },
  historyPut: { args: ["d1", { at: 1 }, "{}", { protect: ["s1"], older: true }], direction: "invoke", channel: "splitpage:history-put", wire: ["d1", { at: 1 }, "{}", { protect: ["s1"], older: true }] },
  historyList: { args: ["d1"], direction: "invoke", channel: "splitpage:history-list" },
  historyGet: { args: [{ docId: "d1" }, "s1"], direction: "invoke", channel: "splitpage:history-get" },
  historyCopy: { args: ["d1", "d2"], direction: "invoke", channel: "splitpage:history-copy" },
  historyTouch: { args: ["d1", "Title"], direction: "invoke", channel: "splitpage:history-touch" },
  historyListDocs: { args: [], direction: "invoke", channel: "splitpage:history-list-docs" },
  blobPut: { args: ["sha", new Uint8Array([2])], direction: "invoke", channel: "splitpage:blob-put" },
  blobGet: { args: ["sha"], direction: "invoke", channel: "splitpage:blob-get" },
  blobMissing: { args: [["a", "b"]], direction: "invoke", channel: "splitpage:blob-missing" },
  getSessionInfo: { args: [], direction: "invoke", channel: "splitpage:get-session-info" },
  openExternal: { args: ["https://example.com/"], direction: "send", channel: "splitpage:open-external" },
  setTheme: { args: ["dark"], direction: "send", channel: "splitpage:set-theme" },
  grantVideoFile: { args: [{ path: "/videos/a.mp4" }], direction: "invoke", channel: "splitpage:video-file-grant", wire: ["/videos/a.mp4"] },
  openVideoFile: { args: ["tok"], direction: "invoke", channel: "splitpage:video-file-open" },
  videoThumbnail: { args: ["youtube", "abc"], direction: "invoke", channel: "splitpage:video-thumbnail" },
  getUpdateStatus: { args: [], direction: "invoke", channel: "splitpage:update-status" },
  checkForUpdate: { args: [], direction: "invoke", channel: "splitpage:update-check" },
  downloadUpdate: { args: [], direction: "invoke", channel: "splitpage:update-download" },
  installUpdate: { args: [], direction: "invoke", channel: "splitpage:update-install" },
  openPrompterInBrowser: { args: [], direction: "invoke", channel: "splitpage:prompter-open-in-browser" },
  openPrompterInChromium: { args: [], direction: "invoke", channel: "splitpage:prompter-open-in-chromium" },
  voiceStatus: { args: [], direction: "invoke", channel: "splitpage:voice-status" },
  voiceStart: { args: [], direction: "invoke", channel: "splitpage:voice-start" },
  voiceStop: { args: [], direction: "invoke", channel: "splitpage:voice-stop" },
  driveStatus: { args: [], direction: "invoke", channel: "splitpage:drive-status" },
  driveSignIn: { args: [], direction: "invoke", channel: "splitpage:drive-sign-in" },
  driveSignOut: { args: [], direction: "invoke", channel: "splitpage:drive-sign-out" },
  driveList: { args: ["folder-1"], direction: "invoke", channel: "splitpage:drive-list" },
  driveDownload: { args: ["file-1"], direction: "invoke", channel: "splitpage:drive-download" },
  driveUpload: { args: [{ name: "a.splitpage" }], direction: "invoke", channel: "splitpage:drive-upload" }
};

const LISTENERS: Partial<Record<DesktopMember, { readonly channel: string; readonly payload: readonly unknown[]; readonly heard: unknown }>> = {
  onOpenServerDoc: { channel: "splitpage:open-server-doc", payload: [{ serverDocId: "s1" }], heard: { serverDocId: "s1" } },
  onRestoreNotice: { channel: "splitpage:restore-notice", payload: [{ skipped: [] }], heard: { skipped: [] } },
  onReassignDocId: { channel: "splitpage:reassign-doc-id", payload: [{ toId: "d2" }], heard: { toId: "d2" } },
  onOpenFile: { channel: "splitpage:open-file", payload: [{ id: "f1", name: "a.splitpage" }], heard: { id: "f1", name: "a.splitpage" } },
  onMenuCommand: { channel: "splitpage:menu-command", payload: ["save"], heard: "save" },
  onUpdateStatus: { channel: "splitpage:update-status", payload: [{ checking: true }], heard: { checking: true } },
  onVoiceEvent: { channel: "splitpage:voice-event", payload: [{ type: "start" }], heard: { type: "start" } },
  onDraftFlush: { channel: "splitpage:draft-flush", payload: [7, true], heard: { keep: true } }
};

const VALUES: readonly DesktopMember[] = [
  "isDesktop", "platform", "appVersion", "tabId", "windowId", "launchIntent", "connection",
  "hadPriorSession", "firstTabOfLaunch", "hasDraftToRestore"
];

test("every port member is a value, a call or a listener, and the tables name only port members", () => {
  const covered = [...VALUES, ...Object.keys(CALLS), ...Object.keys(LISTENERS)];
  assert.deepEqual(sorted(covered), sorted(DESKTOP_PORT_MEMBERS));
});

for (const [name, call] of Object.entries(CALLS) as [DesktopMember, Call][]) {
  test("port call " + name + " crosses on " + call.channel + " (" + call.direction + ")", async () => {
    const { bridge, wires } = loadPreload(false);
    const fn = bridge[name] as (...args: unknown[]) => unknown;
    assert.equal(typeof fn, "function");
    await fn(...call.args);
    const crossed = wires.filter((w) => w.name !== "splitpage:renderer-ready")
      .map((w) => ({ direction: w.direction, name: w.name, args: structuredClone(w.args) }));
    assert.deepEqual(crossed, [{ direction: call.direction, name: call.channel, args: call.wire || call.args }]);
  });
}

for (const [name, listener] of Object.entries(LISTENERS) as [DesktopMember, { channel: string; payload: unknown[]; heard: unknown }][]) {
  test("port listener " + name + " hears " + listener.channel, async () => {
    const { bridge, deliver } = loadPreload(false);
    const heard: unknown[] = [];
    (bridge[name] as (cb: (value: unknown) => void) => void)((value) => { heard.push(value); });
    deliver(listener.channel, ...listener.payload);
    await Promise.resolve();
    assert.deepEqual(structuredClone(heard), [listener.heard]);
  });
}

test("readFile, takeDraft, blobGet and videoThumbnail hand back bytes as a Uint8Array", async () => {
  const { bridge } = loadPreload(false, {
    "splitpage:read-file": { id: "f1", name: "a", bytes: [1, 2] },
    "splitpage:draft-take": { file: { id: "f1", name: "a", bytes: [3] } },
    "splitpage:blob-get": { bytes: [4] },
    "splitpage:video-thumbnail": { ok: true, bytes: [5] }
  });
  const port = bridge as unknown as DesktopPort;
  assert.ok((await port.readFile("f1")).bytes instanceof Uint8Array);
  assert.ok((await port.takeDraft())?.file?.bytes instanceof Uint8Array);
  assert.ok((await port.blobGet("sha"))?.bytes instanceof Uint8Array);
  assert.ok((await port.videoThumbnail("youtube", "abc")).bytes instanceof Uint8Array);
});

test("a page with no desktop bridge has no port and is not running on desktop", () => {
  attachDesktop(undefined);
  assert.equal(desktopPort(), null);
  assert.equal(runningOnDesktop(), false);
});

test("the attached bridge is the port, and the test seam swaps it and restores it", () => {
  const real = loadPreload(false).bridge as unknown as DesktopPort;
  attachDesktop(real);
  assert.equal(desktopPort(), real);
  assert.equal(runningOnDesktop(), true);
  const fake = { readFile: async () => ({ id: "x", name: "x" }) };
  useDesktopForTest(fake);
  assert.equal(desktopPort(), fake);
  assert.equal(runningOnDesktop(), true);
  useDesktopForTest(null);
  assert.equal(desktopPort(), null);
  assert.equal(runningOnDesktop(), false);
  useDesktopForTest(undefined);
  assert.equal(desktopPort(), null);
  assert.equal(runningOnDesktop(), false);
  restoreDesktop();
  assert.equal(desktopPort(), real);
  assert.equal(runningOnDesktop(), true);
  attachDesktop(null);
});

test("the six Drive calls pass their argument and hand back the bridge's answer", async () => {
  const seen: unknown[] = [];
  const answer = (name: string) => async (...args: unknown[]) => { seen.push([name, ...args]); return { ok: true, from: name }; };
  useDesktopForTest({
    driveStatus: answer("driveStatus"), driveSignIn: answer("driveSignIn"), driveSignOut: answer("driveSignOut"),
    driveList: answer("driveList"), driveDownload: answer("driveDownload"), driveUpload: answer("driveUpload")
  });
  try {
    assert.deepEqual(await desktopDrive.status(), { ok: true, from: "driveStatus" });
    assert.deepEqual(await desktopDrive.signIn(), { ok: true, from: "driveSignIn" });
    assert.deepEqual(await desktopDrive.signOut(), { ok: true, from: "driveSignOut" });
    assert.deepEqual(await desktopDrive.list("folder"), { ok: true, from: "driveList" });
    assert.deepEqual(await desktopDrive.download("file"), { ok: true, from: "driveDownload" });
    assert.deepEqual(await desktopDrive.upload({ name: "a" }), { ok: true, from: "driveUpload" });
    assert.deepEqual(seen, [["driveStatus"], ["driveSignIn"], ["driveSignOut"], ["driveList", "folder"], ["driveDownload", "file"], ["driveUpload", { name: "a" }]]);
  } finally {
    restoreDesktop();
  }
});

test("a Drive call that answers nothing, throws, rejects or has no bridge reads as FAILED", async () => {
  const failed = { ok: false, code: "FAILED" };
  try {
    useDesktopForTest({ driveStatus: async () => null });
    assert.deepEqual(await desktopDrive.status(), failed);
    useDesktopForTest({ driveList: () => { throw new Error("boom"); } });
    assert.deepEqual(await desktopDrive.list("f"), failed);
    useDesktopForTest({ driveDownload: () => Promise.reject(new Error("gone")) });
    assert.deepEqual(await desktopDrive.download("f"), failed);
    useDesktopForTest({});
    assert.deepEqual(await desktopDrive.upload({}), failed);
    useDesktopForTest(null);
    assert.deepEqual(await desktopDrive.signIn(), failed);
  } finally {
    restoreDesktop();
  }
});
