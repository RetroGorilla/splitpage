import { test } from "node:test";
import assert from "node:assert/strict";
import { destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { adapterReplica, registerSplits, sharedHarness } from "../../application/session/shared-session-support.ts";

const RUN = 2000, RUNS = 150;
const mixed = (size: number) => Array.from({ length: RUNS }, (_, index) => index % 2 ? "y".repeat(size) : "<b>" + "z".repeat(size) + "</b>").join("");
const scaled = (html: string) => html.replace(/z+/g, "z".repeat(RUN)).replace(/y+/g, "y".repeat(RUN)).replace(/x+/g, "x".repeat(RUN * RUNS));

function landed(audioText: string, enter: "project" | "session"): string {
  const source = validatedFixture({ title: "Long", rows: [{ id: "R1", audioText }, { id: "R2", audioText: "short" }] });
  const handle = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(handle, source);
    if (enter === "project") return String(projectSharedDocument(handle).rows[0]?.audioText);
    registerSplits(handle);
    const h = sharedHarness(adapterReplica(handle));
    try {
      assert.deepEqual(h.reported, []);
      return String(h.session.read(doc => doc?.rows[0]?.audioText));
    } finally { h.session.dispose(); }
  } finally { destroySharedDocument(handle); }
}

for (const [name, text] of [["plain", (size: number) => "x".repeat(size * RUNS)], ["bold and plain", mixed]] as const) {
  for (const enter of ["project", "session"] as const) {
    test("a row of 300,000 " + name + " characters hydrates and comes back through the " + enter + " path as the same row of 300 does, scaled", () => {
      assert.equal(text(RUN).replace(/<\/?b>/g, "").length, 300000);
      const small = landed(text(2), enter);
      assert.equal(landed(text(RUN), enter), scaled(small));
    });
  }
}
