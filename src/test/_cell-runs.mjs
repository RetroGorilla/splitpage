import { fromHtml } from "../legacy/richtext.ts";

const WITH_MEDIA = Object.freeze({ media: true });

export function cellRuns(html) {
  return fromHtml(html == null ? "" : html, WITH_MEDIA);
}
