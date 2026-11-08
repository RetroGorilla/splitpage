import { dom } from "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startPrompter } from "../../../src/features/prompter/prompter.ts";
import { mountPrompter } from "../../../src/features/prompter/mount.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakePrompterPorts } from "../fakes.ts";
import type { PrompterFeaturePorts } from "../../../src/features/prompter/ports.ts";
import type { PreferenceNotice } from "../../../src/application/preferences/preferences.ts";
import { createDesktopRecognition, forgetDesktopVoice } from "../../../src/adapters/desktop/desktop-voice.ts";
import { restoreDesktop, useDesktopForTest } from "../../../src/adapters/desktop/desktop-port.ts";
import type { DesktopPort } from "../../../src/adapters/desktop/desktop-port.ts";
import type { Run } from "../../../src/core/text/runs.ts";

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

test("Present keeps saved and implicit paragraphs through skipped and empty first beats, and keeps its sentence rule", () => {
  harness();
  const doc = migrateRows({ paragraphsDecided: true, rows: [
    { id: "a", audioText: "First" },
    { id: "b", audioText: "Skipped", paragraphStart: true, status: "shot" },
    { id: "c", audioText: "Second" },
    { id: "d", audioText: "", visualText: "Picture", paragraphStart: true },
    { id: "e", audioText: "Third." },
    { id: "f", audioText: "Fourth" },
    { id: "g", audioText: "", visualText: "Scene picture" },
    { id: "h", audioText: "Fifth" },
    { id: "i", audioText: "continues" }
  ], sections: [{ id: "scene", name: "Scene", firstSceneId: "g" }] }, fakeMigration().ports);
  const h = fakePrompterPorts(doc);
  const runtime = startPrompter(h.ports);
  try {
    runtime.setSkipShot(true);
    runtime.buildPrompterContent();
    assert.deepEqual(Array.from(document.querySelectorAll(".prompter-line"), line => line.textContent),
      ["First", "Second", "Third.", "Fourth", "Fifth continues"]);
  } finally { runtime.dispose(); }
});

test("Present reads past a name chip as if it were not there", () => {
  harness();
  const doc = migrateRows({ rows: [{ id: "a", audioText: "chip" }] }, fakeMigration().ports);
  const h = fakePrompterPorts(doc);
  const sam = { atom: "who" as const, name: "Sam", text: "@Sam", marks: {} };
  const cells: Record<string, Run[]> = { chip: [sam, { text: " Ask them, ", marks: {} }, sam, { text: " now.", marks: {} }] };
  const runtime = startPrompter({ ...h.ports, text: { ...h.ports.text, cellOf: (html: unknown) => cells[String(html)] ?? [] } });
  try {
    runtime.buildPrompterContent();
    assert.deepEqual(Array.from(document.querySelectorAll(".prompter-line"), line => line.textContent), ["Ask them, now."]);
    assert.equal(document.querySelector("#prompter-content")?.textContent?.includes("@"), false);
  } finally { runtime.dispose(); }
});

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

test("Find pauses voice and playback, cues the matched scene, and resumes voice near a distant match", async () => {
  harness();
  const words = Array.from({ length: 220 }, (_, i) => "word" + i);
  const doc = migrateRows({ rows: [{ id: "r1", audioText: words.slice(0, 110).join(" ") + "." }, { id: "r2", audioText: words.slice(110).join(" ") + "." }] }, fakeMigration().ports);
  const h = fakePrompterPorts(doc);
  h.flags.prompterSceneMode = true;
  class Recognition {
    onstart: (() => void) | null = null;
    onresult: ((event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null;
    stopped = 0;
    start() { this.onstart?.(); }
    stop() { this.stopped++; }
  }
  const recognitions: Recognition[] = [];
  const runtime = startPrompter({ ...h.ports, voice: { ...h.ports.voice, available: () => true, hasRelay: () => true, createRelay: () => {
    const recognition = new Recognition(); recognitions.push(recognition); return recognition;
  } } });
  const scroller = document.getElementById("prompter-scroll") as HTMLElement;
  scroller.scrollTo = () => {};
  try {
    runtime.openPrompter();
    const rendered = Array.from(document.querySelectorAll<HTMLElement>("#prompter-content .w"));
    for (let i = 0; i < rendered.length; i++) Object.defineProperty(rendered[i], "offsetTop", { value: i * 20 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    await runtime.startVoiceFollow();
    assert.equal(h.state.voice, true);
    runtime.setSearching(true);
    assert.equal(h.state.voice, false);
    assert.equal(recognitions[0]?.stopped, 1);
    await runtime.startVoiceFollow();
    runtime.setPrompterPlaying(true);
    assert.equal(recognitions.length, 1);
    assert.equal(h.state.playing, false);
    const range = document.createRange();
    range.selectNodeContents(rendered[175] as HTMLElement);
    range.getClientRects = () => [] as unknown as DOMRectList;
    runtime.jumpToFind(range);
    assert.equal(scroller.scrollTop, 3300);
    assert.equal(document.getElementById("pp-scene-readout")?.textContent, "Beat A.2 of 2");
    runtime.setSearching(false);
    assert.equal(h.state.playing, false);
    await runtime.startVoiceFollow();
    recognitions[1]?.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "word175 word176" } }] });
    assert.equal(rendered[176]?.classList.contains("current-word"), true);
    runtime.stopVoiceFollow();
    runtime.setSearching(true);
    range.selectNodeContents(rendered[219] as HTMLElement);
    runtime.jumpToFind(range);
    const hooks = win as unknown as { __prompterTest: { checkSceneBoundaryNow: () => boolean } };
    assert.equal(hooks.__prompterTest.checkSceneBoundaryNow(), false);
    runtime.setSearching(false);
    runtime.setPrompterPlaying(true);
    assert.equal(h.state.playing, true);
  } finally { runtime.dispose(); }
});

