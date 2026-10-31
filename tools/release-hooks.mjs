const HOOK_NAME = /__(?:[A-Za-z]+Test|splitpageFormats)\b/g;

export const STILL_IN_RELEASE = Object.freeze([
  "__annotateTest",
  "__blobsTest",
  "__brollTest",
  "__renderTest",
  "__rundownTest",
  "__sceneSelectTest",
  "__targetTest",
  "__videoTest"
]);

export function hookNames(text) {
  return [...new Set(text.match(HOOK_NAME) ?? [])].sort();
}

export function leakedHooks(text) {
  return hookNames(text).filter((name) => !STILL_IN_RELEASE.includes(name));
}
