import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { beginStartup, type StartupPorts } from "../../src/bootstrap/startup.ts";
import { BOOT_OPEN_REASON } from "../../src/bootstrap/startup/initial-document.ts";
import { whenDocumentReady } from "../../src/bootstrap/startup/dom-ready.ts";

interface Loaded {
  readonly title: string;
  readonly rev?: number;
  readonly lastEditedBy?: string;
}

interface Doc {
  readonly copyOf: string;
}

type Report = { readonly conflicts: number };

class FakeWindow extends EventTarget {
  readonly listeners = new Map<string, number>();
  readonly registered: string[] = [];
  readonly navigator: { serviceWorker?: { register: (url: string) => Promise<unknown> } };
  readonly location: { protocol: string };

  constructor(options: { serviceWorker?: boolean; protocol?: string } = {}) {
    super();
    this.navigator = options.serviceWorker === false ? {} : {
      serviceWorker: { register: (url) => { this.registered.push(url); return Promise.resolve(); } }
    };
    this.location = { protocol: options.protocol ?? "https:" };
  }

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) - 1);
    super.removeEventListener(type, listener, options);
  }

  count(type: string): number {
    return this.listeners.get(type) ?? 0;
  }
}

interface Held<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function held<T>(): Held<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Rig {
  readonly log: string[];
  readonly win: FakeWindow;
  readonly ports: StartupPorts<string, Loaded, Doc, Report>;
  live: unknown;
  dirty: boolean;
}

interface RigOptions {
  readonly desktop?: boolean;
  readonly taker?: (() => PromiseLike<string>) | null;
  readonly load?: (pristine: boolean) => PromiseLike<Loaded>;
  readonly pristine?: boolean;
  readonly report?: Report | null;
  readonly keepLive?: boolean;
  readonly win?: FakeWindow;
}

function rig(options: RigOptions = {}): Rig {
  const log: string[] = [];
  const win = options.win ?? new FakeWindow();
  const r: Rig = {
    log,
    win,
    live: null,
    dirty: false,
    ports: {
      desktop: options.desktop ?? false,
      draft: {
        taker: options.taker ?? null,
        detectServer: () => { log.push("detect-server"); },
        armServerResume: (draft) => { log.push(`arm:${String(draft)}`); },
        applyDraft: (draft) => { log.push(`apply-draft:${String(draft)}`); return "restored"; }
      },
      document: {
        pristine: () => options.pristine ?? false,
        load: options.load ?? ((pristine) => { log.push(pristine ? "load pristine" : "load"); return Promise.resolve({ title: "Seed" }); }),
        clone: (loaded) => { log.push("clone"); return { copyOf: loaded.title }; },
        applyStash: (loaded, opts) => {
          log.push(`stash:${opts.recovery}:${opts.report}`);
          const base = opts.newBase();
          const state = options.keepLive ? r.live as Doc : base;
          return { state, report: options.report ?? null };
        },
        liveDocument: () => r.live,
        open: (doc, reason) => { log.push(`open:${doc.copyOf}:${reason === BOOT_OPEN_REASON}`); r.live = doc; },
        firstDraw: () => { log.push("first-draw"); },
        refreshChrome: [
          () => { log.push("identity-chip"); },
          () => { log.push("autosave-menu"); },
          () => { log.push("hidden-shot-menu"); },
          () => { log.push("save-status"); }
        ],
        reportRecovery: (report) => { log.push(`report:${report.conflicts}`); },
        toastLastEditor: (loaded) => { log.push(`toast:${loaded.title}`); },
        resumeLastProject: () => { log.push("resume-last-project"); },
        syncIdentity: () => { log.push("sync-identity"); },
        openIdentityChannel: () => { log.push("identity-channel"); },
        notifyDesktop: () => { log.push("notify-desktop"); },
        startHistoryMigration: () => { log.push("history-migration"); }
      },
      page: {
        window: win as unknown as Window,
        snapshotKey: "snapshots",
        unsaved: () => r.dirty
      },
      startDesktop: () => { log.push("start-desktop"); }
    }
  };
  return r;
}

const ADOPTION = ["clone", "open:Seed:true", "first-draw", "identity-chip", "autosave-menu", "hidden-shot-menu", "save-status"];

