export function writerFlowEnabled(window: Window): boolean {
  try { return window.localStorage.getItem("splitpage-writer-flow") === "1"; } catch { return false; }
}
