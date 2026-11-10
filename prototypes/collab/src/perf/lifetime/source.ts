import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { perfSourceDigest } from "../setup.ts";
import { canonicalLifetimeSource } from "./workload.ts";

export function lifetimeSources() {
  const files = Object.fromEntries(readdirSync(new URL("./", import.meta.url)).filter(file => file.endsWith(".ts")).sort()
    .map(file => [file, createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex")]));
  const dependencies = perfSourceDigest(), fixture = createHash("sha256").update(JSON.stringify(canonicalLifetimeSource())).digest("hex");
  return { sha256: createHash("sha256").update(JSON.stringify({ files, dependencies, fixture })).digest("hex"), files, dependencies, fixture };
}
