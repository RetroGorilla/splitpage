import { idMap } from "../../core/document/id-map.ts";

export function syncAnchorResolvedClasses(doc, root) {
  if (!doc) return;
  var resolvedIds = idMap();
  doc.comments.forEach(function (c) { if (c.resolved) resolvedIds[c.id] = true; });
  root.querySelectorAll("#rows .cmt-anchor").forEach(function (el) {
    var id = el.getAttribute("data-cmt");
    el.classList.toggle("resolved", !!resolvedIds[id]);
  });
}
