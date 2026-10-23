import { mergeStarted, startMerge } from "../legacy/merge-bridge.ts";
import { legacyMergePorts } from "../js/03-sync.js";

if (!mergeStarted()) startMerge(legacyMergePorts());
