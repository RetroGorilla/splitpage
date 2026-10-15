import { createViewLifetime } from "../view-lifetime.ts";

export interface PrompterVisibilityPorts {
  readonly acquireWakeLock: (owns: () => boolean) => void;
  readonly isOpen: () => boolean;
}

export function mountPrompterVisibility(mount: { window: Window; ports: PrompterVisibilityPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  life.listen(document, "visibilitychange", function () {
    if (document.visibilityState === "visible" && ports.isOpen()) ports.acquireWakeLock(life.active);
  });
  return { dispose: life.dispose };
}

export interface PrompterOpenPorts {
  readonly runFromButton: (id: string) => void;
}

export function mountPrompterOpen(mount: { window: Window; ports: PrompterOpenPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("btn-present"), "click", function () { ports.runFromButton("present"); });
  return { dispose: life.dispose };
}

export interface PrompterPorts {
  readonly disposeRuntime: () => void;
  readonly closePrompter: () => void;
  readonly stopVoiceFollow: () => void;
  readonly startVoiceFollow: () => void;
  readonly setPrompterPlaying: (value: boolean) => void;
  readonly setPrompterSpeed: (value: number) => void;
  readonly applyPrompterSize: () => void;
  readonly stepPrompterSpeed: (value: number) => void;
  readonly stepPrompterSize: (value: number) => void;
  readonly updatePrompterStatus: () => void;
  readonly buildPrompterContent: () => void;
  readonly updateVoiceAvailability: () => void;
  readonly cueSceneForCurrentPosition: () => void;
  readonly updateSceneReadout: () => void;
  readonly setPrompterMirror: (value: boolean) => void;
  readonly setPrompterFlip: (value: boolean) => void;
  readonly setPrompterSceneMode: (value: boolean) => void;
  readonly stepScene: (value: number) => void;
  readonly voiceActive: () => boolean;
  readonly playing: () => boolean;
  readonly isOpen: () => boolean;
  readonly skipShot: () => boolean;
  readonly setSkipShot: (value: boolean) => void;
  readonly mirror: () => boolean;
  readonly flip: () => boolean;
  readonly sceneMode: () => boolean;
}

export function mountPrompter(mount: { window: Window; ports: PrompterPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  life.release(ports.disposeRuntime);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("pp-close"), "click", ports.closePrompter);
  life.listen(element("pp-voice"), "click", function () {
    if (ports.voiceActive()) ports.stopVoiceFollow(); else ports.startVoiceFollow();
  });
  life.listen(element("pp-play"), "click", function () { ports.setPrompterPlaying(!ports.playing()); });
  life.listen(element("pp-speed"), "input", function (e) { ports.setPrompterSpeed(Number(e.target.value)); });
  life.listen(element("pp-size"), "input", ports.applyPrompterSize);
  life.listen(element("pp-speed-down"), "click", function () { ports.stepPrompterSpeed(-1); });
  life.listen(element("pp-speed-up"), "click", function () { ports.stepPrompterSpeed(1); });
  life.listen(element("pp-size-down"), "click", function () { ports.stepPrompterSize(-1); });
  life.listen(element("pp-size-up"), "click", function () { ports.stepPrompterSize(1); });
  life.listen(element("prompter-scroll"), "scroll", ports.updatePrompterStatus, { passive: true });
  life.listen(window, "resize", ports.updatePrompterStatus);
  life.listen(element("pp-skip-shot"), "click", function (e) {
    ports.setSkipShot(!ports.skipShot());
    e.currentTarget.classList.toggle("is-active", ports.skipShot());
    ports.stopVoiceFollow();
    ports.setPrompterPlaying(false);
    ports.buildPrompterContent();
    ports.applyPrompterSize();
    element("prompter-scroll").scrollTop = 0;
    ports.updateVoiceAvailability();
    if (ports.sceneMode()) ports.cueSceneForCurrentPosition(); else ports.updateSceneReadout();
  });
  life.listen(element("pp-mirror"), "click", function () {
    ports.setPrompterMirror(!ports.mirror());
  });
  life.listen(element("pp-flip"), "click", function () {
    ports.setPrompterFlip(!ports.flip());
  });
  life.listen(element("pp-scene-mode"), "click", function () {
    ports.setPrompterSceneMode(!ports.sceneMode());
  });
  life.listen(element("pp-scene-prev"), "click", function () { ports.stepScene(-1); });
  life.listen(element("pp-scene-next"), "click", function () { ports.stepScene(1); });
  life.listen(element("pp-fullscreen"), "click", function () {
    const el = element("prompter");
    if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
    else if (el.requestFullscreen) { el.requestFullscreen().catch(function () {}); }
  });

  life.listen(window, "keydown", function (e) {
    if (!ports.isOpen()) return;
    const target = e.target;
    if (target && target.closest && !target.closest("#rows") && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const chord = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key === "Escape") { ports.closePrompter(); }
    else if (e.key === " ") { if (!chord) { e.preventDefault(); ports.setPrompterPlaying(!ports.playing()); } }
    else if (e.key === "ArrowUp") { if (!chord) e.preventDefault(); ports.stepPrompterSpeed(1); }
    else if (e.key === "ArrowDown") { if (!chord) e.preventDefault(); ports.stepPrompterSpeed(-1); }
    else if (!chord && (e.key === "m" || e.key === "M")) { e.preventDefault(); ports.setPrompterMirror(!ports.mirror()); }
    else if (!chord && (e.key === "f" || e.key === "F")) { e.preventDefault(); ports.setPrompterFlip(!ports.flip()); }
    else if (e.key === "ArrowLeft") { if (!chord) e.preventDefault(); ports.stepScene(-1); }
    else if (e.key === "ArrowRight") { if (!chord) e.preventDefault(); ports.stepScene(1); }
  });
  return { dispose: life.dispose };
}
