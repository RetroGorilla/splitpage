const HOOK_NAME = /__[A-Za-z]+Test\b/g;

export const STILL_IN_RELEASE = Object.freeze([
  "__annotateTest",
  "__appDataTest",
  "__blobsTest",
  "__brollTest",
  "__cacheTest",
  "__commandTest",
  "__desktopTest",
  "__documentGuardTest",
  "__exportTest",
  "__fileMenuTest",
  "__prompterTest",
  "__renderTest",
  "__rundownTest",
  "__saveStatusTest",
  "__sceneSelectTest",
  "__settingsTest",
  "__targetTest",
  "__undoTest",
  "__updateTest",
  "__videoTest"
]);

export function hookNames(text) {
  return [...new Set(text.match(HOOK_NAME) ?? [])].sort();
}

export function leakedHooks(text) {
  return hookNames(text).filter((name) => !STILL_IN_RELEASE.includes(name));
}
