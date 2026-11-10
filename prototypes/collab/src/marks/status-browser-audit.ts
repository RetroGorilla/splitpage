import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { statusTimingChanges, validateStatusTimingChanges } from "./status-source-audit.ts";
import { readerOrderChanges } from "../readers/source-audit.ts";

interface StatusBrowserArchive {
  sourceHead: string;
  files: Record<string, string>;
  bundles: Record<string, { before: string; after: string }>;
  postReviewBundles?: Record<string, { before: string; after: string }>;
  postValidationBundles?: Record<string, { before: string; after: string }>;
}

export async function validateReaderBrowserBundle(entry: string, recorded: string, current: string): Promise<void> {
  const archive = JSON.parse(readFileSync(new URL("status-browser-source.json", import.meta.url), "utf8")) as StatusBrowserArchive;
  assert.equal(archive.sourceHead, "658a5f654a4ecdbd29eb3f28ffd32e911925dab8");
  const declaration = archive.bundles[entry];
  const reviewed = archive.postReviewBundles?.[entry];
  const validated = archive.postValidationBundles?.[entry];
  if (declaration) {
    assert.equal(recorded, declaration.before);
    if (reviewed) assert.equal(reviewed.before, declaration.after);
    if (validated) assert.equal(validated.before, reviewed?.after ?? declaration.after);
  }
  const readerChanges = readerOrderChanges(), readerDeclaration = readerChanges.bundles[entry]; assert.ok(readerDeclaration);
  assert.equal(readerDeclaration.before, validated?.after ?? reviewed?.after ?? declaration?.after ?? recorded);
  assert.equal(current, readerDeclaration.after, "Current reader bundle differs from its declared post-browser change");
  validateStatusTimingChanges();
  assert.deepEqual(Object.keys(archive.files).sort(), ["src/marks/commands.ts", "src/marks/projection.ts", "src/structure-reader.ts"]);
  const original = new Map<string, string>();
  for (const [path, source] of declaration ? Object.entries(archive.files) : []) {
    const change = statusTimingChanges().files.find(file => file.path === path); assert.ok(change);
    assert.equal(createHash("sha256").update(source).digest("hex"), change.before);
    original.set(fileURLToPath(new URL(`../../${path}`, import.meta.url)).replaceAll("\\", "/"), source);
  }
  for (const file of readerChanges.files) if (file.original !== null) {
    const path = fileURLToPath(new URL(`../../${file.path}`, import.meta.url)).replaceAll("\\", "/");
    if (!original.has(path)) original.set(path, file.original);
  }
  const rebuilt = await build({ absWorkingDir: fileURLToPath(new URL("../../../../", import.meta.url)),
    entryPoints: [fileURLToPath(new URL(`../../${entry}`, import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023",
    plugins: [{ name: "archived-status-reader", setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, args => {
        const contents = original.get(args.path.replaceAll("\\", "/"));
        return contents === undefined ? undefined : { contents, loader: "ts" };
      });
    } }] });
  const text = rebuilt.outputFiles?.[0]?.text; assert.ok(text);
  assert.equal(createHash("sha256").update(text).digest("hex"), recorded, "Historical browser bundle no longer reproduces exactly");
}