test("voice restart after a trailing stage direction stays at the final spoken position", async () => {
  harness();
  const words = Array.from({ length: 220 }, (_, i) => "word" + i);
  const h = fakePrompterPorts(migrateRows({ rows: [{ id: "r1", audioText: "script" }] }, fakeMigration().ports));
  class Recognition {
    onstart: (() => void) | null = null;
    onresult: ((event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null;
    start() { this.onstart?.(); }
    stop() {}
  }
  const recognition = new Recognition();
  const runtime = startPrompter({ ...h.ports,
    text: { ...h.ports.text, cellOf: () => [{ text: words.join(" ") + "\n", marks: {} }, { text: "hold still", marks: { dir: true } }] },
    voice: { ...h.ports.voice, available: () => true, hasRelay: () => true, createRelay: () => recognition }
  });
  try {
    runtime.openPrompter();
    const rendered = Array.from(document.querySelectorAll<HTMLElement>("#prompter-content .w"));
    for (let i = 0; i < rendered.length; i++) Object.defineProperty(rendered[i], "offsetTop", { value: i * 20 });
    const scroller = document.getElementById("prompter-scroll") as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    scroller.scrollTo = (options?: ScrollToOptions | number) => { if (typeof options === "object") scroller.scrollTop = options.top ?? 0; };
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#prompter-content .stage-dir") as HTMLElement);
    range.getClientRects = () => [{ top: 4800, bottom: 4820 }] as unknown as DOMRectList;
    runtime.setSearching(true);
    runtime.jumpToFind(range);
    assert.equal(scroller.scrollTop, 4600);
    runtime.setSearching(false);
    await runtime.startVoiceFollow();
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "word0 word1" } }] });
    assert.equal(scroller.scrollTop, 4600);
    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "word216 word217 word218" } }] });
    assert.equal(rendered[218]?.classList.contains("current-word"), true);
  } finally { runtime.dispose(); }
});

test("closing Present restores its editor origin without scrolling, including after a repeated open", () => {
  const h = harness();
  const origin = document.createElement("div");
  origin.setAttribute("contenteditable", "true");
  origin.tabIndex = 0;
  document.getElementById("rows")?.append(origin);
  origin.focus();
  const runtime = startPrompter(h.ports);
  let options: FocusOptions | undefined;
  const focus = origin.focus.bind(origin);
  origin.focus = (given?: FocusOptions) => { options = given; focus(given); };
  try {
    runtime.openPrompter();
    runtime.openPrompter();
    assert.equal(document.activeElement, document.getElementById("pp-play"));
    runtime.closePrompter();
    assert.equal(document.activeElement, origin);
    assert.deepEqual(options, { preventScroll: true });
  } finally { runtime.dispose(); }
});

