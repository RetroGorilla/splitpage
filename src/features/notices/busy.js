var BUSY_SHOW_DELAY_MS = 250;
var busyCount = 0;
var busyTimer = null;
var busyBarEl = null;

function busyBar() {
  if (busyBarEl && busyBarEl.isConnected) return busyBarEl;
  busyBarEl = document.createElement("div");
  busyBarEl.className = "busy-bar";
  busyBarEl.setAttribute("role", "status");
  busyBarEl.setAttribute("aria-live", "polite");
  busyBarEl.innerHTML = '<div class="busy-bar-sweep"></div><span class="busy-bar-label"></span>';
  document.body.appendChild(busyBarEl);
  return busyBarEl;
}

function showBusyBar(label) {
  var el = busyBar();
  var text = el.querySelector(".busy-bar-label");
  if (text) text.textContent = label || "Working…";
  el.classList.add("is-on");
}

function hideBusyBar() {
  if (busyBarEl) busyBarEl.classList.remove("is-on");
}

export function beginBusy(label) {
  busyCount++;
  if (busyCount === 1) {
    clearTimeout(busyTimer);
    busyTimer = setTimeout(function () {
      busyTimer = null;
      if (busyCount > 0) showBusyBar(label);
    }, BUSY_SHOW_DELAY_MS);
  } else if (busyBarEl && busyBarEl.classList.contains("is-on") && label) {
    showBusyBar(label);
  }
  return { done: false };
}

export function endBusy(token) {
  if (!token || token.done) return;
  token.done = true;
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount === 0) {
    clearTimeout(busyTimer);
    busyTimer = null;
    hideBusyBar();
  }
}

export async function withBusyBar(label, fn) {
  var token = beginBusy(label);
  try {
    return await fn();
  } finally {
    endBusy(token);
  }
}

