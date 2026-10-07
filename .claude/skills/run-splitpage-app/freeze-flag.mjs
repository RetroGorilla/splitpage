export const FREEZE_ENV = "SPLITPAGE_FREEZE_CACHES";

export function freezeAsked(env) {
  return env[FREEZE_ENV] === "1";
}

export const FROZEN_WRITE = /Cannot assign to read only property|object is not extensible|Cannot add property|Cannot delete property|Cannot define property/;

export function frozenWrites(consoleLines) {
  return consoleLines.filter((l) => l.startsWith("exception: ") && FROZEN_WRITE.test(l));
}

export function withFreezeFlag(url) {
  const hash = url.indexOf("#");
  const head = hash === -1 ? url : url.slice(0, hash);
  const tail = hash === -1 ? "" : url.slice(hash);
  if (/[?&]freeze-caches=/.test(head)) return url;
  return head + (head.includes("?") ? "&" : "?") + "freeze-caches=1" + tail;
}
