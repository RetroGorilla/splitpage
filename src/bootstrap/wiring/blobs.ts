import { blobsTestControls, startBlobs } from "../../adapters/storage/02c-blobs.ts";
import { exposeTestHook } from "../../features/common/test-hooks.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

// why: exposeTestHook drops only the call, after tree shaking has kept what it names; folding this to null first
// lets a release build leave out the controls factory.
const testControls = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS ? blobsTestControls : null;

export function mountBlobStore(): void {
  startBlobs();
  exposeTestHook("__blobsTest", () => testControls?.(), () => undefined);
}
