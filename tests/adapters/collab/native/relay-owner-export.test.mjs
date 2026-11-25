import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureExportDocument } from "../../../../src/bootstrap/wiring/export-capture.ts";
import { standaloneHtmlFor } from "../../../../src/adapters/page/standalone-html.ts";
import { buildSplitpageFile, buildSplitpageCopy, buildMarkdownProject } from "../../../../src/adapters/formats/project-file.ts";
import { bootApp, closeApp } from "../../../../src/test/_app-boot.mjs";
import * as passwordPolicy from "../../../../shared/link-password.ts";

const require = createRequire(import.meta.url);
const { createRelayOwner } = require("../../../../desktop/relay-owner.ts");

test("saving a management secret leaves the app-data bundle and script exports unchanged", { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "splitpage-relay-owner-export-"));
  t.after(() => { closeApp(); rmSync(dir, { recursive: true, force: true }); });
  await bootApp();
  const logs = [];
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    t.mock.method(globalThis.console, method, (...args) => { logs.push(args.map(String).join(" ")); });
  }
  async function exportAll() {
    const bundle = await globalThis.window.__appDataTest.build();
    assert.equal(bundle.format, "splitpage-app-data");
    delete bundle.exportedAt;
    const script = captureExportDocument();
    return [JSON.stringify(bundle), standaloneHtmlFor(script), buildSplitpageFile(script), buildSplitpageCopy(script), buildMarkdownProject(script)];
  }
  const before = await exportAll();
  const secret = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(secret).digest();
  const address = "https://relay.example";
  let clearRecord;
  const owner = createRelayOwner(dir, {
    isEncryptionAvailable: () => true,
    encryptString(text) { clearRecord = text; return randomBytes(64); },
    decryptString: () => clearRecord
  }, passwordPolicy, () => { throw new Error(secret); });
  assert.equal(owner.save(address, secret), "saved");
  const status = owner.status();
  const failure = await owner.testConnection();
  assert.deepEqual(status, { address });
  assert.equal(failure, "unreachable");
  const after = await exportAll();
  assert.deepEqual(after, before);
  assert.ok([...after, ...logs, JSON.stringify(status), failure].every(text =>
    [secret, digest.toString("hex"), digest.toString("base64url")].every(value => !text.includes(value))));
});
