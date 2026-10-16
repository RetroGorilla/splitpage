import { randomIds } from "../adapters/identity/ids.ts";
import { createRichText } from "../adapters/richtext/richtext.ts";
import type { RichText } from "../adapters/richtext/richtext.ts";
import type { StateField } from "../core/document/fields.ts";
import { createImageIngestion } from "../core/document/media.ts";
import type { ImageIngestion } from "../core/document/media.ts";
import type { MigratePorts } from "../core/migrate.ts";
import { createProductionReaders } from "../core/production/readers.ts";
import type { ProductionReaders } from "../core/production/ports.ts";
import { blobStore } from "../js/02c-blobs.js";
import { cacheSeal } from "./cache-freeze.ts";
import { cellOf } from "./richtext.ts";

export const productionReaders: ProductionReaders = createProductionReaders(cellOf, cacheSeal);

function keepPending(images: ImageIngestion): void {
  const taken = images.take();
  blobStore.adopt(taken);
  blobStore.queuePersist(taken.map(function (p) { return p.ref.sha256; }));
}

export function withDocumentPorts<T>(fields: readonly StateField[], pass: (ports: MigratePorts) => T): T {
  const images = createImageIngestion(blobStore.recordFor);
  let text: RichText | null = null;
  function richText(): RichText {
    if (!text) text = createRichText({ DOMParser: DOMParser, images: images, ids: randomIds });
    return text;
  }
  try {
    return pass({
      images: images,
      sanitize: function (html) { return richText().sanitize(html); },
      decode: function (html, opts) { return richText().decode(html, opts); },
      videoCardHtml: function (href) { return richText().videoCardHtml(href); },
      readers: productionReaders,
      ids: randomIds,
      fields: fields
    });
  } finally {
    keepPending(images);
  }
}
