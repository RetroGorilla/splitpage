export function cssDurationMs(window, name, fallback) {
  try {
    const raw = window.getComputedStyle(window.document.documentElement).getPropertyValue(name).trim();
    if (!raw) return fallback;
    const n = parseFloat(raw);
    if (!isFinite(n)) return fallback;
    return /ms$/.test(raw) ? n : n * 1000;
  } catch (e) { return fallback; }
}
