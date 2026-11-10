import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { isProjectionEntry } from "../proj/entry.ts";

const privateTokenDigests = [
  [15, "921b3fc21692fea52b7a77971443ea0bcbcb528779e492427b9ec233d7c1bcea"],
  [6, "6d0420054de0cab40e81a2a32cd1352e221995858b7999f8950db5d44327a0b5"]
] as const;

export function hasPrivatePerfMetadata(value: string): boolean {
  if (/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/.test(value)) return true;
  for (const token of value.toLowerCase().match(/[a-z0-9_-]+/g) ?? []) {
    if (!/[a-z]/.test(token)) continue;
    for (const [length, expected] of privateTokenDigests) for (let offset = 0; offset + length <= token.length; offset++) {
      if (createHash("sha256").update(token.slice(offset, offset + length)).digest("hex") === expected) return true;
    }
  }
  return false;
}

export function redactPerfText(value: string): string {
  let result = value.replace(/(?:file:\/\/\/)?(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\r\n\t "'<>)]*/g, path => {
    const normalized = path.replaceAll("\\", "/");
    const marker = normalized.indexOf("/prototypes/collab/");
    return marker >= 0 ? normalized.slice(marker + 1) : `<local>${normalized.match(/(?::[0-9]+){1,2}$/)?.[0] ?? ""}`;
  });
  for (const [identity, replacement] of [[hostname(), "<machine>"], [userInfo().username, "<user>"]]) {
    if (!identity || !replacement) continue;
    const pattern = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(pattern, "gi"), replacement);
  }
  assert.equal(hasPrivatePerfMetadata(result), false, "Identifying metadata remains in redacted text");
  return result;
}

if (isProjectionEntry(import.meta.url) && process.argv.includes("--transcript")) {
  const input = process.argv[3], output = process.argv[4];
  if (!input || !output) throw new Error("Expected input and output transcript paths");
  const bytes = readFileSync(input);
  const text = bytes[0] === 255 && bytes[1] === 254 ? bytes.toString("utf16le") : bytes.toString("utf8");
  writeFileSync(output, redactPerfText(text));
}
