import "./_dom.mjs";
import { documentIdentityOwner, mountDocumentIdentityOwner } from "../bootstrap/wiring/document-identity.ts";

try { documentIdentityOwner(); } catch { mountDocumentIdentityOwner(); }
