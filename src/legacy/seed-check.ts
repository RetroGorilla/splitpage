import { seedCheckMatches } from "../application/preferences/seed-check.ts";

export function seedCheckPasses(): boolean {
  const meta = document.querySelector('meta[name="splitpage-seed-check"]');
  const el = document.getElementById("state-data");
  if (!meta || !el) return false;
  return seedCheckMatches(meta.getAttribute("content"), el.textContent || "");
}
