import type { HistoryPanelPorts, HistoryPanelControl } from "./ports.ts";
type HistoryCardMeta = Pick<HistorySnapshotMeta, "id" | "at" | "by" | "rows" | "title" | "label"> & Partial<Pick<HistorySnapshotMeta, "status" | "atMs" | "sizeBytes">>;
import type { HistorySnapshotMeta } from "../../application/recovery/history-ports.ts";
import { normalizeDocId } from "../../../shared/doc-id-policy.ts";
import { escapeHtml, safeId as safeIdFrom } from "../../core/document/text-policy.ts";
import { driveFormatSize } from "../../../shared/text.ts";
import { formatClock } from "../../../shared/clock.ts";
import { formatTimestamp } from "../common/comment-time.ts";

export function startHistoryPanel(ports: HistoryPanelPorts) {
  let active = true;
  const currentDocument = ports.document.current;
  const listDocHistory = ports.history.listDocHistory;
  const restoreSnapshot = ports.merge.restoreMergeSnapshot;
  const sidePanels = function () { return ports.panels; };
  const preferences = function () { return ports.preferences; };
  const personColors = ports.personColors;
  const getEditorName = ports.preferences.editorName;
  const showToast = ports.effects.show;
  const safeId = function (id: unknown, prefix: string) { return safeIdFrom(id, prefix, ports.ids); };
const RESTORE_ARM_MS = 4000;
const RESTORE_LABEL = "Restore this version";
const RESTORE_OLDER_LABEL = "Restore";
const RESTORE_ARMED_LABEL = "Could not keep a backup — restore anyway?";
let restoreArmedKey: string | null = null;
let restoreArmTimer: ReturnType<typeof setTimeout> | null = null;

function restoreCardKey(bucket: string | null, id: string | null) {
  return (bucket === "older" ? "older" : "doc") + "/" + id;
}

function restoreButtonLabel(bucket: string | null, armed: boolean) {
  if (armed) return RESTORE_ARMED_LABEL;
  return bucket === "older" ? RESTORE_OLDER_LABEL : RESTORE_LABEL;
}

function applyRestoreArm() {
  const panel = document.getElementById("history-panel");
  if (!panel) return;
  Array.prototype.forEach.call(panel.querySelectorAll('[data-action="restore-snapshot"]'), function (b: HTMLButtonElement) {
    const bucket = b.getAttribute("data-bucket");
    const armed = restoreArmedKey !== null &&
      restoreCardKey(bucket, b.getAttribute("data-id")) === restoreArmedKey;
    b.classList.toggle("armed", armed);
    (b.querySelector(".history-restore-label") || b).textContent = restoreButtonLabel(bucket, armed);
    const snap = armed ? b.closest(".history-snap") : null;
    if (snap) (snap as HTMLDetailsElement).open = true;
  });
}

function disarmRestore() {
  clearTimeout(restoreArmTimer as ReturnType<typeof setTimeout> | undefined);
  restoreArmTimer = null;
  restoreArmedKey = null;
  applyRestoreArm();
}

function restoreSnapshotFromCard(btn: Element | null): ReturnType<HistoryPanelControl["restoreSnapshotFromCard"]> {
  if (!btn) return;
  const id = btn.getAttribute("data-id") || "";
  const older = btn.getAttribute("data-bucket") === "older";
  const key = restoreCardKey(older ? "older" : "doc", id);
  const force = restoreArmedKey === key;
  if (force) disarmRestore();
  return restoreSnapshot(id, { older: older, force: force }).then(function (r) {
    if (!active) return r;
    if (r === "no-backup") {
      clearTimeout(restoreArmTimer as ReturnType<typeof setTimeout> | undefined);
      restoreArmedKey = key;
      applyRestoreArm();
      restoreArmTimer = setTimeout(disarmRestore, RESTORE_ARM_MS);
    } else if (r === "missing") {
      showToast("That version is no longer in the history.", "warn");
      renderHistory();
    } else if (r === "corrupt") {
      showToast("That version could not be read, so nothing was restored.", "warn");
    } else if (r === "changed") {
      showToast("A different document was opened while restoring, so nothing was restored.", "warn");
    } else if (r === "refused") {
      const can = ports.capability.history();
      if (!can.allowed) showToast(can.reason, "warn");
    }
    return r;
  }, function (e) {
    if (window.console) console.error(e);
    return "corrupt";
  });
}

function openHistoryPanel() {
  sidePanels().open("history-panel");
  renderHistory();
}
let historyRenderToken = 0;
let historyShownDocId: string | null = null;

const HISTORY_SUBTITLES: Record<string, string> = {
  idb: "Snapshots of this document, kept in this browser before anything that could overwrite your work.",
  desktop: "Snapshots of this document, kept on this computer before anything that could overwrite your work.",
  memory: "Snapshots of this document, kept only until this page closes — this browser isn't letting Splitpage store them."
};
const HISTORY_SUBTITLE_DEFAULT = "Snapshots of this document, kept before anything that could overwrite your work.";

const HISTORY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HISTORY_RESTORE_HINT = "Replaces what's on screen, which is saved here first.";

let historyOpenKey: string | null = null;
let historyToggleBound = false;

function historyFig(text: string) {
  return '<span class="history-fig">' + escapeHtml(text) + '</span>';
}

function historyWhen(m: HistoryCardMeta) {
  let d = new Date(m && m.at);
  if (isNaN(d.getTime()) && m && Number(m.atMs) > 0) d = new Date(Number(m.atMs));
  return isNaN(d.getTime()) ? null : d;
}

function historyDayKey(d: Date | null) {
  return d ? d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate() : "";
}

function historyDay(d: Date | null) {
  if (!d) return { word: "Date unknown", date: "" };
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const key = historyDayKey(d);
  return {
    word: key === historyDayKey(now) ? "Today" : key === historyDayKey(yesterday) ? "Yesterday" : "",
    date: d.getDate() + " " + HISTORY_MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "")
  };
}

