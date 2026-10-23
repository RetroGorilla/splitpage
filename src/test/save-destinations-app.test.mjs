import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { flushEdits } = await import("../js/12a-undo.js");
const saves = await import("../legacy/save-bridge.ts");
const { currentHome, setHome } = await import("../legacy/location-bridge.ts");
const { heldDocument } = await import("../legacy/session-bridge.ts");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

function throwawayDestination() {
  const handle = { name: "throwaway.md" };
  const written = [];
  let landed = null;
  const ours = (place) => !!place && place.kind === "file" && place.handle === handle;
  return {
    handle,
    written,
    next: () => new Promise((resolve) => { landed = resolve; }),
    destination: {
      id: "throwaway",
      takes: (request, place) => request.kind === "saveAs" || (["save", "auto", "autosave", "force"].includes(request.kind) && ours(place)),
      autoSaveTarget: () => "file",
      write: async (job) => {
        const seq = saves.saveChanges();
        written.push({ kind: job.request.kind, title: heldDocument().title });
        if (job.request.kind === "saveAs") {
          setHome("file", { handle, format: "md", name: handle.name });
          job.moved();
        }
        if (job.owns() && saves.saveChanges() === seq) saves.confirmSavedNow();
        if (landed) landed();
        return { kind: "saved" };
      }
    }
  };
}

test("a destination registered in a test takes Save As, then Save and autosave to the place it chose, with no other change", async () => {
  loadTestDocument(migrateRows({ title: "Throwaway", docId: "d" + "7".repeat(32), rows: [{ id: "r1", visualText: "", audioText: "One.", status: "todo" }] }));
  flushEdits();
  saves.confirmSavedNow();
  const probe = throwawayDestination();
  const drop = saves.saveDestinations().register(probe.destination);
  try {
    saves.setAutoSaveEnabled(false);
    saves.noteSaveChange();
    await saves.saveDoc({ saveAs: true });
    assert.equal(currentHome().handle, probe.handle, "Save As moved the document to the place the destination chose");
    assert.equal(saves.unsavedChanges(), false);

    saves.noteSaveChange();
    await saves.saveDoc();
    assert.equal(saves.unsavedChanges(), false);

    saves.setAutoSaveEnabled(true);
    assert.equal(saves.autoSaveTarget(), "file", "autosave asks the destination that holds the document");
    saves.noteSaveChange();
    const landed = probe.next();
    saves.scheduleAutoSave();
    saves.flushAutoSave();
    await landed;
    assert.deepEqual(probe.written, [
      { kind: "saveAs", title: "Throwaway" },
      { kind: "save", title: "Throwaway" },
      { kind: "autosave", title: "Throwaway" }
    ]);
  } finally {
    drop();
    saves.setAutoSaveEnabled(false);
    setHome("none");
    saves.confirmSavedNow();
  }
});

test("the built-in destinations are the file, the import and the server, and a dropped test destination leaves only them", () => {
  assert.deepEqual(saves.saveDestinations().ids(), ["server", "import", "file"]);
  const drop = saves.saveDestinations().register(throwawayDestination().destination);
  assert.deepEqual(saves.saveDestinations().ids(), ["throwaway", "server", "import", "file"]);
  drop();
  assert.deepEqual(saves.saveDestinations().ids(), ["server", "import", "file"]);
});
