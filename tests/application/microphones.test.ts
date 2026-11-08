import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MISSING_MICROPHONE, SYSTEM_DEFAULT_MICROPHONE, UNNAMED_MICROPHONE,
  isDesktopMicrophoneId, microphoneChoices, microphoneList, recognitionTakesTrack
} from "../../src/application/microphones.ts";

test("only a desktop Chromium that takes a track in start() (135 or later) gets a microphone picker", () => {
  const chromium = (version: string) => [{ brand: "Not A;Brand", version: "99" }, { brand: "Chromium", version }, { brand: "Microsoft Edge", version }];
  assert.equal(recognitionTakesTrack(undefined, "Windows"), false, "no brand list (Safari, Firefox, old Chrome)");
  assert.equal(recognitionTakesTrack([], "Windows"), false);
  assert.equal(recognitionTakesTrack(chromium("133"), "Windows"), false, "133 ships start(track) switched off");
  assert.equal(recognitionTakesTrack(chromium("134"), "Linux"), false);
  assert.equal(recognitionTakesTrack(chromium("135"), "Windows"), true);
  assert.equal(recognitionTakesTrack(chromium("156"), "macOS"), true);
  assert.equal(recognitionTakesTrack(chromium("156"), "Linux"), true);
  assert.equal(recognitionTakesTrack(chromium("156"), "Android"), false, "enabled only on desktop operating systems");
  assert.equal(recognitionTakesTrack(chromium("156"), "Chrome OS"), false);
  assert.equal(recognitionTakesTrack(chromium("156"), ""), false);
  assert.equal(recognitionTakesTrack(chromium("156"), undefined), false);
  assert.equal(recognitionTakesTrack([{ brand: "Chromium", version: "x" }], "Windows"), false);
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

test("a desktop microphone id is a Windows capture endpoint id and nothing else", () => {
  assert.equal(isDesktopMicrophoneId("{0.0.1.00000000}.{411c2754-d926-4a65-a6a6-702e8deb86e0}"), true);
  assert.equal(isDesktopMicrophoneId("{0.0.1.00000000}.{411C2754-D926-4A65-A6A6-702E8DEB86E0}"), true);
  for (const id of ["", "default", "dev-1", "a".repeat(64), "{0.0.0.00000000}.{411c2754-d926-4a65-a6a6-702e8deb86e0}",
    "{0.0.1.00000000}.{411c2754-d926-4a65-a6a6-702e8deb86e0} -List", "-Device {0.0.1.00000000}.{411c2754-d926-4a65-a6a6-702e8deb86e0}"]) {
    assert.equal(isDesktopMicrophoneId(id), false, id);
  }
});