function historyClock(d: Date | null) {
  return d ? formatClock(d, preferences().clock()) : "";
}

function historyClockWide() {
  return formatClock(new Date(2000, 0, 1, 12, 52), preferences().clock()).length > 5;
}

function historySavedHtml(d: Date | null) {
  if (!d) return "Date unknown";
  const day = historyDay(d);
  return (day.word ? escapeHtml(day.word) : historyFig(day.date)) + " at " + historyFig(historyClock(d));
}

function historyBeatsHtml(n: number) {
  return historyFig(String(n)) + " beat" + (n === 1 ? "" : "s");
}

function historyDamageHtml(count: number | undefined) {
  if (!count) return "";
  return '<p class="history-empty history-notice">' + count + ' damaged snapshot' + (count === 1 ? '' : 's') +
    ' could not be listed. Stored history has been kept.</p>';
}

function historySizeText(bytes: unknown) {
  const n = Number(bytes);
  const gb = 1024 * 1024 * 1024;
  if (!(n >= gb)) return driveFormatSize(n);
  return (n / gb).toFixed(1).replace(/\.0$/, "") + " GB";
}

function historySizeHtml(bytes: unknown) {
  const text = historySizeText(Math.max(0, Math.floor(Number(bytes) || 0)));
  const parts = /^([\d.]+) (.+)$/.exec(text);
  return parts ? historyFig(parts[1] as string) + " " + escapeHtml(parts[2] as string) : escapeHtml(text);
}

function historyInitials(name: string) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0] as string)[0] || "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1] as string)[0] || "") : "";
  return (first + last).toUpperCase();
}

function historyPersonHtml(name: string) {
  name = String(name || "").trim();
  if (!name) return '<span class="history-none">—</span>';
  return '<span class="person-avatar" style="--size: 20px; --presence: ' + escapeHtml(personColors.personColor(name)) + '" aria-hidden="true">' +
      escapeHtml(historyInitials(name)) + '</span>' +
    '<span class="history-person">' + escapeHtml(name) + '</span>';
}

