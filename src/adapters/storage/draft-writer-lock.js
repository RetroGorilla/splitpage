var BROWSER_DRAFT_LOCK = "splitpage-draft-writer-";

export var browserWriterId = (function () {
  var bytes = new Uint8Array(16);
  try { crypto.getRandomValues(bytes); } catch (e) {
    for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.prototype.map.call(bytes, function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
})();

var browserLockRelease = null;
var browserLockWanted = false;

export function holdBrowserWriterLock() {
  if (browserLockWanted) return;
  browserLockWanted = true;
  try {
    if (!navigator.locks || typeof navigator.locks.request !== "function") return;
    navigator.locks.request(BROWSER_DRAFT_LOCK + browserWriterId, function () {
      if (!browserLockWanted) return null;
      return new Promise(function (resolve) { browserLockRelease = resolve; });
    }).then(null, function () {});
  } catch (e) {}
}

export function releaseBrowserWriterLock() {
  browserLockWanted = false;
  var release = browserLockRelease;
  browserLockRelease = null;
  if (release) release();
}

export function browserWriterIsLive(writerId) {
  if (!writerId) return Promise.resolve(false);
  if (writerId === browserWriterId) return Promise.resolve(true);
  try {
    if (!navigator.locks || typeof navigator.locks.query !== "function") return Promise.resolve(false);
    return navigator.locks.query().then(function (s) {
      return ((s && s.held) || []).some(function (l) { return l && l.name === BROWSER_DRAFT_LOCK + writerId; });
    }, function () { return false; });
  } catch (e) { return Promise.resolve(false); }
}
