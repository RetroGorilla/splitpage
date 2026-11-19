import assert from "node:assert/strict";
import test from "node:test";
import { tagLife, tagStress } from "../../src/format-keys/tag-life.ts";

test("250 days of tag applications and removals preserve the recorded marks", { timeout: 120_000 }, t => {
  for (const writers of [1, 2, 6]) {
    for (const scheme of ["name", "act"] as const) {
      const result = tagLife(scheme, writers);
      assert.equal(result.applications, 2_000);
      assert.equal(result.removals, 500);
      assert.ok(result.characters > 0 && result.bytes > 0);
      if (scheme === "name") assert.equal(result.max, 1);
      if (process.env.E6_TABLE === "1") t.diagnostic(JSON.stringify({ writers, scheme, ...result }));
    }
  }
});

test("full and partial untagging leave different live key counts after repeated applications", { timeout: 120_000 }, t => {
  for (const punch of [false, true]) {
    for (const scheme of ["name", "act"] as const) {
      const rows = tagStress(scheme, punch);
      for (const result of rows) {
        assert.equal(result.max, scheme === "act" && punch ? result.round + 1 : 1);
        assert.equal(result.clearedMax, punch ? result.max - Number(scheme === "act") : 0);
        if (process.env.E6_TABLE === "1") t.diagnostic(JSON.stringify({ punch, scheme, ...result }));
      }
    }
  }
});
