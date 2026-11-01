import type { DocumentView } from "../../application/session/document-session.ts";

import { idMap } from "../../core/document/id-map.ts";

export function syncAnchorResolvedClasses(doc: { readonly comments: DocumentView["comments"] } | null, root: ParentNode) {
  if (!doc) return;
  const resolvedIds = idMap<boolean>();
  doc.comments.forEach(function (c) { if (c.resolved) resolvedIds[c.id] = true; });
  root.querySelectorAll("#rows .cmt-anchor").forEach(function (el) {
    const id = el.getAttribute("data-cmt");
    el.classList.toggle("resolved", !!resolvedIds[id as string]);
  });
}
