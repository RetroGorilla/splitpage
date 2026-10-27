import type { DocumentIdentityOwner } from "../../../application/identity/ports.ts";
import { documentIdentityOwner } from "../document-identity.ts";

export const documentIdentity: Pick<DocumentIdentityOwner, "syncDocIdentity" | "copyDocHistorySafe" | "reassignDocId"> = {
  syncDocIdentity: () => documentIdentityOwner().syncDocIdentity(),
  copyDocHistorySafe: (from, to) => documentIdentityOwner().copyDocHistorySafe(from, to),
  reassignDocId: (to, options) => documentIdentityOwner().reassignDocId(to, options)
};