function historyCardHtml(m: HistoryCardMeta, bucket: string) {
  const status = m.status === "writing" || m.status === "pending" ? m.status : "stored";
  const rows = Math.max(0, Math.floor(Number(m.rows) || 0));
  const armed = restoreArmedKey !== null && restoreCardKey(bucket, m.id) === restoreArmedKey;
  const id = safeId(m.id, "s");
  const when = historyWhen(m);
  const label = escapeHtml(restoreButtonLabel(bucket, armed));

  if (bucket === "older") {
    const titleId = "history-older-title-" + id;
    return '<li class="history-card history-older-item">' +
      '<div class="history-older-text">' +
        '<span class="history-card-doc" id="' + escapeHtml(titleId) + '">' + escapeHtml(m.title || "Untitled") + '</span>' +
        '<span class="history-older-meta">' + historySavedHtml(when) + (m.label ? " · " + escapeHtml(m.label) : "") + '</span>' +
      '</div>' +
      '<button type="button" class="btn-outline is-small history-older-restore' + (armed ? " armed" : "") + '" data-action="restore-snapshot"' +
        ' data-id="' + escapeHtml(id) + '" data-bucket="older" aria-describedby="' + escapeHtml(titleId) + '">' +
        '<span class="history-restore-label">' + label + '</span></button>' +
    '</li>';
  }

  const key = restoreCardKey("doc", id);
  const size = historySizeHtml(m.sizeBytes);
  return '<li class="history-card' + (status === "writing" ? " is-writing" : status === "pending" ? " is-pending" : "") + '">' +
    '<details class="history-snap" data-snap="' + escapeHtml(key) + '"' + (armed || key === historyOpenKey ? " open" : "") + '>' +
      '<summary class="history-row">' +
        '<time class="history-time' + (historyClockWide() ? " is-wide" : "") + '"' + (when ? ' datetime="' + escapeHtml(when.toISOString()) + '"' : "") + '>' +
          escapeHtml(when ? historyClock(when) : "—") + '</time>' +
        '<span class="history-card-label">' + escapeHtml(m.label || "Snapshot") +
          (status === "pending" ? '<span class="history-card-badge" title="Kept in this window only, and tried again after the next successful write">Not stored</span>' : "") +
        '</span>' +
        '<span class="history-scenes">' + historyBeatsHtml(rows) + '</span>' +
      '</summary>' +
      '<div class="history-detail">' +
        '<dl class="history-facts">' +
          '<dt>Saved</dt><dd><span>' + historySavedHtml(when) + '</span></dd>' +
          '<dt>Saved by</dt><dd>' + historyPersonHtml(m.by) + '</dd>' +
          '<dt>Script at the time</dt><dd><span>' + historyBeatsHtml(rows) + '</span></dd>' +
          (size ? '<dt>Snapshot size</dt><dd><span>' + size + '</span></dd>' : "") +
        '</dl>' +
        '<div class="history-restore">' +
          '<button type="button" class="btn-outline history-restore-btn' + (armed ? " armed" : "") + '" data-action="restore-snapshot"' +
            ' data-id="' + escapeHtml(id) + '">' +
            '<svg aria-hidden="true" focusable="false"><use href="#i-history"/></svg>' +
            '<span class="history-restore-label">' + label + '</span></button>' +
          '<p class="history-restore-hint">' + escapeHtml(HISTORY_RESTORE_HINT) + '</p>' +
        '</div>' +
      '</div>' +
    '</details>' +
  '</li>';
}

function historyDaysHtml(entries: HistorySnapshotMeta[]) {
  const days: { when: Date | null; items: HistorySnapshotMeta[] }[] = [];
  const byDay: Record<string, { when: Date | null; items: HistorySnapshotMeta[] }> = Object.create(null);
  entries.forEach(function (m) {
    const when = historyWhen(m);
    const key = historyDayKey(when);
    if (!byDay[key]) {
      byDay[key] = { when: when, items: [] };
      days.push(byDay[key] as NonNullable<typeof byDay[string]>);
    }
    (byDay[key] as NonNullable<typeof byDay[string]>).items.push(m);
  });
  return days.map(function (g, i) {
    const day = historyDay(g.when);
    return '<section class="history-day" aria-labelledby="history-day-' + i + '">' +
      '<h3 class="history-day-head" id="history-day-' + i + '">' +
        (day.word ? '<span>' + escapeHtml(day.word) + '</span>' : "") +
        (day.date ? historyFig(day.date) : "") +
      '</h3>' +
      '<ol class="history-day-list">' + g.items.map(function (m) { return historyCardHtml(m, "doc"); }).join("") + '</ol>' +
    '</section>';
  }).join("");
}

function onHistoryRowToggle(e: Event) {
  const snap = e.target as HTMLDetailsElement | null;
  if (!snap || !snap.classList || !snap.classList.contains("history-snap")) return;
  const key = snap.getAttribute("data-snap");
  if (snap.open) {
    historyOpenKey = key;
    Array.prototype.forEach.call((e.currentTarget as HTMLElement).querySelectorAll(".history-snap[open]"), function (other) {
      if (other !== snap) other.open = false;
    });
  } else if (historyOpenKey === key) {
    historyOpenKey = null;
  }
}

function historyUsageHtml(backend: string | null, usage: unknown) {
  if (!usage || typeof usage !== "object") return "";
  if ((usage as Record<string, unknown>).readOnly && backend === "desktop") {
    return "Version history is read-only: it was written by a newer version of Splitpage.";
  }
  const used = historySizeText((usage as Record<string, unknown>).totalBytes) || "0 KB";
  const cap = Number((usage as Record<string, unknown>).capBytes);
  const docs = Math.max(0, Math.floor(Number((usage as Record<string, unknown>).docCount) || 0));
  let html = "Version history uses " + historyFig(used) +
    (backend !== "memory" && isFinite(cap) && cap > 0 ? " of " + historyFig(historySizeText(cap)) : "") +
    " across " + historyFig(String(docs)) + " document" + (docs === 1 ? "" : "s") + ".";
  if ((usage as Record<string, unknown>).overCap) html += " It is over its limit, so older snapshots are being removed first.";
  return html;
}

