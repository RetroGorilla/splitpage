export const GUARD_ENV = "SPLITPAGE_DOCUMENT_GUARD";

export function guardAsked(env) {
  return env[GUARD_ENV] === "1";
}

export const GUARDED_WRITE = /DocumentWriteError/;

export function guardedWrites(consoleLines) {
  return consoleLines.filter((l) => GUARDED_WRITE.test(l));
}

export function withGuardFlag(url) {
  const hash = url.indexOf("#");
  const head = hash === -1 ? url : url.slice(0, hash);
  const tail = hash === -1 ? "" : url.slice(hash);
  if (/[?&]document-guard=/.test(head)) return url;
  return head + (head.includes("?") ? "&" : "?") + "document-guard=1" + tail;
}
