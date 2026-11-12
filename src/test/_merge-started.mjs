import "./_session-merge-started.mjs";
import { mergeStarted, startMerge } from "../bootstrap/wiring/document-merge.ts";
import { sessionMergePorts } from "../bootstrap/wiring/session-merge.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";

const allowed = () => ({ allowed: true });

if (!mergeStarted()) startMerge({ ...sessionMergePorts(), capability: createSessionCapabilities("standalone", { edit: allowed, comment: allowed }) });
