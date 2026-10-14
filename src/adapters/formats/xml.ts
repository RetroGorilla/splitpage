const XML_CONTROL = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) +
  String.fromCharCode(11) + String.fromCharCode(12) +
  String.fromCharCode(14) + "-" + String.fromCharCode(31) + "]",
  "g"
);

export function xmlEscape(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(XML_CONTROL, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
