import { escapeHtml } from "../../core/document/text-policy.ts";

export var IS_MAC = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

var KEY_WORDS = {
  mod: IS_MAC ? "⌘" : "Ctrl",
  shift: IS_MAC ? "⇧" : "Shift",
  alt: IS_MAC ? "⌥" : "Alt"
};

export function keyChipWords(spec) {
  return String(spec || "").split("+").filter(Boolean).map(function (part) {
    var low = part.toLowerCase();
    return KEY_WORDS[low] || (part.length === 1 ? part.toUpperCase() : part);
  });
}

export function keyChipsHtml(spec) {
  return keyChipWords(spec).map(function (w) { return "<kbd>" + escapeHtml(w) + "</kbd>"; }).join("");
}
