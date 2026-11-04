import { dom } from "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startPrompter } from "../../../src/features/prompter/prompter.ts";
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
