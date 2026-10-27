import "./_dom.mjs";
import { sessionMergeOwner, mountSessionMergeOwner } from "../bootstrap/wiring/session-merge.ts";

try { sessionMergeOwner(); } catch { mountSessionMergeOwner(); }