test("in the browser: the server is detected first, then load, stash adoption, first draw, chrome, editor toast, last-project resume, identity and history", async () => {
  const r = rig();
  const startup = beginStartup(r.ports);
  try {
    assert.deepEqual(r.log, ["detect-server"]);
    const outcome = await startup.openDocument();
    assert.equal(outcome, undefined);
    assert.deepEqual(r.log, [
      "detect-server", "load", "stash:true:false", ...ADOPTION,
      "toast:Seed", "resume-last-project", "sync-identity", "identity-channel", "history-migration"
    ]);
  } finally {
    startup.dispose();
  }
});

test("the initial load is handed the seed check's answer, asked once, when the load starts", async () => {
  for (const pristine of [true, false]) {
    let asked = 0;
    const r = rig({ pristine });
    const ports = { ...r.ports, document: { ...r.ports.document, pristine: () => { asked++; r.log.push("seed-check"); return pristine; } } };
    const startup = beginStartup(ports);
    try {
      assert.equal(asked, 0, "the seed check waits for the load");
      await startup.openDocument();
      assert.equal(asked, 1);
      assert.deepEqual(r.log.slice(0, 3), ["detect-server", "seed-check", pristine ? "load pristine" : "load"]);
    } finally {
      startup.dispose();
    }
  }
});

test("on the desktop with a draft to restore: the draft is taken before the server is detected, then armed, detected and applied after the initial document", async () => {
  let took = 0;
  const r = rig({ desktop: true, taker: () => { took++; r.log.push("take-draft"); return Promise.resolve("draft-1"); } });
  const startup = beginStartup(r.ports);
  try {
    assert.equal(took, 0, "the draft is taken on the next microtask, as before");
    assert.deepEqual(r.log, []);
    const outcome = await startup.openDocument();
    assert.equal(outcome, "restored");
    assert.equal(took, 1);
    assert.deepEqual(r.log.filter((s) => s !== "take-draft"), [
      "load", "stash:true:false", ...ADOPTION,
      "toast:Seed", "sync-identity", "notify-desktop", "history-migration",
      "arm:draft-1", "detect-server", "apply-draft:draft-1"
    ]);
  } finally {
    startup.dispose();
  }
});

test("a draft that cannot be taken becomes null and still arms, detects and applies in that order", async () => {
  const r = rig({ desktop: true, taker: () => Promise.reject(new Error("locked")) });
  const startup = beginStartup(r.ports);
  try {
    await startup.openDocument();
    assert.deepEqual(r.log.slice(-3), ["arm:null", "detect-server", "apply-draft:null"]);
  } finally {
    startup.dispose();
  }
});

test("a recovered stash reports its merge, with no editor toast and no last-project resume", async () => {
  const r = rig({ report: { conflicts: 2 } });
  const startup = beginStartup(r.ports);
  try {
    await startup.openDocument();
    assert.ok(r.log.includes("report:2"));
    assert.ok(!r.log.some((s) => s.startsWith("toast:")));
    assert.ok(!r.log.includes("resume-last-project"));
  } finally {
    startup.dispose();
  }
});

test("a document written out before, or the desktop, does not resume the last project", async () => {
  for (const options of [
    { load: () => Promise.resolve({ title: "Seed", rev: 3 }) },
    { load: () => Promise.resolve({ title: "Seed", lastEditedBy: "Ana" }) },
    { desktop: true }
  ]) {
    const r = rig(options);
    const startup = beginStartup(r.ports);
    try {
      await startup.openDocument();
      assert.ok(!r.log.includes("resume-last-project"), JSON.stringify(options));
    } finally {
      startup.dispose();
    }
  }
});

test("a stash that leaves the live document in place opens nothing and still draws the first time", async () => {
  const r = rig({ keepLive: true });
  r.live = { copyOf: "already live" };
  const startup = beginStartup(r.ports);
  try {
    await startup.openDocument();
    assert.ok(!r.log.some((s) => s.startsWith("open:")));
    assert.ok(r.log.includes("first-draw"));
    assert.ok(r.log.includes("identity-chip"));
  } finally {
    startup.dispose();
  }
});

