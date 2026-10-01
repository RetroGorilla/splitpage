import { createRichText } from "../../../src/adapters/richtext/richtext.ts";
import type { RichText } from "../../../src/adapters/richtext/richtext.ts";
import { decodeImageDataUrl } from "../../../src/core/document/media.ts";
import type { IdSource, ImageRef, ImageSource } from "../../../src/core/document/ports.ts";
import { jsdomParser } from "./jsdom.mjs";

export type PortCall = readonly ["known" | "fromDataUrl" | "id", string];

export interface Minted {
  readonly prefix: string;
  readonly value: string;
}

export interface FakePorts {
  readonly log: PortCall[];
  readonly minted: Minted[];
  readonly images: ImageSource;
  readonly ids: IdSource;
}

const Parser: new () => DOMParser = jsdomParser();

export function fakePorts(seed: readonly ImageRef[] = []): FakePorts {
  const held = new Map<string, ImageRef>(seed.map((ref) => [ref.sha256, { ...ref }]));
  const log: PortCall[] = [];
  const minted: Minted[] = [];
  const copy = (ref: ImageRef | undefined): ImageRef | null => (ref ? { ...ref } : null);
  return {
    log,
    minted,
    images: {
      known(sha) {
        log.push(["known", sha]);
        return copy(held.get(sha));
      },
      fromDataUrl(url) {
        log.push(["fromDataUrl", url]);
        const decoded = decodeImageDataUrl(url);
        if (!decoded) return null;
        if (!held.has(decoded.ref.sha256)) held.set(decoded.ref.sha256, decoded.ref);
        return copy(held.get(decoded.ref.sha256));
      }
    },
    ids: {
      id(prefix) {
        log.push(["id", prefix]);
        const value = prefix + "Minted" + String(minted.length + 1);
        minted.push({ prefix, value });
        return value;
      },
      docId() {
        throw new Error("the rich-text adapter never mints a document id");
      }
    }
  };
}

export function adapterWith(ports: Pick<FakePorts, "images" | "ids">): RichText {
  return createRichText({ DOMParser: Parser, images: ports.images, ids: ports.ids });
}
