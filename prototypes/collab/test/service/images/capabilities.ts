import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import { ConnectionReceipts } from "../../../src/service/receipts.ts";
import { ImagePublication } from "../../../src/service/images/publication.ts";
import type { ImageDocumentPort } from "../../../src/service/images/publication.ts";
import { readFrame, syncFrame } from "../../../src/service/wire.ts";
import { until, workspace } from "../harness.ts";
import { checkText, initial, journalDocument, membership, png, saved, sha, upload, waiting } from "./harness.ts";
import type { ImageProbeTarget } from "./target.ts";
import { imageControl } from "../../../src/service/images/configuration.ts";

function observeTransport(image: ImagePublication, port: number, path: string) {
  const receipts = new ConnectionReceipts(path);
  const frames: { kind: number; bytes: Uint8Array }[] = [];
  const notices: string[] = [];
  class ObservedSocket extends WebSocket {
    readonly lifetime: number;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols); this.lifetime = receipts.open();
      this.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => receipts.received(this.lifetime, new Uint8Array(event.data)));
      this.addEventListener("close", () => receipts.close(this.lifetime));
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      assert.ok(data instanceof Uint8Array);
      frames.push({ kind: readFrame(data).kind, bytes: Uint8Array.from(data) });
      receipts.sent(this.lifetime, data); super.send(Uint8Array.from(data));
    }
  }
  const transport = image.attach(`ws://127.0.0.1:${port}`, ObservedSocket, receipts, (...args: unknown[]) => {
    assert.equal(args.length, 1); noLive(args);
    const payload = args[0]; assert.ok(typeof payload === "string"); notices.push(payload);
  });
  return { transport, receipts, frames, notices };
}

export async function observeNetworkWrites(t: TestContext, target?: ImageProbeTarget): Promise<void> {
  for (const probe of ["text PRIVATE", "held gallery item"] as const) {
    await t.test(`M3 read-only N rejects ${probe} without journal or socket publication${target ? " (configured instance)" : ""}`, async () => {
      const work = await workspace(); let image: ImagePublication | undefined;
      try {
        const server = await work.start({ IMAGE_POLICY: "1", ...target?.environment });
        const configuration = await target?.configure(server);
        image = new ImagePublication(initial(), "upload-before-sync", "two-documents", undefined, configuration);
        const { transport, receipts, frames, notices } = observeTransport(image, server.port, work.path);
        await transport.connect(); await until(() => receipts.status === saved, "initial M3 receipt");
        image.insert(png, sha); image.editing.getText("R1").insert(2, "Z");
        assert.equal(image.status(receipts.status), waiting); assert.deepEqual(membership(work.path, configuration?.instance), []);
        const before = frames.length;
        const network = image.network as ImageDocumentPort;
        if (probe === "text PRIVATE") assert.throws(() => network.getText("R1").insert(2, "PRIVATE"), TypeError);
        else {
          const item = image.items[0]; assert.ok(item);
          assert.throws(() => network.getMap("gallery").set("gP", item), TypeError);
        }
        assert.equal(frames.length, before, "N write probe must emit no frame");
        const fence = transport.fence(); await until(() => notices.includes(fence), "M3 probe ordered fence");
        assert.deepEqual(frames.slice(before).map(frame => frame.kind), [5], "Only the module's content-free fence may leave");
        const recovered = journalDocument(work.path, configuration?.instance);
        try { checkText(recovered, false); assert.deepEqual([...recovered.getMap("gallery").values()], []); }
        finally { recovered.destroy(); }
        checkText(image.editing, true); checkText(image.network, false);
        assert.deepEqual(membership(work.path, configuration?.instance), []);
      } finally { image?.destroy(); await work.clean(); }
    });
  }
}

function members(value: object): string[] {
  return Reflect.ownKeys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key); assert.ok(descriptor);
    return `${String(key)}:${descriptor.get ? descriptor.set ? "get+set" : "get" : typeof descriptor.value}`;
  }).sort();
}

function names(value: object): string[] { return Reflect.ownKeys(value).map(String).sort(); }

const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]()) as object;
const mapIterator = Object.getPrototypeOf(new Map<unknown, unknown>().values()) as object;
const asyncFunction = Object.getPrototypeOf(async () => {}) as object;

