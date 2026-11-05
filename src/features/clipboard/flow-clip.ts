import { copyFlowRange, pasteFlowRange } from "../../core/flow/flow.ts";
import type { FlowClipboardSlice } from "../../core/flow/flow.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowRange } from "../../core/flow/flow.ts";
import type { DocumentScene } from "../../core/document/scenes.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { beatsOnClipboard, buildBeatPayload, insertBeats, isMove, parseBeatPayload, setLiveCut } from "./beat-clip.ts";

const MIME = "application/x-splitpage-flow";
const ATTR = "data-splitpage-flow";

interface FlowWirePayload {
  readonly format: "splitpage-flow";
  readonly version: 1;
  readonly text: string;
  readonly beats: unknown;
  readonly wholeIds: readonly string[];
  readonly headers: FlowClipboardSlice["headers"];
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function copyFlowClipboard(doc: DocumentView, range: FlowRange, data: Pick<DataTransfer, "setData">, ports: FlowPorts, nonce: string | null,
  migrate: (input: unknown) => ValidatedDocument): boolean {
  const clip = copyFlowRange(doc, range, ports);
  const whole = new Set(clip.wholeIds);
  const rows = clip.rows.map(row => whole.has(row.id) ? row : { ...row, id: ports.newId() });
  const beats = rows.length ? buildBeatPayload(migrate({ ...doc, rows }), rows.map(row => row.id), nonce ? { cut: nonce } : undefined) : null;
  const wire: FlowWirePayload = { format: "splitpage-flow", version: 1, text: clip.text, beats: beats?.payload ?? null,
    wholeIds: clip.wholeIds, headers: clip.headers };
  data.setData("text/plain", clip.text);
  data.setData(MIME, JSON.stringify(wire));
  const lean = beats ? { ...wire, beats: { ...beats.payload, blobs: {}, blobsLeftOut: Object.keys(beats.payload.blobs).concat(beats.leftOut) } } : wire;
  data.setData("text/html", '<span ' + ATTR + '="' + escape(JSON.stringify(lean)) + '">' + escape(clip.text).replace(/\n/g, "<br>") + "</span>");
  if (nonce) setLiveCut(nonce, doc.docId ?? null);
  return !!beats?.leftOut.length;
}

export function pasteFlowClipboard(doc: DocumentView, range: FlowRange, data: Pick<DataTransfer, "getData">, ports: FlowPorts,
  inertBody: (html: string) => ParentNode, migrate: (input: unknown) => ValidatedDocument): FlowOutcome | undefined {
  let wire: unknown;
  const json = data.getData(MIME) || inertBody(data.getData("text/html")).querySelector("[" + ATTR + "]")?.getAttribute(ATTR);
  try { wire = json ? JSON.parse(json) as unknown : null; } catch { return undefined; }
  const legacy = !json ? beatsOnClipboard(type => data.getData(type)) : null;
  if (legacy) wire = { format: "splitpage-flow", version: 1, text: data.getData("text/plain"), wholeIds: legacy.rows.map(row => row.id), headers: [] };
  if (!wire || typeof wire !== "object") return undefined;
  const input = wire as Partial<FlowWirePayload>;
  if (input.format !== "splitpage-flow" || input.version !== 1 || typeof input.text !== "string") return undefined;
  const clip = legacy ?? (input.beats ? parseBeatPayload(input.beats) : null);
  if (!legacy && input.beats !== null && !clip) return undefined;
  if (!Array.isArray(input.wholeIds) || !Array.isArray(input.headers)) return undefined;
  const wholeIds: readonly unknown[] = input.wholeIds;
  if (wholeIds.some(id => typeof id !== "string" || !clip?.rows.some(row => row.id === id))) return undefined;
  const headers: { index: number; scene: DocumentScene }[] = [];
  if (Array.isArray(input.headers)) {
    for (const header of input.headers as FlowClipboardSlice["headers"]) {
      if (!header || !Number.isInteger(header.index) || header.index < 0 || header.index > (clip?.rows.length ?? 0)
        || !header.scene || typeof header.scene.name !== "string" || !header.scene.name.trim()
        || Array.from(header.scene.name).length > 200 || headers.some(previous => previous.index >= header.index)) return undefined;
      headers.push({ index: header.index, scene: { id: ports.newId(), name: header.scene.name, firstSceneId: "" } });
    }
  }
  if (!input.text && !wholeIds.length && !headers.length) return undefined;
  const state = migrate(JSON.parse(JSON.stringify(doc)) as unknown);
  const count = state.rows.length;
  const result = clip ? insertBeats(clip, { state, move: isMove(clip, doc), preserveBrollDetails: true }) : null;
  const rows = state.rows.slice(count);
  const slice: FlowClipboardSlice = { text: input.text, rows, headers, wholeIds: Array.isArray(input.wholeIds) && input.wholeIds.length ? result?.rowIds ?? [] : [] };
  const pasted = pasteFlowRange(doc as FlowDoc, range, slice, ports);
  if (!pasted || !("rows" in pasted) || !slice.wholeIds.length && !headers.length) return pasted;
  return { ...pasted, clipboard: { comments: state.comments, people: state.people, productionTags: state.productionTags, brollShots: state.brollShots } };
}
