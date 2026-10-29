export function dialogShown(): boolean {
  return document.querySelector(".modal-backdrop:not([hidden])") !== null;
}

export function launcherShown(): boolean {
  return document.querySelector(".cmdk-backdrop:not([hidden])") !== null;
}