test("closing Present skips an unavailable origin and preserves foreground toast focus", () => {
  for (const unavailable of ["removed", "hidden", "foreground"]) {
    const h = harness();
    const origin = document.getElementById("doc-title") as HTMLInputElement;
    origin.focus();
    const runtime = startPrompter(h.ports);
    try {
      runtime.openPrompter();
      const focus = origin.focus.bind(origin);
      let attempts = 0;
      origin.focus = (options?: FocusOptions) => { attempts++; focus(options); };
      let expected: Element = document.body;
      if (unavailable === "removed") origin.remove();
      else if (unavailable === "hidden") origin.hidden = true;
      else {
        const toast = document.createElement("div");
        toast.className = "toast";
        const button = document.createElement("button");
        toast.append(button);
        document.getElementById("toast-host")?.append(toast);
        button.focus();
        expected = button;
      }
      runtime.closePrompter();
      assert.equal(document.activeElement, expected, unavailable);
      assert.equal(attempts, 0, unavailable);
    } finally { runtime.dispose(); }
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
  const serverReads = 0;
  let recognitions = 0;
  let desktop = false;
  const runtime = startPrompter({
    ...h.ports, startup: { ready: () => startup },
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

for (const outcome of ["reject", "resolve"] as const) {
  for (const scenario of ["dispose", "remount listening", "remount pending", "restart pending"] as const) {
    test("late microphone " + outcome + " cannot change " + scenario, async () => {
      const h = harness();
      let finishOld: (stream: unknown) => void = () => {};
      let rejectOld: (error: Error) => void = () => {};
      const oldPermission = new Promise((resolve, reject) => { finishOld = resolve; rejectOld = reject; });
      let finishNew: (stream: unknown) => void = () => {};
      const newPermission = new Promise(resolve => { finishNew = resolve; });
      let oldStopped = 0;
      let newStopped = 0;
      const oldStream = { getTracks: () => [{ stop: () => { oldStopped++; } }], getAudioTracks: () => [{ label: "Old microphone" }] };
      const newStream = { getTracks: () => [{ stop: () => { newStopped++; } }], getAudioTracks: () => [{ label: "New microphone" }] };
      let requests = 0;
      let recognitions = 0;
      class Recognition {
        onstart: (() => void) | null = null;
        constructor() { recognitions++; }
        start() { this.onstart?.(); }
        stop() {}
      }
      const mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
        getUserMedia: (options: unknown) => {
          assert.deepEqual(options, { audio: true });
          requests++;
          return requests === 1 ? oldPermission : requests === 2 ? newPermission : Promise.resolve(newStream);
        }
      } });
      const runtime = startPrompter({ ...h.ports, voice: { ...h.ports.voice, browserRecognition: () => Recognition } });
      let current = runtime;
      let next = h;
      let replacementStarting: Promise<void> | null = null;
      runtime.buildPrompterContent();
      const starting = runtime.startVoiceFollow();
      try {
        assert.equal(requests, 1);
        if (scenario === "restart pending") runtime.stopVoiceFollow();
        else runtime.dispose();
        if (scenario.startsWith("remount")) {
          next = harness();
          current = startPrompter({ ...next.ports, voice: { ...next.ports.voice, browserRecognition: () => Recognition } });
          current.buildPrompterContent();
        }
        if (scenario !== "dispose") {
          replacementStarting = current.startVoiceFollow();
          assert.equal(requests, 2);
          if (scenario === "remount listening") {
            finishNew(newStream);
            await replacementStarting;
            assert.equal(next.state.voice, true);
            assert.match(document.getElementById("pp-voice-status")?.textContent ?? "", /Listening/);
          }
        }
        const status = document.getElementById("pp-voice-status")?.textContent;
        const calls = [...next.calls];
        if (outcome === "reject") rejectOld(Object.assign(new Error("permission refused"), { name: "NotAllowedError" }));
        else finishOld(oldStream);
        await assert.doesNotReject(starting);
        assert.equal(document.getElementById("pp-voice-status")?.textContent, status);
        assert.deepEqual(next.calls, calls);
        assert.equal(oldStopped, outcome === "resolve" ? 1 : 0);
        assert.equal(newStopped, 0);
        if (scenario.endsWith("pending")) {
          await current.startVoiceFollow();
          assert.equal(requests, 2, "the replacement permission request remains the only pending voice start");
        }
        if (replacementStarting) {
          finishNew(newStream);
          await replacementStarting;
          assert.equal(recognitions, 1);
          assert.equal(next.state.voice, true);
          current.stopVoiceFollow();
          assert.equal(newStopped, 1, "the replacement keeps ownership of its microphone stream");
        } else assert.equal(recognitions, 0);
      } finally {
        finishOld(oldStream);
        finishNew(newStream);
        await starting.catch(() => {});
        await replacementStarting?.catch(() => {});
        current.dispose();
        if (mediaDevices) Object.defineProperty(navigator, "mediaDevices", mediaDevices);
        else Reflect.deleteProperty(navigator, "mediaDevices");
      }
    });
  }
}

for (const name of ["NotAllowedError", "NotFoundError"] as const) {
  test("an active microphone rejection keeps the existing " + name + " message", async () => {
    const h = harness();
    const mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: async () => { throw Object.assign(new Error("permission refused"), { name }); }
    } });
    class Recognition { start() {} stop() {} }
    const runtime = startPrompter({ ...h.ports, voice: { ...h.ports.voice, browserRecognition: () => Recognition } });
    try {
      runtime.buildPrompterContent();
      await runtime.startVoiceFollow();
      assert.match(document.getElementById("pp-voice-status")?.textContent ?? "", name === "NotFoundError" ? /No microphone was found/ : /Microphone blocked/);
      assert.equal(h.state.voice, false);
    } finally {
      runtime.dispose();
      if (mediaDevices) Object.defineProperty(navigator, "mediaDevices", mediaDevices);
      else Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });
}

for (const scenario of ["active rejection", "dispose rejection", "remount rejection", "restart resolution"] as const) {
  test("desktop voice discovery preserves ownership during " + scenario, async () => {
    const h = harness();
    let finish: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const discovery = new Promise<void>((resolve, refuse) => { finish = resolve; reject = refuse; });
    const failure = new Error("desktop voice discovery failed");
    let known = false;
    let recognitions = 0;
    class Recognition {
      onstart: (() => void) | null = null;
      constructor() { recognitions++; }
      start() { this.onstart?.(); }
      stop() {}
    }
    const runtime = startPrompter({
      ...h.ports, desktop: { ...h.ports.desktop, running: () => true },
      voice: { ...h.ports.voice, known: () => known, available: () => true, load: () => discovery, createDesktop: () => new Recognition() }
    });
    runtime.buildPrompterContent();
    const starting = runtime.startVoiceFollow();
    let replacement: ReturnType<typeof startPrompter> | null = null;
    try {
      if (scenario === "restart resolution") {
        runtime.stopVoiceFollow();
        known = true;
        await runtime.startVoiceFollow();
        assert.equal(h.state.voice, true);
      } else if (scenario !== "active rejection") runtime.dispose();
      if (scenario === "remount rejection") {
        const next = harness();
        replacement = startPrompter(next.ports);
      }
      const status = document.getElementById("pp-voice-status")?.textContent;
      if (scenario === "restart resolution") finish();
      else reject(failure);
      if (scenario === "active rejection") await assert.rejects(starting, error => error === failure);
      else await assert.doesNotReject(starting);
      assert.equal(recognitions, scenario === "restart resolution" ? 1 : 0);
      assert.equal(document.getElementById("pp-voice-status")?.textContent, status);
    } finally {
      finish();
      await starting.catch(() => {});
      runtime.dispose();
      replacement?.dispose();
    }
  });
}

