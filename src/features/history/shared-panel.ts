import type { SharedHistoryPanelPort, SharedHistoryPreview, SharedHistorySource, SharedHistoryVersion } from "./ports.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import { escapeHtml, storedImageMarkup } from "../../core/document/text-policy.ts";
import { normalizeImageRef } from "../../../shared/blob-policy.ts";
import { toHtml } from "../../core/text/html.ts";

const OFFLINE = "You’re offline. Connect to see shared versions.";

export function createSharedHistoryPanel(ports: SharedHistoryPanelPort, formatTime: (time: Date) => string,
  notice: NoticePort["show"], renderHistory: () => Promise<void>) {
  let request: AbortController | undefined;
  let preview: SharedHistoryPreview | undefined;
  let versions: readonly SharedHistoryVersion[] = [];
  let source: SharedHistorySource | null = null;
  let online = false, active = false;

  function listElement() { return document.getElementById("history-list"); }
  function visible() { return document.getElementById("history-panel")?.hidden === false; }

  function reset() {
    request?.abort();
    request = undefined;
    preview = undefined;
    versions = [];
    active = ports.active();
    source = ports.current();
    online = source?.online() ?? false;
  }

  function message(text: string) {
    const list = listElement();
    if (list) list.innerHTML = '<p class="history-empty" role="status">' + escapeHtml(text) + '</p>';
  }

  const unsubscribe = ports.onChange(() => {
    const next = ports.current();
    if (visible() && (active !== ports.active() || source !== next || online !== (next?.online() ?? false))) {
      void renderHistory();
    }
  });

  function begin() {
    request?.abort();
    request = new AbortController();
    return request.signal;
  }

  function current(signal: AbortSignal): boolean {
    return !signal.aborted && visible() && ports.current() === source && !!source?.online();
  }

  async function render() {
    reset();
    if (!active) return;
    const subtitle = document.getElementById("history-subtitle");
    if (subtitle) subtitle.textContent = "Versions kept by the relay for this shared script.";
    for (const id of ["history-older", "history-usage"]) {
      const element = document.getElementById(id);
      if (element) { element.hidden = true; }
    }
    if (!source || !online) { message(OFFLINE); return; }
    message("Loading versions…");
    const signal = begin();
    try {
      const listed = await source.list(signal);
      if (!current(signal)) return;
      versions = listed;
      const list = listElement();
      if (!listed.length || !list) { message("No shared versions yet."); return; }
      list.innerHTML = '<ol class="history-day-list shared-history-versions">' + listed.map(version => {
        const when = new Date(version.at);
        const who = version.names.join(" · ") || "Editors unnamed";
        return '<li class="history-card"><button type="button" class="btn-outline shared-history-version" data-shared-version="' +
          escapeHtml(version.id) + '"><time datetime="' + when.toISOString() + '">' + escapeHtml(formatTime(when)) +
          '</time><span>' + escapeHtml(who) + '</span></button></li>';
      }).join("") + '</ol>';
    } catch {
      if (!signal.aborted && visible()) message(source?.online() ? "Could not load versions. Check your connection and reopen Version history." : OFFLINE);
    }
  }

  async function open(version: SharedHistoryVersion) {
    const from = source;
    if (!from) return;
    const signal = begin();
    message("Opening version…");
    try {
      const opened = await from.read(version.id, signal);
      if (!current(signal)) return;
      preview = opened;
      const list = listElement();
      if (!list) return;
      list.innerHTML = '<section class="shared-history-preview" contenteditable="false" aria-label="Read-only version">' +
        '<div class="shared-history-actions"><button type="button" class="btn-outline" data-shared-history="back">Back to versions</button>' +
        '<button type="button" class="btn-outline" data-shared-history="save">Save a copy…</button></div>' +
        '<h3 tabindex="-1">' + escapeHtml(opened.title) + '</h3><p class="history-older-meta">Read-only · ' +
        escapeHtml(formatTime(new Date(version.at))) + '</p><div class="shared-history-beats">' +
        opened.outline.map((entry, index) => {
          if ("heading" in entry) return '<h4>' + escapeHtml(entry.heading) + '</h4>';
          const beat = entry.beat;
          const picture = normalizeImageRef(beat.fields.imageRef);
          return '<article><div>' + (picture ? storedImageMarkup(picture) : "") +
            toHtml(beat.visual) + '</div><div>' + toHtml(beat.narration) + '</div>' +
            '<button type="button" class="btn-outline" data-shared-history="put-back" data-beat-index="' + index +
            '">Put this beat back</button></article>';
        }).join("") + '</div></section>';
      list.querySelector<HTMLElement>("h3")?.focus();
      void opened.loadPictures(signal).catch(() => {});
    } catch {
      if (!signal.aborted && visible()) {
        const list = listElement();
        if (list) {
          message(from.online() ? "Could not open this version. Check your connection and try again." : OFFLINE);
          list.insertAdjacentHTML("beforeend", '<button type="button" class="btn-outline" data-shared-history="back">Back to versions</button>');
          list.querySelector("button")?.focus();
        }
      }
    }
  }

  async function save(button: HTMLButtonElement, opened: SharedHistoryPreview, signal: AbortSignal) {
    button.disabled = true;
    try {
      await opened.saveCopy(signal);
    } catch {
      if (current(signal)) notice("Could not save this version. Check that its pictures are available and try again.", "warn");
    } finally {
      button.disabled = false;
    }
  }

  function click(event: MouseEvent): boolean {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-shared-history], button[data-shared-version]");
    if (!button) return false;
    const { sharedVersion, sharedHistory, beatIndex } = button.dataset;
    const version = versions.find(entry => entry.id === sharedVersion);
    if (version) void open(version);
    if (sharedHistory === "back") void render();
    const signal = request?.signal;
    if (!preview || !signal || !current(signal)) return true;
    if (sharedHistory === "save") void save(button, preview, signal);
    if (sharedHistory === "put-back") {
      const entry = preview.outline[Number(beatIndex)];
      if (entry && "beat" in entry) {
        if (source?.putBack(entry.beat)) notice("Put the beat back in the shared script.", "ok");
        else notice("Could not put this beat back. Check that the shared script can be edited.", "warn");
      }
    }
    return true;
  }

  return { render, click, reset, dispose() { unsubscribe(); reset(); } };
}
