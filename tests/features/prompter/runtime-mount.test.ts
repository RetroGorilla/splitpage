import { dom } from "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startPrompter } from "../../../src/features/prompter/prompter.js";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakePrompterPorts } from "../fakes.ts";

const realm = globalThis as unknown as Record<string, unknown>;
const win = dom.window;
realm.location = win.location;
realm.history = win.history;
realm.requestAnimationFrame = () => 1;
realm.cancelAnimationFrame = () => {};
const page = readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8");

function harness() {
  dom.reconfigure({ url: "https://splitpage.test/" });
  win.document.documentElement.innerHTML = page;
  const doc = migrateRows({ title: "Reading", rows: [{ id: "r1", audioText: "First scene." }, { id: "r2", audioText: "Second scene.", status: "shot" }] }, fakeMigration().ports);
  return fakePrompterPorts(doc);
}

test("prompter runtime uses fake document, preferences, panels and tag container ports", () => {
  const h = harness();
  h.flags.prompterMirror = true;
  const runtime = startPrompter(h.ports);
  try {
    assert.equal(runtime.mirror(), true);
    runtime.openPrompter();
    assert.equal(h.state.open, true);
    assert.equal(document.getElementById("prompter")?.hidden, false);
    assert.equal(document.querySelectorAll("#prompter-content .w").length, 4);
    assert.equal(h.calls.findIndex(call => call[0] === "closeAll") < h.calls.findIndex(call => call[0] === "setOpen"), true);
    runtime.setSkipShot(true);
    runtime.buildPrompterContent();
    assert.equal(document.querySelectorAll("#prompter-content .w").length, 2);
    runtime.setPrompterFlip(true);
    assert.equal(h.flags.prompterFlip, true);
    assert.equal(document.getElementById("prompter-scroll")?.classList.contains("flip"), true);
    const click = (): void => {};
    const stop = runtime.wireTagEntityContainer("production-panel", click);
    assert.deepEqual(h.calls.at(-1), ["installTagEntityContainer", "production-panel", click]);
    stop();
    assert.deepEqual(h.calls.at(-1), ["removeTagEntityContainer", "production-panel"]);
    runtime.closePrompter();
    assert.equal(h.state.open, false);
    assert.equal(document.getElementById("prompter")?.hidden, true);
  } finally {
    runtime.dispose();
  }
});

test("prompter runtime disposal stops playback and releases a wake lock that arrives late", async () => {
  const h = harness();
  const runtime = startPrompter(h.ports);
  let finish: (value: { release: () => Promise<void> }) => void = () => {};
  let released = 0;
  const pending = new Promise<{ release: () => Promise<void> }>(resolve => { finish = resolve; });
  const prior = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: () => pending } });
  try {
    h.state.open = true;
    runtime.setPrompterPlaying(true);
    runtime.acquireWakeLock();
    runtime.dispose();
    assert.equal(h.state.playing, false);
    assert.equal(h.state.voice, false);
    finish({ release: async () => { released++; } });
    await pending;
    await Promise.resolve();
    assert.equal(released, 1);
    runtime.dispose();
  } finally {
    if (prior) Object.defineProperty(navigator, "wakeLock", prior);
    else Reflect.deleteProperty(navigator, "wakeLock");
  }
});

test("prompter launch keeps parse, transition arguments and opening order without awaiting the transition", async () => {
  const h = harness();
  const priorFetch = globalThis.fetch;
  realm.fetch = async () => ({ ok: true, json: async () => ({ name: "Reading.splitpage", text: "script" }) });
  let transitionStarted = false;
  const runtime = startPrompter({ ...h.ports, opening: { open: (source: unknown) => { transitionStarted = true; h.calls.push(["open", source]); return new Promise(() => {}); } } });
  try {
    const hooks = win as unknown as { __prompterTest: { launchFromScript: (token: string) => Promise<boolean> } };
    assert.equal(await hooks.__prompterTest.launchFromScript("token"), true);
    assert.equal(transitionStarted, true);
    const parsed = h.calls.find(call => call[0] === "parse");
    const opened = h.calls.find(call => call[0] === "open");
    assert.ok(parsed);
    assert.ok(opened);
    assert.deepEqual(opened[1], { kind: "file", file: parsed[1], handle: null, parsed: { state: h.reader.document.current(), kind: "splitpage", docIdEmbedded: true }, options: { skipSnapshot: true, silent: true } });
    assert.equal(h.calls.indexOf(parsed) < h.calls.indexOf(opened), true);
    assert.equal(h.calls.indexOf(opened) < h.calls.findIndex(call => call[0] === "close"), true);
    assert.equal(h.state.open, true);
    runtime.closePrompter();
  } finally {
    runtime.dispose();
    globalThis.fetch = priorFetch;
  }
});

test("prompter startup waits for readiness before fetching the desktop script", async () => {
  const h = harness();
  const token = "a".repeat(64);
  dom.reconfigure({ url: "https://splitpage.test/?teleprompter=1#script=" + token });
  let ready: () => void = () => {};
  const pending = new Promise<void>(resolve => { ready = resolve; });
  const priorFetch = globalThis.fetch;
  let requested = "";
  realm.fetch = async (url: string) => {
    requested = url;
    return { ok: true, json: async () => ({ name: "Reading.splitpage", text: "script" }) };
  };
  const runtime = startPrompter({ ...h.ports, startup: { ready: () => pending } });
  try {
    await Promise.resolve();
    assert.equal(requested, "");
    assert.equal(h.state.open, false);
    assert.equal(h.calls.some(call => call[0] === "skipOnboarding"), true);
    ready();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requested, "prompter-script/" + token);
    assert.equal(h.state.open, true);
    runtime.closePrompter();
  } finally {
    ready();
    runtime.dispose();
    globalThis.fetch = priorFetch;
    win.sessionStorage.clear();
    dom.reconfigure({ url: "https://splitpage.test/" });
  }
});

