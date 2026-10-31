const HOOK_NAME = /__(?:[A-Za-z]+Test|splitpageFormats)\b/g;

export const STILL_IN_RELEASE = Object.freeze([
  "__blobsTest",
  "__renderTest"
]);

export function hookNames(text) {
  return [...new Set(text.match(HOOK_NAME) ?? [])].sort();
}

export function leakedHooks(text) {
  return hookNames(text).filter((name) => !STILL_IN_RELEASE.includes(name));
}
