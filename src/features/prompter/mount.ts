import type { PrompterOpenPorts, PrompterPorts } from "./ports.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";
import { IS_MAC, keyChipsHtml } from "../common/key-chips.ts";

const PRESENT_IN_BROWSER_KEYS = "mod+shift+p";

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

export function mountPrompterOpen(mount: { window: Window; ports: PrompterOpenPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLElement | null => document.getElementById(id);
  const present = element("btn-present");
  if (present) life.listen(present, "click", function () { ports.runFromButton("present"); });
  const split = element("present-split");
  const more = element("btn-present-more");
  const menu = element("present-menu");
  const browser = element("present-menu-browser");
  if (!split || !more || !menu || !browser) return { dispose: life.dispose };
  const parts = { split, more, menu, browser };
  if (!browser.querySelector(".mi-keys")) {
    const keys = document.createElement("span");
    keys.className = "mi-keys";
    keys.setAttribute("aria-hidden", "true");
    keys.innerHTML = keyChipsHtml(PRESENT_IN_BROWSER_KEYS);
    browser.appendChild(keys);
    browser.setAttribute("aria-keyshortcuts", (IS_MAC ? "Meta" : "Control") + "+Shift+P");
  }

  function setOpen(open: boolean, focus: "item" | "button" | null): void {
    parts.menu.hidden = !open;
    parts.more.setAttribute("aria-expanded", open ? "true" : "false");
    if (focus === "item") parts.browser.focus();
    else if (focus === "button") parts.more.focus();
  }

  function refresh(): void {
    const offered = ports.presentInBrowser.offered();
    parts.more.hidden = !offered;
    parts.split.classList.toggle("has-more", offered);
    if (!offered && !parts.menu.hidden) setOpen(false, null);
  }

  life.listen(more, "click", function (e) {
    if (!parts.menu.hidden) { setOpen(false, null); return; }
    setOpen(true, e.detail === 0 ? "item" : null);
  });
  life.listen(more, "keydown", function (e) {
    if (e.key === "Escape" && !parts.menu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false, null);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    setOpen(true, "item");
  });
  life.listen(browser, "click", function () {
    setOpen(false, "button");
    ports.runFromButton("prompter-open-in-browser");
  });
  life.listen(menu, "keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false, "button");
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      parts.browser.focus();
    } else if (e.key === "Tab") {
      setOpen(false, null);
    }
  });
  life.listen(split, "focusout", function (e) {
    const next = e.relatedTarget as Node | null;
    if (!parts.menu.hidden && !(next && parts.split.contains(next))) setOpen(false, null);
  });
  life.release(ports.presentInBrowser.onChange(refresh));
  refresh();
  return { dispose: life.dispose };
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
  life.listen(element("pp-mic"), "change", function (e) { ports.chooseMicrophone(e.target.value); });
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
    if (ports.beatMode()) ports.cueBeatForCurrentPosition(); else ports.updateBeatReadout();
  });
  life.listen(element("pp-mirror"), "click", function () {
    ports.setPrompterMirror(!ports.mirror());
  });
  life.listen(element("pp-flip"), "click", function () {
    ports.setPrompterFlip(!ports.flip());
  });
  life.listen(element("pp-scene-mode"), "click", function () {
    ports.setPrompterBeatMode(!ports.beatMode());
  });
  life.listen(element("pp-scene-prev"), "click", function () { ports.stepBeat(-1); });
  life.listen(element("pp-scene-next"), "click", function () { ports.stepBeat(1); });
  life.listen(element("pp-fullscreen"), "click", function () {
    const el = document.documentElement;
    if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
    else if (el.requestFullscreen) { el.requestFullscreen().catch(function () {}); }
  });

  life.listen(document, "focusin", function (e) {
    if (!ports.isOpen()) return;
    if (e.target.closest?.('.toast:not(.is-leaving)')) return;
    const modal = document.querySelector<HTMLElement>('.modal-backdrop:not([hidden]), #cmdk:not([hidden])');
    if (modal) {
      if (!modal.contains(e.target)) modal.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')?.focus({ preventScroll: true });
      return;
    }
    if (!e.target.closest?.('#prompter, #findbar.is-present:not([hidden])')) element("pp-play").focus({ preventScroll: true });
  });

  life.listen(window, "keydown", function (e) {
    if (!ports.isOpen() || e.defaultPrevented) return;
    const target = e.target;
    if (target?.closest?.('.toast') || document.querySelector('.modal-backdrop:not([hidden]), #cmdk:not([hidden])')) return;
    if (e.key === "Escape" && ports.closeFind()) { e.preventDefault(); return; }
    if (target?.closest?.('#findbar.is-present')) return;
    if (target && target.closest && !target.closest("#rows") && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const chord = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key === "Escape") {
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      else ports.closePrompter();
    }
    else if (e.key === " ") { if (!chord) { e.preventDefault(); ports.setPrompterPlaying(!ports.playing()); } }
    else if (e.key === "ArrowUp") { if (!chord) e.preventDefault(); ports.stepPrompterSpeed(1); }
    else if (e.key === "ArrowDown") { if (!chord) e.preventDefault(); ports.stepPrompterSpeed(-1); }
    else if (!chord && (e.key === "m" || e.key === "M")) { e.preventDefault(); ports.setPrompterMirror(!ports.mirror()); }
    else if (!chord && (e.key === "f" || e.key === "F")) { e.preventDefault(); ports.setPrompterFlip(!ports.flip()); }
    else if (e.key === "ArrowLeft") { if (!chord) e.preventDefault(); ports.stepBeat(-1); }
    else if (e.key === "ArrowRight") { if (!chord) e.preventDefault(); ports.stepBeat(1); }
  });
  return { dispose: life.dispose };
}
