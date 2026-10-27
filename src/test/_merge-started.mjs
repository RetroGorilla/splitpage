import "./_session-merge-started.mjs";
import { mergeStarted, startMerge } from "../legacy/merge-bridge.ts";
import { sessionMergePorts } from "../bootstrap/wiring/session-merge.ts";

if (!mergeStarted()) startMerge(sessionMergePorts());
