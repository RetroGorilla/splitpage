let active = false;

export function appBindingAsked(): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).get("app-binding") === "1";
}

export function appBindingActive(): boolean { return appBindingAsked() && active; }
export function setAppBindingActive(value: boolean): void { active = value; }
export function refuseAppBindingReplacement(): void {
  if (appBindingActive()) throw new Error("Whole-document replacement is isolated in the binding experiment");
}
