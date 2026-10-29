import "./_session-merge-started.mjs";
import { mergeStarted, startMerge } from "../bootstrap/wiring/document-merge.ts";
import { sessionMergePorts } from "../bootstrap/wiring/session-merge.ts";

if (!mergeStarted()) startMerge(sessionMergePorts());