test("a failed initial load stops the chain before identity, history and the draft", async () => {
  const r = rig({ desktop: true, taker: () => Promise.resolve("draft-1"), load: () => Promise.reject(new Error("unreadable")) });
  const startup = beginStartup(r.ports);
  try {
    await assert.rejects(startup.openDocument(), /unreadable/);
    assert.deepEqual(r.log, []);
  } finally {
    startup.dispose();
  }
});

test("dispose while the load is held, then a remount: the stale load adopts nothing and only the new startup's work runs", async () => {
  const first = held<Loaded>();
  const r1 = rig({ desktop: true, taker: () => Promise.resolve("old draft"), load: () => first.promise });
  const old = beginStartup(r1.ports);
  const oldOpening = old.openDocument();
  old.dispose();

  const r2 = rig({ desktop: true, taker: () => Promise.resolve("new draft") });
  const fresh = beginStartup(r2.ports);
  try {
    assert.equal(await fresh.openDocument(), "restored");
    first.resolve({ title: "Stale" });
    await oldOpening;
    assert.deepEqual(r1.log, [], "the disposed startup adopts, sets up and applies nothing");
    assert.ok(r2.log.includes("apply-draft:new draft"));
    assert.ok(!r2.log.some((s) => s.includes("old draft") || s.includes("Stale")));
  } finally {
    fresh.dispose();
  }
});

test("dispose after the document opens but before the draft resumes: the draft is not applied", async () => {
  const draft = held<string>();
  const r = rig({ desktop: true, taker: () => draft.promise });
  const startup = beginStartup(r.ports);
  const opening = startup.openDocument();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(r.log.includes("history-migration"), "the document opened while the draft is held");
  startup.dispose();
  draft.resolve("late");
  await opening;
  assert.ok(r.log.includes("history-migration"));
  assert.ok(!r.log.some((s) => s.startsWith("arm:") || s.startsWith("apply-draft:")));
});

test("a normal completion is the control: identity, history and the draft all run once", async () => {
  const r = rig({ desktop: true, taker: () => Promise.resolve("d") });
  const startup = beginStartup(r.ports);
  try {
    await startup.openDocument();
    for (const step of ["sync-identity", "history-migration", "arm:d", "apply-draft:d"]) {
      assert.equal(r.log.filter((s) => s === step).length, 1, step);
    }
  } finally {
    startup.dispose();
  }
});

test("finish registers one storage, one beforeunload and one load listener; dispose removes them and a remount registers exactly one again", () => {
  const win = new FakeWindow();
  for (let round = 0; round < 3; round++) {
    const startup = beginStartup(rig({ win }).ports);
    startup.finish();
    assert.equal(win.count("storage"), 1, `storage, round ${round}`);
    assert.equal(win.count("beforeunload"), 1, `beforeunload, round ${round}`);
    assert.equal(win.count("load"), 1, `load, round ${round}`);
    startup.dispose();
    assert.equal(win.count("storage"), 0);
    assert.equal(win.count("beforeunload"), 0);
    assert.equal(win.count("load"), 0);
  }
});

test("startup refuses to begin twice, and each phase runs once", async () => {
  const startup = beginStartup(rig().ports);
  try {
    assert.throws(() => beginStartup(rig().ports), /already begun/);
    startup.finish();
    assert.throws(() => startup.finish(), /already finished/);
    await startup.openDocument();
    assert.throws(() => startup.openDocument(), /already opening/);
  } finally {
    startup.dispose();
  }
  beginStartup(rig().ports).dispose();
});

test("the storage listener migrates history only for the snapshot key with a new value", () => {
  const r = rig();
  const startup = beginStartup(r.ports);
  try {
    startup.finish();
    const fire = (key: string | null, newValue: string | null): void => {
      const e = new Event("storage");
      Object.assign(e, { key, newValue });
      r.win.dispatchEvent(e);
    };
    fire("other", "x");
    fire("snapshots", null);
    assert.ok(!r.log.includes("history-migration"));
    fire("snapshots", "[]");
    assert.equal(r.log.filter((s) => s === "history-migration").length, 1);
  } finally {
    startup.dispose();
  }
});

