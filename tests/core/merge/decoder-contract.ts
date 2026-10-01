import { storedImageMarkup } from "../../../src/core/document/text-policy.ts";
import { mergeTextField, textMergeContext } from "../../../src/core/merge/text-field.ts";
import type { MergeDecoder } from "../../../src/core/merge/text-field.ts";
import type { DecodedMedia } from "../../../src/core/text/ports.ts";

export const CONTRACT_PICTURE = { sha256: "c0".repeat(32), width: 4, height: 3, mime: "image/png" };

export const CONTRACT_HTML = {
  base: "one two",
  minePicture: "one two" + storedImageMarkup(CONTRACT_PICTURE),
  theirsWord: "one TWO",
  tag: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">mug</span> out'
};

export function mergeDecoderBreaks(decode: MergeDecoder): string[] {
  const broken: string[] = [];

  const media: DecodedMedia[] = [];
  decode(CONTRACT_HTML.minePicture, { onMedia: function (m) { media.push(m); } });
  const first = media[0];
  if (media.length !== 1 || !first || first.kind !== "image" || first.ref.sha256 !== CONTRACT_PICTURE.sha256) broken.push("onMedia");

  const asked: string[] = [];
  const cell = decode(CONTRACT_HTML.tag, { tagId: function (cat, name) { asked.push(cat + "/" + name); return "t_contract"; } });
  if (asked.join(",") !== "prop/Mug" || !cell.some(function (r) { return !r.atom && r.marks.tag === "t_contract"; })) broken.push("tagId");

  const side = { productionTags: [] };
  const r = mergeTextField(CONTRACT_HTML.base, CONTRACT_HTML.minePicture, CONTRACT_HTML.theirsWord, textMergeContext(decode, side, side, side));
  if (r.outcome !== "conflict" || r.html !== CONTRACT_HTML.theirsWord) broken.push("a picture mine added beside a word theirs changed is a conflict");

  return broken;
}
