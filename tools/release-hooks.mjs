const HOOK_NAME = /__(?:[A-Za-z]+Test|splitpageFormats)\b/g;

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

export function leakedHooks(text) {
  return [...hookNames(text).filter((name) => !STILL_IN_RELEASE.includes(name)), ...historyTestNames(text)].sort();
}
