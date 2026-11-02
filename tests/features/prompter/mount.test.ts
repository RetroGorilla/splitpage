import test from "node:test";
import assert from "node:assert/strict";
import { mountPrompterVisibility, mountPrompterOpen, mountPrompter } from "../../../src/features/prompter/mount.ts";
import type { PrompterVisibilityPorts, PrompterOpenPorts, PrompterPorts } from "../../../src/features/prompter/mount.ts";
import { viewHarness } from "../view-harness.ts";
import type { Registration } from "../view-harness.ts";

const expected: readonly Registration[] = [
  [
    "document",
    "visibilitychange"
  ],
  [
    "btn-present",
    "click"
  ],
  [
    "pp-close",
    "click"
  ],
  [
    "pp-voice",
    "click"
  ],
  [
    "pp-play",
    "click"
  ],
  [
    "pp-speed",
    "input"
  ],
  [
    "pp-size",
    "input"
  ],
  [
    "pp-speed-down",
    "click"
  ],
  [
    "pp-speed-up",
    "click"
  ],
  [
    "pp-size-down",
    "click"
  ],
  [
    "pp-size-up",
    "click"
  ],
  [
    "prompter-scroll",
    "scroll",
    "B",
    true
  ],
  [
    "window",
    "resize"
  ],
  [
    "pp-skip-shot",
    "click"
  ],
  [
    "pp-mirror",
    "click"
  ],
  [
    "pp-flip",
    "click"
  ],
  [
    "pp-scene-mode",
    "click"
  ],
  [
    "pp-scene-prev",
    "click"
  ],
  [
    "pp-scene-next",
    "click"
  ],
  [
    "pp-fullscreen",
    "click"
  ],
  [
    "document",
    "focusin"
  ],
  [
    "window",
    "keydown"
  ]
];

export function setup() {
  const h = viewHarness();
  const p0: PrompterVisibilityPorts = {
    acquireWakeLock: h.log("acquireWakeLock"),
    isOpen: () => false
  };
  const p1: PrompterOpenPorts = {
    runFromButton: h.log("runFromButton")
  };
  const p2: PrompterPorts = {
    disposeRuntime: h.log("disposeRuntime"),
    closePrompter: h.log("closePrompter"),
    stopVoiceFollow: h.log("stopVoiceFollow"),
    startVoiceFollow: h.log("startVoiceFollow"),
    setPrompterPlaying: h.log("setPrompterPlaying"),
    setPrompterSpeed: h.log("setPrompterSpeed"),
    applyPrompterSize: h.log("applyPrompterSize"),
    stepPrompterSpeed: h.log("stepPrompterSpeed"),
    stepPrompterSize: h.log("stepPrompterSize"),
    updatePrompterStatus: h.log("updatePrompterStatus"),
    buildPrompterContent: h.log("buildPrompterContent"),
    updateVoiceAvailability: h.log("updateVoiceAvailability"),
    cueSceneForCurrentPosition: h.log("cueSceneForCurrentPosition"),
    updateSceneReadout: h.log("updateSceneReadout"),
    setPrompterMirror: h.log("setPrompterMirror"),
    setPrompterFlip: h.log("setPrompterFlip"),
    setPrompterSceneMode: h.log("setPrompterSceneMode"),
    stepScene: h.log("stepScene"),
    voiceActive: () => false,
    playing: () => false,
    isOpen: () => false,
    skipShot: () => false,
    setSkipShot: h.log("setSkipShot"),
    mirror: () => false,
    flip: () => false,
    sceneMode: () => false
  };
  const mount = () => [mountPrompterVisibility({ window: h.window, ports: p0 }), mountPrompterOpen({ window: h.window, ports: p1 }), mountPrompter({ window: h.window, ports: p2 })];
  return { ...h, mount, p0, p1, p2 };
}

test("prompter: every target, event, phase and multiplicity across dispose and remount", () => {
  const h = setup();
  h.assertRemount(h.mount, expected);
  h.window.close();
});

test("prompter: visibility requires an open prompter and stops after disposal", () => {
  const h = setup();
  let open = false;
  Object.defineProperty(h.document, "visibilityState", { configurable: true, value: "visible" });
  const owner = mountPrompterVisibility({ window: h.window, ports: { ...h.p0, isOpen: () => open } });
  h.fire(h.document, "visibilitychange");
  open = true;
  h.fire(h.document, "visibilitychange");
  Object.defineProperty(h.document, "visibilityState", { value: "hidden" });
  h.fire(h.document, "visibilitychange");
  owner.dispose();
  Object.defineProperty(h.document, "visibilityState", { value: "visible" });
  h.fire(h.document, "visibilitychange");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.name, "acquireWakeLock");
  const owns = h.calls[0]?.args[0] as () => boolean;
  assert.equal(owns(), false);
  h.window.close();
});

test("prompter: fullscreen includes the document's toast and dialog layers", async () => {
  const h = setup();
  let requested: Element | null = null;
  h.document.documentElement.requestFullscreen = async () => { requested = h.document.documentElement; };
  h.el("prompter").requestFullscreen = async () => { requested = h.el("prompter"); };
  const owner = mountPrompter({ window: h.window, ports: h.p2 });
  h.fire(h.el("pp-fullscreen"), "click");
  await Promise.resolve();
  assert.equal(requested, h.document.documentElement);
  owner.dispose();
  h.window.close();
});

