import { S } from "./_state.js";
import { attachDesktop } from "../adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";
export { SCHEMA_VERSION } from "../core/document/fields.ts";

export var PAGE_SHELL;
export var SpeechRecognitionCtor;

S.state = null;
export var suppressUnloadWarning = false;

var LAST_FILE_DB = "splitpage-files", LAST_FILE_STORE = "handles", LAST_FILE_KEY = "last";

function openHandleDb() {
  return new Promise(function (resolve, reject) {
    if (!("indexedDB" in window)) { reject(new Error("no-indexeddb")); return; }
    var req = indexedDB.open(LAST_FILE_DB, 1);
    req.onupgradeneeded = function () { req.result.createObjectStore(LAST_FILE_STORE); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

export async function rememberLastFileHandle(handle) {
  if (!handle) return;
  if (runningOnDesktop()) return;
  try {
    var db = await openHandleDb();
    await new Promise(function (resolve, reject) {
      var tx = db.transaction(LAST_FILE_STORE, "readwrite");
      tx.objectStore(LAST_FILE_STORE).put(handle, LAST_FILE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  } catch (e) { }
}

export async function loadLastFileHandle() {
  try {
    var db = await openHandleDb();
    return await new Promise(function (resolve, reject) {
      var req = db.transaction(LAST_FILE_STORE, "readonly").objectStore(LAST_FILE_STORE).get(LAST_FILE_KEY);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  } catch (e) { return null; }
}

export function __init() {
  PAGE_SHELL = "<!doctype html>" + document.documentElement.outerHTML;

  (function promoteFontCss() {
    var link = document.getElementById("font-css");
    if (!link) return;
    if (link.sheet) { link.media = "all"; return; }
    link.addEventListener("load", function () { link.media = "all"; });
  })();

  attachDesktop(window.splitpageDesktop);

  SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