async function renderHistory() {
  const listEl = document.getElementById("history-list");
  const panel = document.getElementById("history-panel");
  if (!listEl || !panel || panel.hidden || !currentDocument()) return;
  if (!historyToggleBound) {
    historyToggleBound = true;
    listEl.addEventListener("toggle", onHistoryRowToggle, true);
  }
  const token = ++historyRenderToken;
  const docId = normalizeDocId((currentDocument() as NonNullable<ReturnType<typeof currentDocument>>).docId);
  if (historyShownDocId !== docId) {
    historyShownDocId = docId;
    listEl.innerHTML = "";
  }
  let data;
  try {
    data = await listDocHistory(docId);
  } catch (e) {
    if (window.console) console.error(e);
    return;
  }
  if (token !== historyRenderToken) return;
  if (!currentDocument() || panel.hidden) return;
  if (normalizeDocId((currentDocument() as NonNullable<ReturnType<typeof currentDocument>>).docId) !== docId) {
    return renderHistory();
  }
  data = data || {};

  const subtitle = document.getElementById("history-subtitle");
  if (subtitle) subtitle.textContent = HISTORY_SUBTITLES[data.backend as string] || HISTORY_SUBTITLE_DEFAULT;

  const entries = Array.isArray(data.entries) ? data.entries : [];
  const notice = typeof data.notice === "string" ? data.notice : "";
  const damage = historyDamageHtml(data.damaged);
  if (damage) {
    listEl.innerHTML = damage + historyDaysHtml(entries);
  } else if (!entries.length && notice) {
    listEl.innerHTML = '<p class="history-empty history-notice">' + escapeHtml(notice) + '</p>';
  } else if (!entries.length) {
    listEl.innerHTML = '<p class="history-empty">No snapshots of this document yet. Splitpage saves one automatically before anything that could overwrite your work — opening a document, replacing rows, or merging someone else\'s changes.</p>';
  } else {
    listEl.innerHTML = historyDaysHtml(entries);
  }

  const olderEl = document.getElementById("history-older");
  const olderCount = document.getElementById("history-older-count");
  const olderList = document.getElementById("history-older-list");
  const older = Array.isArray(data.older) ? data.older : [];
  if (olderEl) olderEl.hidden = !older.length && !data.olderDamaged;
  if (olderCount) olderCount.textContent = String(older.length);
  if (olderList) {
    olderList.innerHTML = historyDamageHtml(data.olderDamaged) + older.map(function (m) {
      return historyCardHtml({
        id: m.id, label: m.label, at: m.at, by: m.by, rows: m.rows, title: m.title, status: "stored"
      }, "older");
    }).join("");
  }

  const usageEl = document.getElementById("history-usage");
  if (usageEl) {
    const usageHtml = notice ? (entries.length ? escapeHtml(notice) : "") : historyUsageHtml(data.backend, data.usage);
    usageEl.innerHTML = usageHtml;
    usageEl.hidden = !usageHtml;
  }
}

function toastLastEditor(loaded: Parameters<HistoryPanelControl["toastLastEditor"]>[0]) {
  if (loaded.lastEditedBy && loaded.lastEditedBy !== getEditorName()) {
    showToast("Opened the latest version — last edited by " + loaded.lastEditedBy, "ok");
  }
}


  function restored(snap: Parameters<HistoryPanelControl["restored"]>[0], opts: Parameters<HistoryPanelControl["restored"]>[1]) {
    sidePanels().close("history-panel");
    showToast(opts.restoredText || "Restored the version from " + formatTimestamp(snap.meta && snap.meta.at, preferences().clock()), "ok");
  }
  function guarded<T extends unknown[], R>(fn: (...args: T) => R) {
    return function (...args: T) {
      if (!active) throw new Error("The history panel is not started yet");
      return fn(...args);
    };
  }
  return {
    openHistoryPanel: guarded(openHistoryPanel), renderHistory: guarded(renderHistory),
    restoreSnapshotFromCard: guarded(restoreSnapshotFromCard), toastLastEditor: guarded(toastLastEditor), restored: guarded(restored),
    dispose: function () {
      if (!active) return;
      active = false;
      ++historyRenderToken;
      clearTimeout(restoreArmTimer as ReturnType<typeof setTimeout> | undefined);
      const list = document.getElementById("history-list");
      if (list && historyToggleBound) list.removeEventListener("toggle", onHistoryRowToggle, true);
    }
  };
}