test("prompter: focus stays in Present except for foreground dialogs and toasts", () => {
  const h = setup();
  const owner = mountPrompter({ window: h.window, ports: { ...h.p2, isOpen: () => true } });
  h.el("prompter").hidden = false;
  h.el("pp-play").focus();
  h.el("doc-title").focus();
  assert.equal(h.document.activeElement, h.el("pp-play"));
  const toast = h.document.createElement("div");
  toast.className = "toast";
  const dismiss = h.document.createElement("button");
  toast.append(dismiss);
  h.el("toast-host").append(toast);
  dismiss.focus();
  assert.equal(h.document.activeElement, dismiss);
  h.el("help-modal").hidden = false;
  h.el("help-close").focus();
  assert.equal(h.document.activeElement, h.el("help-close"));
  h.el("doc-title").focus();
  assert.equal(h.document.activeElement, h.el("help-close"));
  owner.dispose();
  h.el("doc-title").focus();
  assert.equal(h.document.activeElement, h.el("doc-title"));
  h.window.close();
});

test("prompter: foreground toast controls and dialogs keep their keys", () => {
  const h = setup();
  const owner = mountPrompter({ window: h.window, ports: { ...h.p2, isOpen: () => true } });
  const toast = h.document.createElement("div");
  toast.className = "toast";
  const dismiss = h.document.createElement("button");
  toast.append(dismiss);
  h.el("toast-host").append(toast);
  assert.equal(h.fire(dismiss, "keydown", { key: " " }).defaultPrevented, false);
  h.el("help-modal").hidden = false;
  assert.equal(h.fire(h.el("help-close"), "keydown", { key: "ArrowDown" }).defaultPrevented, false);
  h.fire(h.el("help-close"), "keydown", { key: "m" });
  h.fire(h.el("pp-play"), "keydown", { key: "ArrowDown" });
  assert.deepEqual(h.calls, []);
  owner.dispose();
  h.window.close();
});

test("prompter: first Escape exits fullscreen and the next closes Present", async () => {
  const h = setup();
  let fullscreen: Element | null = h.document.documentElement;
  Object.defineProperty(h.document, "fullscreenElement", { configurable: true, get: () => fullscreen });
  h.document.exitFullscreen = async () => { fullscreen = null; };
  const owner = mountPrompter({ window: h.window, ports: { ...h.p2, isOpen: () => true } });
  h.fire(h.el("pp-play"), "keydown", { key: "Escape" });
  await Promise.resolve();
  assert.equal(fullscreen, null);
  assert.deepEqual(h.calls, []);
  h.fire(h.el("pp-play"), "keydown", { key: "Escape" });
  assert.deepEqual(h.calls, [{ name: "closePrompter", args: [] }]);
  owner.dispose();
  h.window.close();
});

test("prompter: Help's earlier Escape handler can hide its modal and consume the key", () => {
  const h = setup();
  h.el("help-modal").hidden = false;
  const earlier = (event: Event): void => { h.el("help-modal").hidden = true; event.preventDefault(); };
  h.window.addEventListener("keydown", earlier);
  const owner = mountPrompter({ window: h.window, ports: { ...h.p2, isOpen: () => true } });
  try {
    assert.equal(h.fire(h.el("help-close"), "keydown", { key: "Escape" }).defaultPrevented, true);
    assert.equal(h.el("help-modal").hidden, true);
    assert.deepEqual(h.calls, []);
  } finally {
    owner.dispose();
    h.window.removeEventListener("keydown", earlier);
    h.window.close();
  }
});

test("prompter: shot skip rebuild order, scene readout and playback stay unchanged", () => {
  const h = setup();
  let skip = false;
  const owner = mountPrompter({ window: h.window, ports: {
    ...h.p2, skipShot: () => skip, setSkipShot: (value) => { skip = value; }, sceneMode: () => true
  } });
  h.el("prompter-scroll").scrollTop = 100;
  h.fire(h.el("pp-skip-shot"), "click");
  assert.equal(skip, true);
  assert.equal(h.el("pp-skip-shot").classList.contains("is-active"), true);
  assert.equal(h.el("prompter-scroll").scrollTop, 0);
  assert.deepEqual(h.calls.map((call) => call.name), ["stopVoiceFollow", "setPrompterPlaying", "buildPrompterContent", "applyPrompterSize", "updateVoiceAvailability", "cueSceneForCurrentPosition"]);
  assert.deepEqual(h.calls[1]?.args, [false]);
  owner.dispose();
  h.window.close();
});

test("prompter: editable exclusions, chord handling and scene keys retain their restrictions", () => {
  const h = setup();
  const owner = mountPrompter({ window: h.window, ports: { ...h.p2, isOpen: () => true } });
  h.fire(h.el("gdoc-url-input"), "keydown", { key: " " });
  h.fire(h.document.body, "keydown", { key: " ", ctrlKey: true });
  assert.deepEqual(h.calls, []);
  assert.equal(h.fire(h.document.body, "keydown", { key: " " }).defaultPrevented, true);
  h.fire(h.document.body, "keydown", { key: "ArrowUp", ctrlKey: true });
  h.fire(h.document.body, "keydown", { key: "ArrowDown" });
  h.fire(h.document.body, "keydown", { key: "m" });
  h.fire(h.document.body, "keydown", { key: "F" });
  h.fire(h.document.body, "keydown", { key: "ArrowLeft" });
  h.fire(h.document.body, "keydown", { key: "ArrowRight" });
  h.fire(h.document.body, "keydown", { key: "Escape" });
  assert.deepEqual(h.calls, [
    { name: "setPrompterPlaying", args: [true] }, { name: "stepPrompterSpeed", args: [1] }, { name: "stepPrompterSpeed", args: [-1] },
    { name: "setPrompterMirror", args: [true] }, { name: "setPrompterFlip", args: [true] },
    { name: "stepScene", args: [-1] }, { name: "stepScene", args: [1] }, { name: "closePrompter", args: [] }
  ]);
  owner.dispose();
  h.window.close();
});