function noLive(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" && typeof value !== "function") return;
  assert.equal(value instanceof Y.Doc || value instanceof Y.AbstractType || value instanceof HocuspocusProvider
    || value instanceof HocuspocusProviderWebsocket || value instanceof WebSocket, false, "Caller must not receive a live document, shared type, provider or socket");
  if (seen.has(value)) return;
  seen.add(value);
  if (typeof value === "function") {
    assert.ok(Object.getPrototypeOf(value) === Function.prototype || Object.getPrototypeOf(value) === asyncFunction);
    assert.deepEqual(names(value), value === ImagePublication ? ["length", "name", "prototype"] : ["length", "name"], "Function metadata must expose no extra capability");
    assert.equal(typeof value.name, "string"); assert.equal(typeof value.length, "number");
    if (value === ImagePublication) noLive(value.prototype, seen);
    return;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (value instanceof Map) {
    assert.equal(prototype, Map.prototype); assert.deepEqual(names(value), []);
    for (const [key, item] of value) { noLive(key, seen); noLive(item, seen); }
  } else if (value instanceof Promise) {
    assert.equal(prototype, Promise.prototype);
    assert.deepEqual(members(value), ["Symbol(async_id_symbol):number", "Symbol(trigger_async_id_symbol):number"]);
  } else if (value instanceof Uint8Array) {
    assert.equal(prototype, Uint8Array.prototype);
    assert.ok(names(value).every(key => /^(0|[1-9][0-9]*)$/.test(key)));
    noLive(value.buffer, seen);
  } else if (value instanceof ArrayBuffer) {
    assert.equal(prototype, ArrayBuffer.prototype); assert.deepEqual(names(value), []);
  } else if (Array.isArray(value)) {
    assert.equal(prototype, Array.prototype);
    assert.ok(names(value).every(key => key === "length" || /^(0|[1-9][0-9]*)$/.test(key)));
    for (const item of value as unknown[]) noLive(item, seen);
  } else if (prototype === arrayIterator || prototype === mapIterator) {
    assert.deepEqual(names(value), []);
    for (const item of value as Iterable<unknown>) noLive(item, seen);
  } else {
    assert.ok(prototype === Object.prototype || prototype === ImagePublication.prototype);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key); assert.ok(descriptor);
      const child: unknown = descriptor.value;
      noLive(child, seen); noLive(descriptor.get, seen); noLive(descriptor.set, seen);
      if (descriptor.get && value !== ImagePublication.prototype) {
        const result: unknown = Reflect.get(value, key); noLive(result, seen);
      }
    }
  }
}