test("disposing the runtime invalidates pending startup and desktop voice discovery", async () => {
  const h = harness();
  dom.reconfigure({ url: "https://splitpage.test/?teleprompter=1" });
  let finishStartup: () => void = () => {};
  const startup = new Promise<void>(resolve => { finishStartup = resolve; });
  let finishVoice: () => void = () => {};
  const voice = new Promise<void>(resolve => { finishVoice = resolve; });
  let serverReads = 0;
  let recognitions = 0;
  let desktop = false;
  const runtime = startPrompter({
    ...h.ports, startup: { ready: () => startup }, place: { serverHomeId: () => { serverReads++; return "server"; } },
    desktop: { ...h.ports.desktop, running: () => desktop },
    voice: { ...h.ports.voice, known: () => false, load: () => voice, createDesktop: () => { recognitions++; return { start() {}, stop() {} }; } }
  });
  try {
    desktop = true;
    runtime.updateVoiceAvailability();
    const starting = runtime.startVoiceFollow();
    runtime.dispose();
    finishStartup();
    finishVoice();
    await starting;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(serverReads, 0);
    assert.equal(recognitions, 0);
    assert.equal(h.state.open, false);
  } finally {
    finishStartup();
    finishVoice();
    runtime.dispose();
    dom.reconfigure({ url: "https://splitpage.test/" });
  }
});

test("a project parse completing after runtime disposal does not open a document", async () => {
  const h = harness();
  const priorFetch = globalThis.fetch;
  realm.fetch = async () => ({ ok: true, json: async () => ({ name: "Reading.splitpage", text: "script" }) });
  let finish: (parsed: unknown) => void = () => {};
  const pending = new Promise(resolve => { finish = resolve; });
  let parsed = false;
  const runtime = startPrompter({ ...h.ports, files: { parse: () => { parsed = true; return pending; } } });
  try {
    const hooks = win as unknown as { __prompterTest: { launchFromScript: (token: string) => Promise<boolean> } };
    const launching = hooks.__prompterTest.launchFromScript("token");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(parsed, true);
    runtime.dispose();
    finish({ state: h.reader.document.current(), kind: "splitpage", docIdEmbedded: true });
    assert.equal(await launching, false);
    assert.equal(h.calls.some(call => call[0] === "open"), false);
    assert.equal(h.state.open, false);
  } finally {
    finish(null);
    runtime.dispose();
    globalThis.fetch = priorFetch;
  }
});

for (const source of ["browser", "desktop", "relay"] as const) {
  for (const remount of [false, true]) {
    test(source + " speech callbacks cannot outlive disposal" + (remount ? " and remount" : ""), async () => {
      const h = harness();
      const instances: FakeRecognition[] = [];
      class FakeRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onstart: (() => void) | null = null;
        onresult: ((event: { resultIndex: number; results: unknown[] }) => void) | null = null;
        onerror: ((event: { error: string }) => void) | null = null;
        onend: (() => void) | null = null;
        onwarning: ((event: { warning: string }) => void) | null = null;
        ondevice: ((event: { name: string }) => void) | null = null;
        stopped = 0;
        constructor() { instances.push(this); }
        start() {}
        stop() { this.stopped++; }
      }
      const mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
      const runtime = startPrompter({
        ...h.ports,
        desktop: { ...h.ports.desktop, running: () => source === "desktop" },
        voice: {
          ...h.ports.voice, available: () => true, hasRelay: () => source === "relay",
          createDesktop: () => new FakeRecognition(), createRelay: () => new FakeRecognition(),
          browserRecognition: () => FakeRecognition
        }
      });
      let replacement: ReturnType<typeof startPrompter> | null = null;
      try {
        runtime.buildPrompterContent();
        await runtime.startVoiceFollow();
        assert.equal(instances.length, 1);
        const recognition = instances[0];
        assert.ok(recognition);
        recognition.onstart?.();
        assert.equal(h.state.voice, true);
        const { onstart, onresult, onerror, onend, onwarning, ondevice } = recognition;
        const callbacks = [
          () => onstart?.(),
          () => onresult?.({ resultIndex: 0, results: [] }),
          () => onerror?.({ error: "not-allowed" }),
          () => onend?.(),
          () => onwarning?.({ warning: "clear" }),
          () => ondevice?.({ name: "Old microphone" })
        ];
        runtime.dispose();
        assert.equal(recognition.stopped, 1);
        for (const handler of ["onstart", "onresult", "onerror", "onend", "onwarning", "ondevice"] as const) {
          assert.equal(recognition[handler], null, handler + " is detached");
        }
        const next = remount ? harness() : h;
        if (remount) replacement = startPrompter(next.ports);
        const calls = [...next.calls];
        const status = document.getElementById("pp-voice-status")?.textContent;
        for (const callback of callbacks) assert.doesNotThrow(callback);
        assert.equal(h.state.voice, false);
        assert.equal(next.state.voice, false);
        assert.deepEqual(next.calls, calls);
        assert.equal(document.getElementById("pp-voice-status")?.textContent, status);
      } finally {
        runtime.dispose();
        replacement?.dispose();
        if (mediaDevices) Object.defineProperty(navigator, "mediaDevices", mediaDevices);
        else Reflect.deleteProperty(navigator, "mediaDevices");
      }
    });
  }
}