for (const scenario of ["active", "dispose", "remount"] as const) {
  test("project parse rejection preserves startup ownership when " + scenario, async () => {
    const h = harness();
    const priorFetch = globalThis.fetch;
    realm.fetch = async () => ({ ok: true, json: async () => ({ name: "Reading.splitpage", text: "script" }) });
    let reject: (error: Error) => void = () => {};
    const failure = new Error("project parser failed");
    const parsed = new Promise((_resolve, refuse) => { reject = refuse; });
    const runtime = startPrompter({ ...h.ports, files: { parse: () => parsed } });
    let replacement: ReturnType<typeof startPrompter> | null = null;
    const hooks = win as unknown as { __prompterTest: { launchFromScript: (token: string) => Promise<boolean> } };
    const launching = hooks.__prompterTest.launchFromScript("token");
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (scenario !== "active") runtime.dispose();
      if (scenario === "remount") replacement = startPrompter(harness().ports);
      reject(failure);
      if (scenario === "active") await assert.rejects(launching, error => error === failure);
      else assert.equal(await launching, false);
      assert.equal(h.calls.some(call => call[0] === "open"), false);
    } finally {
      reject(failure);
      await launching.catch(() => {});
      runtime.dispose();
      replacement?.dispose();
      globalThis.fetch = priorFetch;
    }
  });
}

test("a browser hand-off reply cannot update the voice status after its session stops", async () => {
  const h = harness();
  let finish: (result: { ok: boolean; message: string }) => void = () => {};
  const opening = new Promise<{ ok: boolean; message: string }>(resolve => { finish = resolve; });
  const runtime = startPrompter({
    ...h.ports, desktop: { running: () => true, canOpen: () => true, open: () => opening }
  });
  try {
    await runtime.startVoiceFollow();
    runtime.stopVoiceFollow();
    const status = document.getElementById("pp-voice-status")?.textContent;
    finish({ ok: false, message: "Old hand-off failed" });
    await opening;
    await Promise.resolve();
    assert.equal(document.getElementById("pp-voice-status")?.textContent, status);
  } finally {
    finish({ ok: true, message: "done" });
    runtime.dispose();
  }
});

type MicRequest = { audio: true | { deviceId: { exact: string } } };

function installMicrophones(getUserMedia: (request: MicRequest) => Promise<unknown>) {
  const prior = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  return () => {
    if (prior) Object.defineProperty(navigator, "mediaDevices", prior);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  };
}

function microphoneStream(label: string, stopped: { count: number } = { count: 0 }) {
  const track = { kind: "audio", label, onended: null as (() => void) | null, stop: () => { stopped.count++; } };
  return { track, stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
}

class StartRecorder {
  static starts: unknown[][] = [];
  onstart: (() => void) | null = null;
  start(...args: unknown[]) { StartRecorder.starts.push(args); this.onstart?.(); }
  stop() {}
}

function microphoneHarness(saved: string, support: "yes" | "desktop" | "browser" = "yes") {
  const h = harness();
  StartRecorder.starts = [];
  const choice = { saved };
  const heard = new Set<(change: PreferenceNotice) => void>();
  const ports: PrompterFeaturePorts = {
    ...h.ports,
    voice: { ...h.ports.voice, browserRecognition: () => StartRecorder },
    microphones: {
      support: () => support,
      list: async () => ({ options: [{ id: "dev-1", label: "Mic One" }, { id: "dev-2", label: "Mic Two" }], named: true }),
      onChange: () => () => {}
    },
    changes: { onChange: (listener) => { heard.add(listener); return () => { heard.delete(listener); }; } },
    preferences: {
      ...h.ports.preferences,
      microphone: () => choice.saved,
      setMicrophone: (id: string) => {
        choice.saved = id;
        h.calls.push(["microphone", id]);
        for (const listener of heard) listener({ name: "microphone", value: id || null, elsewhere: false });
      }
    }
  };
  return { h, ports, choice, heard };
}

test("Follow My Voice listens on the saved microphone: the stream asks for that device and recognition takes its track", async () => {
  const { ports } = microphoneHarness("dev-2");
  const requests: MicRequest[] = [];
  const mic = microphoneStream("Mic Two");
  const restore = installMicrophones(async (request) => { requests.push(request); return mic.stream; });
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    assert.deepEqual(requests, [{ audio: { deviceId: { exact: "dev-2" } } }]);
    assert.deepEqual(StartRecorder.starts, [[mic.track]]);
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Listening — Mic Two");
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); restore(); }
});

test("the system default asks for no device and starts recognition as before", async () => {
  const { ports } = microphoneHarness("");
  const requests: MicRequest[] = [];
  const restore = installMicrophones(async (request) => { requests.push(request); return microphoneStream("Default Mic").stream; });
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    assert.deepEqual(requests, [{ audio: true }]);
    assert.deepEqual(StartRecorder.starts, [[]]);
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); restore(); }
});

test("a saved microphone that is not connected falls back to the default, says so, and is kept for next time", async () => {
  const { ports, choice } = microphoneHarness("unplugged");
  const requests: MicRequest[] = [];
  const restore = installMicrophones(async (request) => {
    requests.push(request);
    if (request.audio !== true) throw Object.assign(new Error("no such device"), { name: "OverconstrainedError" });
    return microphoneStream("Built-in Mic").stream;
  });
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    assert.deepEqual(requests, [{ audio: { deviceId: { exact: "unplugged" } } }, { audio: true }]);
    assert.deepEqual(StartRecorder.starts, [[]], "recognition uses the default microphone, not a dead track");
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Listening — Built-in Mic (your chosen microphone isn't connected)");
    assert.equal(choice.saved, "unplugged");
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); restore(); }
});

