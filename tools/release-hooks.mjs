const HOOK_NAME = /__(?:[A-Za-z]+Test|splitpageFormats)\b/g;

export function helpMarkdown(markdown, collabUi) {
  if (collabUi) return markdown;
  return markdown.split(/(?=^## )/m).filter(section => !/^## Collaboration\r?\n/.test(section)).join("");
}

export const STILL_IN_RELEASE = Object.freeze([]);

export const HISTORY_TEST_NAMES = Object.freeze([
  "bodyCount", "clearFaults", "docRecord", "dropBody", "failNext", "forceBackend", "hasBody",
  "importGateHit", "injectFault", "inspect", "listRaw", "prepareResetForTest", "releaseDelayedImport",
  "releaseDelayedPut", "resetForTest", "setCapOverride", "setDesktopTimeout", "setExportCap", "setNow", "testControls",
  "delay-import", "delay-put", "idb-open-fail", "import-fail", "io-always", "quota-always", "quota-once"
]);

export function historyTestNames(text) {
  return HISTORY_TEST_NAMES.filter((name) => new RegExp("\\b" + name + "\\b").test(text)).sort();
}

export function hookNames(text) {
  return [...new Set(text.match(HOOK_NAME) ?? [])].sort();
}

const TIMING_MARK = /measure:[A-Za-z0-9_-]+:(?:start|end)\b/g;

export function timingMarkNames(text) {
  return [...new Set(text.match(TIMING_MARK) ?? [])].sort();
}

export function leakedHooks(text) {
  return [...hookNames(text).filter((name) => !STILL_IN_RELEASE.includes(name)), ...historyTestNames(text), ...timingMarkNames(text)].sort();
}

const COLLABORATION_MARKERS = [
  "settings-collaboration", "Set up relay…", "splitpageInvitation", "splitpage://relay-setup",
  "relayOwner", "splitpage:relay-owner-", "splitpage:relay-setup-",
  'url.searchParams.has("join")', "join-script", "join-script-modal", "Join a shared script…",
  "leave-script-modal", "Leave shared script",
  "share-script", "Share this script…", "share-script-modal", "splitpage:relay-owner-share-create",
  "Shared scripts on this device", "note-shared", "focus-shared", "invalid-saved-relay",
  "shared-pill", "shared-popover", "sharing-and-people", "leave-shared-script", "splitpage:relay-owner-sharing",
  "file-copy-banner", "file-copy-status", "file-copy-write", "file-copy-stop", "file-copy-choice", "Incomplete copy (",
  "shared-here-title", "Visual in use",
  "Link password", "Require a password", "Change password", "Remove password", "Re-enter password",
  "link-password-modal", "collab-access-reenter-password", "/password-exchange", "The link password changed.",
  "data-shared-version", "data-shared-history", "Versions kept by the relay for this shared script.", "Put this beat back",
  "collaboration-announcements", "Joined the shared script.", "Left the shared script.", "Reconnected to the shared script.",
  'id="help-collaboration"'
];

export function leakedCollaboration(text) {
  return COLLABORATION_MARKERS.filter(marker => text.includes(marker));
}

const RELEASE_COLLABORATION = [
  "settings-collaboration", "Set up relay…", "splitpageInvitation", 'url.searchParams.has("join")',
  "share-script-modal", "join-script-modal", "shared-pill", "shared-popover", "file-copy-banner",
  "link-password-modal", "data-shared-history", "collaboration-announcements", 'id="help-collaboration"'
];

export function missingCollaboration(text) {
  return RELEASE_COLLABORATION.filter(marker => !text.includes(marker));
}

const TEST_RELAY_MARKERS = ["ws://127.0.0.1:*", "127\\.0\\.0\\.1:[0-9]+", 'hostname==="127.0.0.1"'];

export function testRelayAllowances(text) {
  return TEST_RELAY_MARKERS.filter(marker => text.includes(marker));
}
