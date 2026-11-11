function bag(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? Array.from(value, bag) : []; }
export function sharedProjectionExtra(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  try { return typeof fields.extra === "string" ? bag(JSON.parse(fields.extra) as unknown) : {}; } catch { return {}; }
}
function plain(fields: Readonly<Record<string, unknown>>, excluded: readonly string[] = []): Record<string, unknown> {
  const out = sharedProjectionExtra(fields);
  for (const key of Object.keys(fields).filter(key => !["rank", "extra", ...excluded].includes(key)).sort()) Object.defineProperty(out, key, { value: fields[key], enumerable: true, configurable: true, writable: true });
  return out;
}
export function projectSharedRegistryFields(kind: "people" | "tags" | "shots", fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (kind !== "shots") return plain(fields);
  const out = plain(fields, ["props"]);
  if (Object.hasOwn(fields, "props")) out.props = list(fields.props).map(prop => plain(bag(prop.fields)));
  return out;
}
export function projectSharedCommentFields(fields: Readonly<Record<string, unknown>>, replies: readonly { readonly fields: Readonly<Record<string, unknown>> }[]): Record<string, unknown> {
  const out = plain(fields, ["text", "quote", "resolution"]);
  if (Object.hasOwn(fields, "text")) out.body = fields.text;
  if (Object.hasOwn(fields, "quote")) out.quotedText = fields.quote;
  Object.assign(out, bag(fields.resolution));
  out.replies = replies.filter(reply => reply.fields.commentId === fields.id).map(reply => {
    const result = plain(reply.fields, ["commentId", "text"]);
    if (Object.hasOwn(reply.fields, "text")) result.body = reply.fields.text;
    return result;
  });
  return out;
}
export function projectSharedBeatFields(id: string, fields: Readonly<Record<string, unknown>>, status: string, gallery: readonly { readonly fields: Readonly<Record<string, unknown>> }[]): Record<string, unknown> {
  const out = sharedProjectionExtra(fields), stamp = bag(fields.stamp);
  out.id = id; out.status = status;
  if (typeof fields.segment === "string" && !Object.hasOwn(out, "imageRef")) out.imageRef = null;
  for (const key of ["lengthSeconds", "paragraphStart"]) if (Object.hasOwn(fields, key)) out[key] = fields[key];
  if (Object.hasOwn(stamp, "at")) out.updatedAt = stamp.at;
  if (Object.hasOwn(stamp, "by")) out.updatedBy = stamp.by;
  return projectSharedGalleryFields(out, projectSharedGallerySlots(gallery.filter(slot => slot.fields.beat === id)));
}
export function projectSharedGallerySlots(gallery: readonly { readonly fields: Readonly<Record<string, unknown>> }[]): Record<string, unknown>[] {
  return gallery.map(slot => {
    const value = { ...sharedProjectionExtra(slot.fields), ...bag(slot.fields.picture) };
    const links = list(slot.fields.links).map(link => plain(bag(link.fields)));
    if (links.length) value.links = links;
    return value;
  });
}
export function projectSharedGalleryFields(fields: Readonly<Record<string, unknown>>, slots: readonly Readonly<Record<string, unknown>>[]): Record<string, unknown> {
  const out = { ...fields };
  const first = slots[0];
  if (first) for (const [source, target] of [["imageRef", "imageRef"], ["name", "imageName"], ["annotation", "imageAnnotation"], ["links", "imageLinks"]]) {
    if (source && target && Object.hasOwn(first, source)) out[target] = first[source];
  }
  if (slots.length > 1) out.moreImages = slots.slice(1);
  return out;
}