test("a blocked microphone is not mistaken for a missing one: no fallback, the blocked message stays", async () => {
  const { ports } = microphoneHarness("dev-1");
  const requests: MicRequest[] = [];
  const restore = installMicrophones(async (request) => { requests.push(request); throw Object.assign(new Error("refused"), { name: "NotAllowedError" }); });
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    assert.equal(requests.length, 1);
    assert.match(document.getElementById("pp-voice-status")?.textContent ?? "", /Microphone blocked/);
  } finally { runtime.dispose(); restore(); }
});

test("where the browser cannot aim recognition at a microphone, the saved choice is ignored", async () => {
  const { ports } = microphoneHarness("dev-2", "browser");
  const requests: MicRequest[] = [];
  const restore = installMicrophones(async (request) => { requests.push(request); return microphoneStream("Default Mic").stream; });
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    assert.deepEqual(requests, [{ audio: true }]);
    assert.deepEqual(StartRecorder.starts, [[]]);
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); restore(); }
});

test("the teleprompter's microphone list shows only where it works, marks the saved one, and saves a pick", async () => {
  const { h, ports, choice } = microphoneHarness("dev-2");
  const runtime = startPrompter(ports);
  const mounted = mountPrompter({ window: win as unknown as Window, ports: runtime });
  const select = () => document.getElementById("pp-mic") as HTMLSelectElement;
  try {
    runtime.updateVoiceAvailability();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(select().hidden, false);
    assert.deepEqual(Array.from(select().options, o => [o.value, o.textContent]), [["", "System default"], ["dev-1", "Mic One"], ["dev-2", "Mic Two"]]);
    assert.equal(select().value, "dev-2");
    select().value = "dev-1";
    select().dispatchEvent(new ((select().ownerDocument.defaultView) as Window & typeof globalThis).Event("change", { bubbles: true }));
    assert.equal(choice.saved, "dev-1");
    assert.deepEqual(h.calls.at(-1), ["microphone", "dev-1"]);
  } finally { mounted.dispose(); runtime.dispose(); }
  for (const support of ["desktop", "browser"] as const) {
    const other = microphoneHarness("dev-2", support);
    const again = startPrompter(other.ports);
    try {
      again.updateVoiceAvailability();
      assert.equal(select().hidden, true, support);
    } finally { again.dispose(); }
  }
});

test("choosing another microphone while following restarts on it, and the prompter stops listening for changes once closed", async () => {
  const { ports, heard } = microphoneHarness("dev-1");
  const requests: MicRequest[] = [];
  const stopped = { count: 0 };
  const restore = installMicrophones(async (request) => {
    requests.push(request);
    return microphoneStream(request.audio !== true && request.audio.deviceId.exact === "dev-2" ? "Mic Two" : "Mic One", stopped).stream;
  });
  const runtime = startPrompter(ports);
  try {
    runtime.openPrompter();
    assert.equal(heard.size, 1);
    await runtime.startVoiceFollow();
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Listening — Mic One");
    runtime.chooseMicrophone("dev-2");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [{ audio: { deviceId: { exact: "dev-1" } } }, { audio: { deviceId: { exact: "dev-2" } } }]);
    assert.equal(stopped.count, 1, "the first microphone is released");
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Listening — Mic Two");
    runtime.closePrompter();
    assert.equal(heard.size, 0);
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); restore(); }
});

test("a chosen microphone that stops mid-session ends Follow My Voice with a message instead of failing silently", async () => {
  const { ports, h } = microphoneHarness("dev-1");
  class Dropping extends StartRecorder {
    onend: (() => void) | null = null;
    override start(...args: unknown[]) {
      StartRecorder.starts.push(args);
      if (StartRecorder.starts.length === 1) { this.onstart?.(); setTimeout(() => this.onend?.(), 0); return; }
      throw Object.assign(new Error("track ended"), { name: "InvalidStateError" });
    }
  }
  const restore = installMicrophones(async () => microphoneStream("Mic One").stream);
  const runtime = startPrompter({ ...ports, voice: { ...ports.voice, browserRecognition: () => Dropping } });
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(h.state.voice, false);
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Your chosen microphone stopped working — pick it again or choose another.");
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); restore(); }
});
test("closing Present before a missing saved microphone is refused does not open the default microphone", async () => {
  const { ports } = microphoneHarness("unplugged");
  const requests: MicRequest[] = [];
  let refuse: (error: Error) => void = () => {};
  const refused = new Promise<never>((_, reject) => { refuse = reject; });
  const stopped = { count: 0 };
  const restore = installMicrophones((request) => {
    requests.push(request);
    return request.audio === true ? Promise.resolve(microphoneStream("Built-in Mic", stopped).stream) : refused;
  });
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    const starting = runtime.startVoiceFollow();
    assert.equal(requests.length, 1);
    runtime.stopVoiceFollow();
    refuse(Object.assign(new Error("no such device"), { name: "OverconstrainedError" }));
    await starting;
    assert.deepEqual(requests, [{ audio: { deviceId: { exact: "unplugged" } } }], "no second request once the session is over");
    assert.deepEqual(StartRecorder.starts, []);
  } finally { runtime.dispose(); restore(); }
});

test("a microphone that arrives after its session ended is stopped, whichever request it answers", async () => {
  const { ports } = microphoneHarness("unplugged");
  let refuse: (error: Error) => void = () => {};
  const first = new Promise<never>((_, reject) => { refuse = reject; });
  let deliver: (stream: unknown) => void = () => {};
  const second = new Promise((resolve) => { deliver = resolve; });
  const stopped = { count: 0 };
  const restore = installMicrophones((request) => request.audio === true ? second : first);
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    const starting = runtime.startVoiceFollow();
    refuse(Object.assign(new Error("no such device"), { name: "OverconstrainedError" }));
    await Promise.resolve();
    await Promise.resolve();
    runtime.stopVoiceFollow();
    deliver(microphoneStream("Built-in Mic", stopped).stream);
    await starting;
    assert.equal(stopped.count, 1);
    assert.deepEqual(StartRecorder.starts, []);
  } finally { runtime.dispose(); restore(); }
});

