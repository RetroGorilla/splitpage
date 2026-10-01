import type { NormalizeOptions, Run } from "./runs.ts";

export type DecodedImage = {
  kind: "image";
  ref: { sha256: string | null; width: number | null; height: number | null; mime: string | null };
};

export type DecodedVideo = { kind: "video"; href: string | null };

export type DecodedMedia = DecodedImage | DecodedVideo;

export type DecodeOptions = NormalizeOptions & {
  tagId?: ((cat: string, name: string) => string) | null | undefined;
  onMedia?: ((media: DecodedMedia) => void) | null | undefined;
};

export type CellDecoder = (html: string) => readonly Run[];