export async function observeCapabilityInventory(t: TestContext, target?: ImageProbeTarget): Promise<void> {
  for (const mechanism of ["one-document", "two-documents"] as const) {
    await t.test(`closed caller capability inventory after attach: ${mechanism}${target ? " (configured instance)" : ""}`, async () => {
      const work = await workspace(); let image: ImagePublication | undefined;
      try {
        const server = await work.start({ IMAGE_POLICY: "1", ...target?.environment });
        const configuration = await target?.configure(server);
        image = new ImagePublication(initial(), "upload-before-sync", mechanism, undefined, configuration);
        const { transport, receipts, notices } = observeTransport(image, server.port, work.path);
        const connected = transport.connect();
        assert.equal(Object.getPrototypeOf(connected), Promise.prototype);
        assert.equal(await connected, undefined); await until(() => receipts.status === saved, "inventory initial receipt");
        image.insert(png, sha);
        const editingText = image.editing.getText("R1"); const editingMap = image.editing.getMap("gallery");
        const networkText = image.network.getText("R1"); const networkMap = image.network.getMap("gallery");
        const exported = image.export(); const capture = image.capture(); const view = transport.view(waiting);
        const editingNext = editingMap.values().next(); const networkNext = networkMap.values().next();
        const shape = {
          publication: members(image), publicationPrototype: members(Object.getPrototypeOf(image) as object),
          editing: members(image.editing), editingText: members(editingText), editingMap: members(editingMap),
          network: members(image.network), networkText: members(networkText), networkMap: members(networkMap),
          transport: members(transport), exported: members(exported), capture: members(capture), view: members(view),
          item: members(image.items[0] as object), editingNext: members(editingNext), networkNext: members(networkNext),
          connected: members(connected),
          items: image.items.map(members), editingValues: [...editingMap.values()].map(members), networkValues: [...networkMap.values()].map(members),
          captureBlobs: capture.blobs.map(tuple => tuple.map(value => typeof value)),
          exportImages: exported.images.map(value => typeof value), missingImages: exported.missingImages.map(value => typeof value),
        };
        assert.deepEqual(shape, {
          publication: ["blobs:object", "design:string", "editing:object", "network:object"],
          publicationPrototype: ["allow:function", "attach:function", "capture:function", "constructor:function", "destroy:function", "durable:function", "export:function", "insert:function", "items:get", "picture:function", "status:function", "waiting:get"],
          editing: ["clientID:get+set", "getMap:function", "getText:function", "on:function", "snapshot:function"],
          editingText: ["insert:function", "length:get", "toString:function"], editingMap: ["set:function", "values:function"],
          network: ["clientID:get", "getMap:function", "getText:function", "on:function", "snapshot:function"],
          networkText: ["length:get", "toString:function"], networkMap: ["values:function"],
          transport: ["closed:function", "connect:function", "destroy:function", "drop:function", "fence:function", "forceSync:function", "outgoing:function", "send:function", "sendStateless:function", "shouldConnect:function", "status:function", "view:function"],
          exported: ["images:object", "missingImages:object", "text:string"],
          capture: mechanism === "one-document" ? ["blobs:object", "editing:string", "network:object"] : ["blobs:object", "editing:string", "network:string"],
          view: ["explanation:object", "export:string", "publication:string", "reason:object", "status:string"],
          item: ["beat:string", "id:string", "pending:boolean", "ref:string"],
          editingNext: ["done:boolean", "value:object"],
          networkNext: mechanism === "one-document" ? ["done:boolean", "value:object"] : ["done:boolean", "value:undefined"],
          connected: ["Symbol(async_id_symbol):number", "Symbol(trigger_async_id_symbol):number"],
          items: [["beat:string", "id:string", "pending:boolean", "ref:string"]],
          editingValues: [["beat:string", "id:string", "pending:boolean", "ref:string"]],
          networkValues: mechanism === "one-document" ? [["beat:string", "id:string", "pending:boolean", "ref:string"]] : [],
          captureBlobs: [["string", "string"]], exportImages: ["string"], missingImages: [],
        });
        assert.deepEqual(view, { status: waiting, explanation: null, reason: null, publication: "attached", export: "Standalone copy" });
        if (mechanism === "one-document") assert.equal(capture.network, null);
        assert.deepEqual([...image.blobs.keys()], [sha]);
        for (const bytes of image.blobs.values()) assert.ok(bytes instanceof Uint8Array);
        assert.ok(image.editing.snapshot() instanceof Uint8Array); assert.ok(image.network.snapshot() instanceof Uint8Array);
        assert.equal(Object.getPrototypeOf(ImagePublication.prototype), Object.prototype);
        assert.deepEqual({
          map: names(Map.prototype), array: names(Array.prototype), arrayIterator: names(arrayIterator), mapIterator: names(mapIterator),
          iterator: names(Object.getPrototypeOf(arrayIterator) as object), uint8Array: names(Uint8Array.prototype),
          typedArray: names(Object.getPrototypeOf(Uint8Array.prototype) as object), arrayBuffer: names(ArrayBuffer.prototype),
          object: names(Object.prototype), fn: names(Function.prototype),
          asyncFunction: names(asyncFunction), promise: names(Promise.prototype),
        }, {
          map: "Symbol(Symbol.iterator) Symbol(Symbol.toStringTag) clear constructor delete entries forEach get has keys set size values".split(" "),
          array: "Symbol(Symbol.iterator) Symbol(Symbol.unscopables) at concat constructor copyWithin entries every fill filter find findIndex findLast findLastIndex flat flatMap forEach includes indexOf join keys lastIndexOf length map pop push reduce reduceRight reverse shift slice some sort splice toLocaleString toReversed toSorted toSpliced toString unshift values with".split(" "),
          arrayIterator: ["Symbol(Symbol.toStringTag)", "next"], mapIterator: ["Symbol(Symbol.toStringTag)", "next"],
          iterator: "Symbol(Symbol.dispose) Symbol(Symbol.iterator) Symbol(Symbol.toStringTag) constructor drop every filter find flatMap forEach map reduce some take toArray".split(" "),
          uint8Array: ["BYTES_PER_ELEMENT", "constructor"],
          typedArray: "Symbol(Symbol.iterator) Symbol(Symbol.toStringTag) at buffer byteLength byteOffset constructor copyWithin entries every fill filter find findIndex findLast findLastIndex forEach includes indexOf join keys lastIndexOf length map reduce reduceRight reverse set slice some sort subarray toLocaleString toReversed toSorted toString values with".split(" "),
          arrayBuffer: "Symbol(Symbol.toStringTag) byteLength constructor detached maxByteLength resizable resize slice transfer transferToFixedLength".split(" "),
          object: "__defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__ __proto__ constructor hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf".split(" "),
          fn: "Symbol(Symbol.hasInstance) apply arguments bind call caller constructor length name toString".split(" "),
          asyncFunction: ["Symbol(Symbol.toStringTag)", "constructor"], promise: ["Symbol(Symbol.toStringTag)", "catch", "constructor", "finally", "then"],
        });
        for (const value of [image, ImagePublication.prototype, transport, connected, editingText, editingMap, networkText, networkMap, image.items, exported, capture, view,
          editingNext, networkNext, editingMap.values(), networkMap.values(), image.blobs.entries(), image.blobs.keys(), image.blobs.values(),
          image.editing.snapshot(), image.network.snapshot()]) noLive(value);
        for (const value of [image, transport, image.editing, editingText, editingMap, image.network, networkText, networkMap]) assert.equal(Object.isFrozen(value), true);
        const owner = image;
        assert.throws(() => owner.editing.on(), /exclusively owned/); assert.throws(() => owner.network.on(), /exclusively owned/);
        assert.throws(() => owner.attach("unused", WebSocket, receipts, () => {}), /exclusive transport/);
        assert.throws(() => transport.sendStateless("private"), /refuses outgoing frame kind 5/);
        assert.throws(() => transport.send(syncFrame("fixture", 1, owner.editing.snapshot())), /refuses caller-provided sync frames/);
        assert.equal(Reflect.set(image.network, "clientID", 123), false);
        assert.equal(Reflect.set(image.editing, "clientID", image.editing.clientID), true);
        assert.equal(editingText.insert(editingText.length, ""), undefined);
        const item = image.items[0]; assert.ok(item); assert.equal(editingMap.set("gP", item), undefined);
        assert.equal(image.insert(png, sha), undefined); assert.equal(image.allow(new Uint8Array([9])), true);
        assert.equal(image.status(saved), waiting); assert.equal(image.picture(sha), "placeholder");
        assert.equal(typeof image.waiting, "boolean");
        assert.equal(typeof editingText.toString(), "string"); assert.equal(typeof networkText.toString(), "string");
        assert.equal(typeof editingText.length, "number"); assert.equal(typeof networkText.length, "number");
        assert.equal(typeof image.editing.clientID, "number"); assert.equal(typeof image.network.clientID, "number");
        const copy = image.network.snapshot(); const original = Uint8Array.from(copy); copy.fill(255);
        assert.deepEqual(image.network.snapshot(), original);
        const changed = editingMap.values().next().value; assert.ok(changed); changed.ref = "copy-only";
        assert.equal(image.items[0]?.ref, sha);
        assert.equal(transport.outgoing((...args: unknown[]) => { assert.deepEqual(args, []); return false; }), undefined);
        assert.equal(typeof transport.status(), "string"); assert.equal(typeof transport.shouldConnect(), "boolean"); assert.equal(typeof transport.closed(), "boolean");
        assert.equal(transport.forceSync(), undefined);
        const fence = transport.fence(); assert.equal(typeof fence, "string"); await until(() => notices.includes(fence), "inventory owned fence");
        const response = await upload(server, png, sha, configuration); assert.equal(response.status, 201); await response.arrayBuffer();
        assert.equal(image.durable(sha), undefined); await until(() => receipts.status === saved, "inventory released receipt");
        const networkBefore = image.network.snapshot();
        const networkItem = networkMap.values().next().value; assert.ok(networkItem); networkItem.ref = "copy-only";
        assert.deepEqual(image.network.snapshot(), networkBefore);
        assert.deepEqual(image.items.map(members), [["beat:string", "id:string", "pending:boolean", "ref:string"]]);
        assert.deepEqual([...networkMap.values()].map(members), [["beat:string", "id:string", "pending:boolean", "ref:string"]]);
        assert.deepEqual(members(image.editing.getText("R1")), ["insert:function", "length:get", "toString:function"]);
        assert.deepEqual(members(image.network.getText("R1")), ["length:get", "toString:function"]);
        assert.deepEqual(members(image.editing.getMap("gallery")), ["set:function", "values:function"]);
        assert.deepEqual(members(image.network.getMap("gallery")), ["values:function"]);
        assert.deepEqual(members(image.export()), ["images:object", "missingImages:object", "text:string"]);
        assert.deepEqual(members(image.capture()), mechanism === "one-document"
          ? ["blobs:object", "editing:string", "network:object"] : ["blobs:object", "editing:string", "network:string"]);
        assert.deepEqual(transport.view(saved), { status: saved, explanation: null, reason: null, publication: "attached", export: "Standalone copy" });
        assert.equal(transport.sendStateless("{}"), undefined);
        assert.equal(transport.send(imageControl(configuration?.instance ?? "fixture", 5, ["{}"])), undefined);
        for (const value of [image.items, image.export(), image.capture(), transport.view(saved), image.network.snapshot(), networkMap.values()]) noLive(value);
        assert.equal(transport.drop(), undefined); await until(() => transport.closed(), "inventory transport closed");
        assert.equal(transport.closed(), true); assert.equal(transport.shouldConnect(), false); assert.equal(typeof transport.status(), "string");
        assert.equal(transport.destroy(), undefined); assert.equal(image.destroy(), undefined);
      } finally { image?.destroy(); await work.clean(); }
    });
  }
}