test("a chosen microphone whose track ends on its own stops Follow My Voice with a message", async () => {
  const { ports, h } = microphoneHarness("dev-1");
  const stopped = { count: 0 };
  const mic = microphoneStream("Mic One", stopped);
  const restore = installMicrophones(async () => mic.stream);
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    assert.equal(h.state.voice, true);
    assert.equal(typeof mic.track.onended, "function");
    mic.track.onended?.();
    assert.equal(h.state.voice, false);
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Your chosen microphone stopped working — pick it again or choose another.");
    assert.equal(stopped.count, 1, "the stream is released");
    mic.track.onended?.();
    assert.equal(h.state.voice, false);
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); restore(); }
});

test("a track that ends after its session was stopped changes nothing", async () => {
  const { ports, h } = microphoneHarness("dev-1");
  const mic = microphoneStream("Mic One");
  const restore = installMicrophones(async () => mic.stream);
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    runtime.stopVoiceFollow();
    const status = document.getElementById("pp-voice-status")?.textContent;
    mic.track.onended?.();
    assert.equal(document.getElementById("pp-voice-status")?.textContent, status);
    assert.equal(h.state.voice, false);
  } finally { runtime.dispose(); restore(); }
});

const DESKTOP_MIC_ONE = "{0.0.1.00000000}.{11111111-1111-4111-8111-111111111111}";
const DESKTOP_MIC_TWO = "{0.0.1.00000000}.{22222222-2222-4222-8222-222222222222}";

class DesktopListener {
  static made: { microphone: string; listener: DesktopListener }[] = [];
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  ondevice: ((event: { name?: string; fellBack?: boolean }) => void) | null = null;
  starts = 0;
  stops = 0;
  start() { this.starts++; }
  stop() { this.stops++; }
}

function desktopMicrophoneHarness(saved: string) {
  const made = microphoneHarness(saved);
  DesktopListener.made = [];
  const ports: PrompterFeaturePorts = {
    ...made.ports,
    desktop: { ...made.ports.desktop, running: () => true },
    voice: {
      ...made.ports.voice, known: () => true, available: () => true,
      createDesktop: (microphone: string) => {
        const listener = new DesktopListener();
        DesktopListener.made.push({ microphone, listener });
        return listener;
      }
    },
    microphones: { ...made.ports.microphones, list: async () => ({ options: [{ id: DESKTOP_MIC_ONE, label: "Mic One" }, { id: DESKTOP_MIC_TWO, label: "Mic Two" }], named: true }) }
  };
  return { ...made, ports };
}

function lastDesktopListener(): DesktopListener {
  const last = DesktopListener.made.at(-1);
  assert.ok(last, "a desktop listener was made");
  return last.listener;
}

function delayedDesktopMicrophoneHarness() {
  const made = desktopMicrophoneHarness(DESKTOP_MIC_ONE);
  let emit: Parameters<DesktopPort["onVoiceEvent"]>[0] = () => {};
  let nextSession = 0;
  let current: number | null = null;
  const live = new Map<number, string>();
  const pending: ((answer?: Awaited<ReturnType<DesktopPort["voiceStart"]>>) => void)[] = [];
  const stopped: number[] = [];
  const stopRequests: (number | undefined)[] = [];
  useDesktopForTest({
    onVoiceEvent: (listener) => { emit = listener; },
    voiceStart: (microphone) => {
      const session = ++nextSession;
      if (current !== null) {
        live.delete(current);
        emit({ type: "end", session: current, reason: "taken" });
      }
      current = session;
      live.set(session, microphone ?? "");
      emit({ type: "device", session, name: microphone === DESKTOP_MIC_TWO ? "Mic Two" : "Mic One" });
      emit({ type: "start", session });
      return new Promise((resolve) => { pending.push((answer) => { resolve(answer ?? { ok: true, session }); }); });
    },
    voiceStop: async (session?: number) => {
      stopRequests.push(session);
      if (current !== null && (session === undefined || session === current)) {
        stopped.push(current);
        live.delete(current);
        emit({ type: "end", session: current, reason: "stopped" });
        current = null;
      }
      return { ok: true };
    }
  });
  const runtime = startPrompter({ ...made.ports, voice: { ...made.ports.voice, createDesktop: createDesktopRecognition } });
  const mounted = mountPrompter({ window: win as unknown as Window, ports: runtime });
  const tick = () => new Promise<void>((resolve) => { setImmediate(resolve); });
  const pick = async (id: string) => {
    const select = document.getElementById("pp-mic") as HTMLSelectElement;
    select.value = id;
    select.dispatchEvent(new (win as unknown as Window & typeof globalThis).Event("change", { bubbles: true }));
    await tick();
  };
  const replies = async () => {
    for (let turn = 0; turn < 20; turn++) {
      await tick();
      if (!pending.length) return;
      pending.splice(0).reverse().forEach((reply) => { reply(); });
    }
    assert.fail("desktop starts did not settle");
  };
  return { ...made, runtime, live, pending, stopped, stopRequests, pick, replies, tick,
    dispose: async () => {
      runtime.stopVoiceFollow();
      mounted.dispose();
      runtime.dispose();
      await replies();
      assert.equal(live.size, 0, "disposing leaves no helper running");
      forgetDesktopVoice();
      restoreDesktop();
    }
  };
}

