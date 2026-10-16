import { bootApp, closeApp } from "./_app-boot.mjs";

const arrival = process.argv[2];
const DESKTOP_ARRIVALS = { "desktop pristine": false, restore: true };

function fakeDesktop(hasDraftToRestore) {
  const known = {
    isDesktop: true,
    platform: "test",
    appVersion: "0.0.0-test",
    tabId: "f".repeat(32),
    windowId: "w".repeat(32),
    launchIntent: { type: "blank" },
    hadPriorSession: false,
    firstTabOfLaunch: true,
    hasDraftToRestore: hasDraftToRestore
  };
  return new Proxy(known, {
    get(target, key) {
      if (key in target || typeof key !== "string" || key === "then") return target[key];
      return () => Promise.resolve(null);
    }
  });
}

async function rememberFile() {
  await new Promise((resolve, reject) => {
    const open = indexedDB.open("splitpage-files", 1);
    open.onupgradeneeded = () => { open.result.createObjectStore("handles"); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", "readwrite");
      tx.objectStore("handles").put({ kind: "file", name: "script.splitpage" }, "last");
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });

globalThis.fetch = () => Promise.reject(new TypeError("no network in the onboarding probe"));
window.fetch = globalThis.fetch;
if (arrival in DESKTOP_ARRIVALS) window.splitpageDesktop = fakeDesktop(DESKTOP_ARRIVALS[arrival]);
if (arrival === "file") await rememberFile();
if (arrival === "link") window.history.replaceState(null, "", "/?doc=" + "d" + "5".repeat(32));
let error = null;
try {
  await bootApp();
} catch (failure) {
  error = String((failure && failure.stack) || failure);
}
if (window.__onboarding) await window.__onboarding.autoShowDecided();
await settle();
const modal = document.getElementById("onboarding-modal");
const report = {
  arrival,
  error,
  booted: Boolean(window.__onboarding),
  seedCheck: window.__onboarding ? window.__onboarding.seedCheckPasses() : null,
  desktop: Boolean(window.splitpageDesktop),
  opened: Boolean(modal && !modal.hidden)
};
closeApp();
process.stdout.write(JSON.stringify(report) + "\n");
process.exit(0);