test("beforeunload warns only while there is unsaved work", () => {
  const r = rig();
  const startup = beginStartup(r.ports);
  try {
    startup.finish();
    const clean = new Event("beforeunload", { cancelable: true });
    r.win.dispatchEvent(clean);
    assert.equal(clean.defaultPrevented, false);
    r.dirty = true;
    const dirty = new Event("beforeunload", { cancelable: true });
    r.win.dispatchEvent(dirty);
    assert.equal(dirty.defaultPrevented, true);
    assert.equal((dirty as Event & { returnValue: unknown }).returnValue, false);
  } finally {
    startup.dispose();
  }
});

test("the service worker registers on a later load, in the browser only, when supported and not from a file", () => {
  const web = rig();
  const startup = beginStartup(web.ports);
  try {
    startup.finish();
    assert.deepEqual(web.win.registered, [], "not before the window's load");
    web.win.dispatchEvent(new Event("load"));
    assert.deepEqual(web.win.registered, ["sw.js"]);
  } finally {
    startup.dispose();
  }
  for (const [label, options] of [
    ["desktop", { desktop: true }],
    ["file:", { win: new FakeWindow({ protocol: "file:" }) }],
    ["unsupported", { win: new FakeWindow({ serviceWorker: false }) }]
  ] as const) {
    const r = rig(options);
    const s = beginStartup(r.ports);
    try {
      s.finish();
      assert.equal(r.win.count("load"), 0, label);
      r.win.dispatchEvent(new Event("load"));
      assert.deepEqual(r.win.registered, [], label);
    } finally {
      s.dispose();
    }
  }
});

test("desktop integration starts at finish, after the page listeners, on the desktop only", () => {
  const desktop = rig({ desktop: true, taker: null });
  const s1 = beginStartup(desktop.ports);
  s1.finish();
  s1.dispose();
  assert.equal(desktop.log.filter((s) => s === "start-desktop").length, 1);
  const web = rig();
  const s2 = beginStartup(web.ports);
  s2.finish();
  s2.dispose();
  assert.ok(!web.log.includes("start-desktop"));
});

test("DOM-ready dispatch: immediate when ready, deferred once while loading, and cancellable before it fires", () => {
  let ran = 0;
  const ready = Object.assign(new EventTarget(), { readyState: "complete" }) as unknown as Document;
  whenDocumentReady(ready, () => { ran++; });
  assert.equal(ran, 1);

  const loading = Object.assign(new EventTarget(), { readyState: "loading" }) as unknown as Document;
  whenDocumentReady(loading, () => { ran++; });
  assert.equal(ran, 1);
  loading.dispatchEvent(new Event("DOMContentLoaded"));
  loading.dispatchEvent(new Event("DOMContentLoaded"));
  assert.equal(ran, 2, "runs once, however often the event fires");

  const cancelled = Object.assign(new EventTarget(), { readyState: "loading" }) as unknown as Document;
  const stop = whenDocumentReady(cancelled, () => { ran++; });
  stop();
  cancelled.dispatchEvent(new Event("DOMContentLoaded"));
  assert.equal(ran, 2);
});

test("the ready signal is null until the document opens, then the open's own promise, settled after the draft resumes", async () => {
  const r = rig({ desktop: true, taker: () => Promise.resolve("d") });
  const startup = beginStartup(r.ports);
  try {
    assert.equal(startup.ready(), null);
    const opening = startup.openDocument();
    assert.equal(startup.ready(), opening);
    await startup.ready();
    assert.ok(r.log.includes("apply-draft:d"), "the draft resumed before the signal settled");
  } finally {
    startup.dispose();
  }
});

test("the startup bridge answers the connected startup's ready signal, and nothing before it connects or after it disconnects", async () => {
  const { connectStartup, startupReady } = await import("../../src/legacy/startup-bridge.ts");
  assert.equal(startupReady(), null);
  const startup = beginStartup(rig().ports);
  const disconnect = connectStartup(startup);
  try {
    assert.equal(startupReady(), null, "connected, but the document has not started opening");
    assert.throws(() => connectStartup(startup), /already connected/);
    const opening = startup.openDocument();
    assert.equal(startupReady(), opening);
    await opening;
  } finally {
    disconnect();
    startup.dispose();
  }
  assert.equal(startupReady(), null);
  disconnect();
  const again = connectStartup({ ready: () => null });
  again();
});
