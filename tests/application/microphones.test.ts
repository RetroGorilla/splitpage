import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MISSING_MICROPHONE, SYSTEM_DEFAULT_MICROPHONE, UNNAMED_MICROPHONE,
  microphoneChoices, microphoneList, recognitionTakesTrack
} from "../../src/application/microphones.ts";

test("only a Chromium that takes a track in start() gets a microphone picker", () => {
  assert.equal(recognitionTakesTrack(undefined), false, "no brand list (Safari, Firefox, old Chrome)");
  assert.equal(recognitionTakesTrack([]), false);
  assert.equal(recognitionTakesTrack([{ brand: "Chromium", version: "132" }, { brand: "Google Chrome", version: "132" }]), false);
  assert.equal(recognitionTakesTrack([{ brand: "Chromium", version: "133" }]), true);
  assert.equal(recognitionTakesTrack([{ brand: "Not A;Brand", version: "99" }, { brand: "Chromium", version: "156" }, { brand: "Microsoft Edge", version: "156" }]), true);
  assert.equal(recognitionTakesTrack([{ brand: "Chromium", version: "x" }]), false);
});

test("the device list drops the virtual default entries and entries without an id", () => {
  const list = microphoneList([
    { deviceId: "default", label: "Default - Mic A" },
    { deviceId: "communications", label: "Communications - Mic A" },
    { deviceId: "a1", label: "Mic A" },
    { deviceId: "b2", label: "" }
  ]);
  assert.deepEqual(list.options, [{ id: "a1", label: "Mic A" }, { id: "b2", label: "Microphone 2" }]);
  assert.equal(list.named, true);
});

test("before the microphone is allowed the list has no ids or names, and says so", () => {
  const list = microphoneList([{ deviceId: "", label: "" }]);
  assert.deepEqual(list, { options: [], named: false });
  assert.deepEqual(microphoneChoices("", list), [{ value: "", label: SYSTEM_DEFAULT_MICROPHONE }]);
});

test("the choices are the system default, each microphone, and a saved one that is not there", () => {
  const list = microphoneList([{ deviceId: "a1", label: "Mic A" }, { deviceId: "b2", label: "Mic B" }]);
  assert.deepEqual(microphoneChoices("", list).map((c) => c.value), ["", "a1", "b2"]);
  assert.deepEqual(microphoneChoices("b2", list).map((c) => c.value), ["", "a1", "b2"]);
  assert.deepEqual(microphoneChoices("gone", list), [
    { value: "", label: SYSTEM_DEFAULT_MICROPHONE },
    { value: "a1", label: "Mic A" },
    { value: "b2", label: "Mic B" },
    { value: "gone", label: MISSING_MICROPHONE }
  ]);
  assert.equal(microphoneChoices("gone", microphoneList([])).at(-1)?.label, UNNAMED_MICROPHONE);
});
