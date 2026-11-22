import { before, after, test } from "node:test";
import { bootNativeEntrySwitchFixture, stopNativeEntrySwitchFixture } from "./native-entry-switch-support.ts";
import { ENTRY_CASES, exerciseHeldEntry } from "./shared-entry-inventory.ts";

before(bootNativeEntrySwitchFixture);
after(stopNativeEntrySwitchFixture);
for (const entry of ENTRY_CASES) test("C8 enter inventory refuses " + entry.name + " before access", () => exerciseHeldEntry(entry, "enter"));
