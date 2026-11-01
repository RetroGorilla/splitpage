import { documentIdStamp } from "../commands/save-stamps.ts";
import { sha256Hex } from "../../core/document/ids.ts";
import { cappedLongText, plainText } from "../../core/document/text-policy.ts";
import { decideDuplicateLoser, docIdFromSha256Hex, duplicateReplacementInput, normalizeDocId } from "../../../shared/doc-id-policy.js";
import type { DocumentIdentityPorts, DocumentIdentityOwner, IdentityChannel } from "./ports.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { LocalFileHandle } from "../files/local-file-access.ts";

type IdentityApi = { -readonly [K in keyof Omit<DocumentIdentityOwner, "startIdentity">]: Omit<DocumentIdentityOwner, "startIdentity">[K] } & { dispose: () => void };
type IdentityDocument = Pick<ValidatedDocument, "docId" | "title">;

function startIdentity(ports: DocumentIdentityPorts) {
  const currentDocument = ports.session.currentDocument;
  const stampDocument = ports.session.stampDocument;
  const currentHome = ports.location.home;
  const documentLocation = function () { return ports.location; };
  const showToast = ports.effects.show;
  const copyHistory = ports.history.copyHistory;
  const historyDocumentChanged = ports.history.historyDocumentChanged;
  const runningOnDesktop = ports.desktop.running;
  const mintDocId = ports.ids.docId;
  const randomHexBytes = ports.ids.randomHexBytes;

const PAGE_NONCE = randomHexBytes(16);

function noteMergedDocId(prevId: unknown) {
  prevId = normalizeDocId(prevId);
  if (!currentDocument() || !prevId || prevId === (currentDocument() as IdentityDocument).docId) return;
  copyDocHistorySafe(prevId, (currentDocument() as IdentityDocument).docId);
  syncDocIdentity();
}

const documentIdentityPort = Object.freeze({
  mint: mintDocId,
  writtenOut: function () { return documentLocation().writtenOut(); },
  markWrittenOut: function (writtenOut: boolean) { documentLocation().markWrittenOut(writtenOut); }
});

let identityAdoptedAt = 0;
let lastIdentityKey = "";
const docIdEventLog: ReturnType<DocumentIdentityOwner["docIdEvents"]> = [];
let docIdCopyWarned = false;

function copyDocHistorySafe(from: unknown, to: unknown) {
  from = normalizeDocId(from);
  to = normalizeDocId(to);
  if (!from || !to || from === to) return;
  docIdEventLog.push({ type: "copy", from: from as string, to: to as string });
  if (docIdEventLog.length > 200) docIdEventLog.shift();
  if (typeof copyHistory !== "function") return;
  function warn() {
    if (!active || docIdCopyWarned) return;
    docIdCopyWarned = true;
    try {
      showToast("Could not copy this document's version history to its new identity. " +
        "Earlier versions are still kept under the old one.", "warn");
    } catch (e) { }
  }
  try {
    const p = copyHistory(from as string, to as string);
    if (p && typeof p.then === "function") {
      p.then(function (r) { if (r && r.ok === false) warn(); }, warn);
    }
  } catch (e) { warn(); }
}

function docHomeKey() {
  const home = currentHome();
  if (home.kind === "file") {
    return "file:" + ((home.handle && (home.handle as Pick<LocalFileHandle, "name">).name) || home.name || "");
  }
  return "none:" + PAGE_NONCE;
}

function syncDocIdentity() {
  if (!currentDocument()) return;
  const key = normalizeDocId((currentDocument() as IdentityDocument).docId) + "|" + docHomeKey();
  if (key === lastIdentityKey) return;
  lastIdentityKey = key;
  identityAdoptedAt = ports.now();
  if (typeof historyDocumentChanged === "function") {
    try { historyDocumentChanged(); } catch (e) { ports.logger.error(e); }
  }
  if (!runningOnDesktop()) announceDocIdentity();
}

function reassignDocId(toId: unknown, opts?: { fromId?: unknown; otherTitle?: unknown }) {
  opts = opts || {};
  toId = normalizeDocId(toId);
  const fromId = normalizeDocId(opts.fromId);
  if (!toId || !fromId || toId === fromId || !currentDocument() || (currentDocument() as IdentityDocument).docId !== fromId) return false;
  stampDocument(documentIdStamp(fromId, toId as string));
  documentLocation().markWrittenOut(false);
  copyDocHistorySafe(fromId, toId);
  syncDocIdentity();
  const other = cappedLongText(plainText(opts.otherTitle == null ? "" : opts.otherTitle).trim(), 300) || "Untitled Script";
  showToast('This file is a copy of "' + other + '", which is open in another tab. ' +
    "It now has its own version history. Save it to keep them separate.", "warn", true);
  return true;
}

const DOC_ID_CHANNEL_NAME = "splitpage-doc-ids";
let docIdChannel: IdentityChannel | null = null;

function initDocIdentityChannel(factory?: unknown) {
  if (runningOnDesktop()) return null;
  if (docIdChannel) {
    try { if (typeof docIdChannel.close === "function") docIdChannel.close(); } catch (e) {}
    docIdChannel = null;
  }
  let ch: IdentityChannel | null;
  try {
    if (typeof factory === "function") ch = (factory as DocumentIdentityPorts["channel"])(DOC_ID_CHANNEL_NAME);
    else ch = ports.channel(DOC_ID_CHANNEL_NAME);
  } catch (e) { ch = null; }
  if (!ch) return null;
  ch.onmessage = function (ev: unknown) {
    onDocIdentityMessage((ev && typeof ev === "object" && "data" in ev ? ev.data : ev) as Parameters<typeof onDocIdentityMessage>[0]);
  };
  docIdChannel = ch;
  announceDocIdentity();
  return ch;
}

function currentDocIdClaim(type: string) {
  if (!currentDocument()) return null;
  const docId = normalizeDocId((currentDocument() as IdentityDocument).docId);
  const home = docHomeKey();
  if (!docId || home.indexOf("file:") !== 0) return null;
  return { type: type, docId: docId, home: home, at: identityAdoptedAt, nonce: PAGE_NONCE,
           title: cappedLongText(plainText((currentDocument() as IdentityDocument).title || ""), 300) };
}

function announceDocIdentity() {
  if (runningOnDesktop() || !docIdChannel) return false;
  const claim = currentDocIdClaim("claim");
  if (!claim) return false;
  try { docIdChannel.postMessage(claim); } catch (e) { return false; }
  return true;
}

function onDocIdentityMessage(msg: { type?: unknown; nonce?: unknown; docId?: unknown; home?: unknown; at?: unknown; title?: unknown } | null) {
  if (runningOnDesktop() || !msg || typeof msg !== "object") return;
  if (msg.type !== "claim" && msg.type !== "here") return;
  if (msg.nonce === PAGE_NONCE) return;
  const mine = currentDocIdClaim("here");
  if (!mine) return;
  const theirs = {
    type: msg.type,
    docId: normalizeDocId(msg.docId),
    home: String(msg.home == null ? "" : msg.home),
    at: Number(msg.at) || 0,
    nonce: String(msg.nonce == null ? "" : msg.nonce),
    title: cappedLongText(plainText(msg.title == null ? "" : String(msg.title)), 300)
  };
  const loser = decideDuplicateLoser(mine, theirs);
  if (!loser) return;
  if (loser === mine) {
    reassignDocId(docIdFromSha256Hex(sha256Hex(duplicateReplacementInput(mine.docId, mine.home))),
      { fromId: mine.docId, otherTitle: theirs.title });
    return;
  }
  if (msg.type === "claim") {
    try { (docIdChannel as IdentityChannel).postMessage(mine); } catch (e) {}
  }
}

function docIdEvents() {
  return docIdEventLog.slice();
}

  let active = true;
  function guarded<T extends (...args: never[]) => unknown>(fn: T): T {
    return function (...args: Parameters<T>) {
      if (!active) throw new Error("The document identity is not started yet");
      return fn(...args);
    } as T;
  }
  const api = { noteMergedDocId, copyDocHistorySafe, syncDocIdentity, reassignDocId, initDocIdentityChannel, docIdEvents } as IdentityApi;
  Object.keys(api).forEach(function (key) { (api as unknown as Record<string, (...args: never[]) => unknown>)[key] = guarded((api as unknown as Record<string, (...args: never[]) => unknown>)[key] as (...args: never[]) => unknown); });
  api.documentIdentityPort = Object.freeze(documentIdentityPort);
  api.dispose = function () {
    if (!active) return;
    active = false;
    if (docIdChannel) {
      docIdChannel.onmessage = null;
      try { if (typeof docIdChannel.close === "function") docIdChannel.close(); } catch (e) {}
      docIdChannel = null;
    }
  };
  return api;
}

export function createDocumentIdentityOwner(): DocumentIdentityOwner {
  let started: IdentityApi | null = null;
  function running() {
    if (!started) throw new Error("The document identity is not started yet");
    return started;
  }
  return {
    startIdentity: function (ports) {
      if (started) throw new Error("The document identity is already started; stop it first");
      const mine = startIdentity(ports);
      started = mine;
      return function () {
        if (started !== mine) return;
        started = null;
        mine.dispose();
      };
    },
    documentIdentityPort: Object.freeze({
      mint: function () { return running().documentIdentityPort.mint(); },
      writtenOut: function () { return running().documentIdentityPort.writtenOut(); },
      markWrittenOut: function (value: boolean) { return running().documentIdentityPort.markWrittenOut(value); }
    }),
    noteMergedDocId: function (...args) { return running().noteMergedDocId(...args); },
    copyDocHistorySafe: function (...args) { return running().copyDocHistorySafe(...args); },
    syncDocIdentity: function (...args) { return running().syncDocIdentity(...args); },
    reassignDocId: function (...args) { return running().reassignDocId(...args); },
    initDocIdentityChannel: function (...args) { return running().initDocIdentityChannel(...args); },
    docIdEvents: function (...args) { return running().docIdEvents(...args); }
  };
}