test("a delayed desktop start reply after a microphone pick keeps the newly chosen listener running", async () => {
  const h = delayedDesktopMicrophoneHarness();
  try {
    h.runtime.openPrompter();
    await h.tick();
    await h.runtime.startVoiceFollow();
    await h.tick();
    assert.equal(h.pending.length, 1);
    await h.pick(DESKTOP_MIC_TWO);
    await h.replies();
    assert.equal(h.h.state.voice, true, "the stale reply must not stop the new session");
    assert.deepEqual([...h.live.values()], [DESKTOP_MIC_TWO]);
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Listening — Mic Two");
    assert.ok(h.stopped.includes(1), "the obsolete helper was shut down");
  } finally { await h.dispose(); }
});

test("rapid repeated microphone picks with delayed desktop replies leave only the final choice listening", async () => {
  const h = delayedDesktopMicrophoneHarness();
  try {
    h.runtime.openPrompter();
    await h.tick();
    await h.runtime.startVoiceFollow();
    await h.tick();
    for (const id of [DESKTOP_MIC_TWO, DESKTOP_MIC_ONE, DESKTOP_MIC_TWO, DESKTOP_MIC_ONE, DESKTOP_MIC_TWO]) {
      await h.pick(id);
    }
    await h.replies();
    assert.equal(h.h.state.voice, true, "late replies cannot turn the final choice off");
    assert.equal(h.choice.saved, DESKTOP_MIC_TWO);
    assert.deepEqual([...h.live.values()], [DESKTOP_MIC_TWO]);
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Listening — Mic Two");
  } finally { await h.dispose(); }
});

test("closing Present before a desktop start reply shuts down the obsolete helper", async () => {
  const h = delayedDesktopMicrophoneHarness();
  try {
    h.runtime.openPrompter();
    await h.tick();
    await h.runtime.startVoiceFollow();
    await h.tick();
    assert.equal(h.live.size, 1);
    h.runtime.closePrompter();
    await h.replies();
    assert.equal(h.h.state.voice, false);
    assert.equal(h.live.size, 0);
    assert.deepEqual(h.stopped, [1]);
  } finally { await h.dispose(); }
});

test("a desktop start that never replies fails after 15 seconds and releases its helper", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = delayedDesktopMicrophoneHarness();
  try {
    h.runtime.openPrompter();
    await h.tick();
    await h.runtime.startVoiceFollow();
    await h.tick();
    t.mock.timers.tick(14999);
    await h.tick();
    assert.match(document.getElementById("pp-voice-status")?.textContent ?? "", /Starting Windows speech recognition/);
    assert.equal(h.live.size, 1);
    t.mock.timers.tick(1);
    await h.tick();
    assert.equal(document.getElementById("pp-voice-status")?.textContent,
      "Windows speech recognition couldn't start. Present in Browser still works.");
    assert.equal(h.h.state.voice, false);
    assert.equal(h.live.size, 0);
    assert.deepEqual(h.stopped, [1]);
  } finally { await h.dispose(); }
});

for (const scenario of ["close", "new pick", "reopen Present"] as const) {
  test("a desktop start that never replies recovers after " + scenario, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = delayedDesktopMicrophoneHarness();
    try {
      h.runtime.openPrompter();
      await h.tick();
      await h.runtime.startVoiceFollow();
      await h.tick();
      assert.equal(h.pending.length, 1);
      h.pending.shift();
      if (scenario === "new pick") await h.pick(DESKTOP_MIC_TWO);
      else h.runtime.closePrompter();
      if (scenario === "reopen Present") {
        h.runtime.openPrompter();
        await h.runtime.startVoiceFollow();
      }
      t.mock.timers.tick(15000);
      await h.tick();
      assert.ok(h.stopped.includes(1), "the helper is stopped without its start reply");
      assert.equal(h.live.has(1), false);
      if (scenario === "close") {
        assert.equal(h.live.size, 0);
        assert.equal(h.h.state.voice, false);
      } else {
        await h.replies();
        assert.deepEqual([...h.live.values()], [scenario === "new pick" ? DESKTOP_MIC_TWO : DESKTOP_MIC_ONE]);
        assert.equal(h.h.state.voice, true, "the queue accepts starts without the first reply");
        assert.equal(document.getElementById("pp-voice-status")?.textContent,
          scenario === "new pick" ? "Listening — Mic Two" : "Listening — Mic One");
      }
    } finally { await h.dispose(); }
  });
}

for (const successful of [true, false]) {
  test("a late " + (successful ? "successful" : "failed") + " desktop reply after timeout leaves the newer listener running", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = delayedDesktopMicrophoneHarness();
    try {
      h.runtime.openPrompter();
      await h.tick();
      await h.runtime.startVoiceFollow();
      await h.tick();
      const reply = h.pending.shift();
      assert.ok(reply);
      t.mock.timers.tick(15000);
      await h.tick();
      await h.pick(DESKTOP_MIC_TWO);
      await h.runtime.startVoiceFollow();
      await h.replies();
      assert.deepEqual([...h.live.values()], [DESKTOP_MIC_TWO]);
      reply(successful ? { ok: true, session: 1 } : { ok: false, code: "SPAWN_FAILED" });
      await h.tick();
      assert.deepEqual(h.stopRequests, successful ? [undefined, 1] : [undefined],
        "late cleanup targets only the expired session, never the whole tab");
      assert.deepEqual([...h.live.values()], [DESKTOP_MIC_TWO]);
      assert.equal(h.h.state.voice, true);
      assert.equal(document.getElementById("pp-voice-status")?.textContent, "Listening — Mic Two");
      t.mock.timers.tick(15000);
      await h.tick();
      assert.deepEqual([...h.live.values()], [DESKTOP_MIC_TWO], "settled starts cancel their deadlines");
    } finally { await h.dispose(); }
  });
}

