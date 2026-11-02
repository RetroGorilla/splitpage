import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
window.localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
const { currentDocument, liveSession } = await import("../bootstrap/wiring/session-owner.ts");
const { documentTransitions } = await import("../bootstrap/wiring/transition-owners.ts");
const { tagPanelState } = await import("../bootstrap/wiring/ports/production.ts");
const { applyMerge } = await import("../bootstrap/wiring/document-merge.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { openGearPanel, renderProduction } = await import("../features/tags/panels.ts");
const { tagKey } = await import("../core/document/tags.ts");
after(closeApp);

for (const scenario of ["different registry ID", "same registry ID", "new document lifetime"]) {
  test("gear rename after real merge and Save: " + scenario, async () => {
    documentTransitions().open({
      from: { raw: {
        schema: 2, docId: "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Gear rename",
        rows: [{ id: "r1", status: "todo", visualText: "", audioText: "One" }],
        productionTags: [{ id: "t_hat", cat: "gear", name: "Hat", owner: "", notes: "", status: "needed" }]
      } },
      reason: "gear-rename"
    });
    openGearPanel();
    tagPanelState.setGearGroupBy("flat");
    tagPanelState.setTagRenaming(tagKey("gear", "Hat"));
    renderProduction();
    const input = document.querySelector("#gear-list .tag-rename-input");
    assert.ok(input);
    input.value = "Camera draft";
    const epoch = liveSession().epoch();
    const theirs = JSON.parse(JSON.stringify(currentDocument()));
    const id = scenario === "different registry ID" ? "t_replacement" : "t_hat";
    theirs.productionTags[0].id = id;
    theirs.productionTags[0].notes = "Incoming notes";
    await applyMerge({
      theirs: migrateRows(theirs), source: "disk", unchanged: true, report: false,
      recovery: scenario === "new document lifetime"
    });
    assert.equal(currentDocument().productionTags[0].id, id);
    assert.equal(liveSession().epoch(), epoch + (scenario === "new document lifetime" ? 1 : 0));
    document.querySelector('#gear-list [data-action="tag-rename-save"]').click();
    const saved = currentDocument().productionTags.find((tag) => tag.id === id);
    assert.ok(saved);
    assert.equal(saved.name, scenario === "same registry ID" ? "Camera draft" : "Hat");
    assert.equal(saved.notes, "Incoming notes");
    assert.equal(document.querySelector("#gear-list .tag-rename-input"), null);
  });
}
