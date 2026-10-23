import type { Frozen, Seal } from "../../core/document/freeze.ts";
import type { ProductionReaders } from "../../core/production/ports.ts";
import type { DecodeOptions } from "../../core/text/ports.ts";
import type { Run } from "../../core/text/runs.ts";

export interface TextServices<Body = unknown> {
  readonly cellOf: (html: unknown) => Frozen<Run[]>;
  readonly inertBody: (html: unknown) => Body;
  readonly retagBody: (body: Body, cat: string, target: string, toName: string | null) => string;
  readonly fromHtml: (html: unknown, opts?: DecodeOptions | null) => Run[];
  readonly sanitizeHtml: (html: unknown) => string;
  readonly storedHtmlFromDom: <T>(html: T) => T | string;
  readonly htmlToMarkdown: (html: unknown) => string;
  readonly htmlToPlainText: (html: unknown) => string;
  readonly productionReaders: ProductionReaders;
  readonly cacheSeal: Seal;
}