test("in the desktop app the saved microphone goes to Windows' listener, and the status names it", async () => {
  const { ports } = desktopMicrophoneHarness(DESKTOP_MIC_TWO);
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    assert.deepEqual(DesktopListener.made.map((m) => m.microphone), [DESKTOP_MIC_TWO]);
    const listener = lastDesktopListener();
    assert.equal(listener.starts, 1);
    listener.ondevice?.({ name: "Mic Two" });
    listener.onstart?.();
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Listening — Mic Two");
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); }
});

test("in the desktop app the system default sends no microphone, as before", async () => {
  const { ports } = desktopMicrophoneHarness("");
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    assert.deepEqual(DesktopListener.made.map((m) => m.microphone), [""]);
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); }
});

test("in the desktop app a chosen microphone that is not connected says the default is used, with or without its name", async () => {
  for (const name of ["Built-in Mic", ""]) {
    const { ports, choice } = desktopMicrophoneHarness(DESKTOP_MIC_ONE);
    const runtime = startPrompter(ports);
    try {
      runtime.buildPrompterContent();
      await runtime.startVoiceFollow();
      const listener = lastDesktopListener();
      listener.ondevice?.({ fellBack: true });
      if (name) listener.ondevice?.({ name });
      listener.onstart?.();
      assert.equal(document.getElementById("pp-voice-status")?.textContent,
        (name ? "Listening — " + name : "Listening…") + " (your chosen microphone isn't connected)");
      assert.equal(choice.saved, DESKTOP_MIC_ONE, "the choice is kept for when it comes back");
    } finally { runtime.stopVoiceFollow(); runtime.dispose(); }
  }
});

test("in the desktop app a chosen microphone that goes away ends Follow My Voice with a message and no restart", async () => {
  const { ports, h } = desktopMicrophoneHarness(DESKTOP_MIC_ONE);
  const runtime = startPrompter(ports);
  try {
    runtime.buildPrompterContent();
    await runtime.startVoiceFollow();
    const listener = lastDesktopListener();
    listener.onstart?.();
    assert.equal(h.state.voice, true);
    listener.onerror?.({ error: "device-lost" });
    listener.onend?.();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(h.state.voice, false);
    assert.equal(listener.starts, 1, "no restart onto another microphone");
    assert.equal(DesktopListener.made.length, 1);
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Your chosen microphone stopped working — pick it again or choose another.");
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); }
});

test("in the desktop app the list shows Windows' microphones, and a pick while following restarts the listener on it", async () => {
  const { ports, choice } = desktopMicrophoneHarness(DESKTOP_MIC_ONE);
  const runtime = startPrompter(ports);
  const mounted = mountPrompter({ window: win as unknown as Window, ports: runtime });
  const select = () => document.getElementById("pp-mic") as HTMLSelectElement;
  try {
    runtime.openPrompter();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(select().hidden, false);
    assert.deepEqual(Array.from(select().options, o => [o.value, o.textContent]), [["", "System default"], [DESKTOP_MIC_ONE, "Mic One"], [DESKTOP_MIC_TWO, "Mic Two"]]);
    assert.equal(select().value, DESKTOP_MIC_ONE);
    await runtime.startVoiceFollow();
    const first = lastDesktopListener();
    first.onstart?.();
    select().value = DESKTOP_MIC_TWO;
    select().dispatchEvent(new ((select().ownerDocument.defaultView) as Window & typeof globalThis).Event("change", { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(choice.saved, DESKTOP_MIC_TWO);
    assert.equal(first.stops, 1, "the old listener is stopped");
    assert.deepEqual(DesktopListener.made.map((m) => m.microphone), [DESKTOP_MIC_ONE, DESKTOP_MIC_TWO]);
  } finally { runtime.stopVoiceFollow(); mounted.dispose(); runtime.dispose(); }
});

test("a microphone chosen in another tab restarts a running Follow My Voice, and the same choice again does not", async () => {
  const { ports, heard, choice } = microphoneHarness("dev-1");
  const requests: MicRequest[] = [];
  const restore = installMicrophones(async (request) => {
    requests.push(request);
    return microphoneStream(request.audio !== true && request.audio.deviceId.exact === "dev-2" ? "Mic Two" : "Mic One").stream;
  });
  const runtime = startPrompter(ports);
  const fromAnotherTab = (value: string | null): void => {
    choice.saved = value ?? "";
    for (const listener of heard) listener({ name: "microphone", value, elsewhere: true });
  };
  try {
    runtime.openPrompter();
    await runtime.startVoiceFollow();
    fromAnotherTab("dev-1");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1, "the microphone already in use is not reopened");
    fromAnotherTab("dev-2");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests.at(-1), { audio: { deviceId: { exact: "dev-2" } } });
    assert.equal(document.getElementById("pp-voice-status")?.textContent, "Listening — Mic Two");
    assert.equal(requests.length, 2);
    assert.equal(choice.saved, "dev-2", "the restart writes nothing back, so two tabs cannot echo each other");
  } finally { runtime.stopVoiceFollow(); runtime.dispose(); restore(); }
});
