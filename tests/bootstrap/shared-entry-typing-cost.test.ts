import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("C8 standalone typing and comment edits make zero entry hold reads including save and desktop draft effects", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import { pathToFileURL } from "node:url";
    const bridge = await import("./src/bootstrap/wiring/session-owner.ts");
    let reads = 0;
    mock.module(pathToFileURL("src/bootstrap/wiring/session-owner.ts").href, { namedExports: { ...bridge,
      sessionEntryRefusal: () => { reads++; return bridge.sessionEntryRefusal(); } } });
    const { bootApp, closeApp } = await import("./src/test/_app-boot.mjs");
    const { stopApp } = await import("./src/bootstrap/app.ts");
    const { localFilesOwner } = await import("./src/bootstrap/wiring/local-files.ts");
    const { setHome } = await import("./src/bootstrap/wiring/location-owner.ts");
    const { autoSavePolicy } = await import("./src/bootstrap/wiring/save-owners.ts");
    const { useDesktopForTest, restoreDesktop } = await import("./src/adapters/desktop/desktop-port.ts");
    const { cellTextCommand, cellRuns } = await import("./src/application/commands/cell-text.ts");
    const { addCommentCommand } = await import("./src/application/commands/comments.ts");
    await bootApp(JSON.stringify({ title: "Typing", rows: [{ id: "R1", audioText: "a" }] }));
    await localFilesOwner().tryResumeLastProject();
    setHome("file", { name: "Typing.splitpage", format: "splitpage", handle: {} });
    useDesktopForTest({ setDocumentState: () => {}, writeDraft: async () => ({ ok: true, seq: 1, bytes: 1 }) });
    autoSavePolicy().setEnabled(true);
    try {
      const counts = [];
      const typing = cellTextCommand("R1", "audioText", cellRuns([{ text: "ab", marks: {} }]), bridge.sessionTextPorts);
      reads = 0;
      assert.equal(bridge.runCommand(typing).kind, "applied");
      counts.push(reads);
      assert.equal(bridge.currentDocument().rows[0].audioText, "ab");
      const comment = addCommentCommand({ id: "C1", rowId: "R1", author: "Editor", text: "A comment", replies: [] });
      reads = 0;
      assert.equal(bridge.runCommand(comment).kind, "applied");
      counts.push(reads);
      assert.equal(bridge.currentDocument().comments[0].text, "A comment");
      assert.deepEqual(counts, [0, 0]);
    } finally { autoSavePolicy().clear(); restoreDesktop(); stopApp(); closeApp(); }
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
