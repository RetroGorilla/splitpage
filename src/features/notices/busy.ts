const BUSY_SHOW_DELAY_MS = 250;
let busyCount = 0;
let busyTimer: number | null = null;
let busyBarEl: HTMLDivElement | null = null;

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

function showBusyBar(label?: string) {
  const el = busyBar();
  const text = el.querySelector(".busy-bar-label");
  if (text) text.textContent = label || "Working…";
  el.classList.add("is-on");
}

function hideBusyBar() {
  if (busyBarEl) busyBarEl.classList.remove("is-on");
}

export function beginBusy(label?: string) {
  busyCount++;
  if (busyCount === 1) {
    (clearTimeout as (id: number | null) => void)(busyTimer);
    busyTimer = setTimeout(function () {
      busyTimer = null;
      if (busyCount > 0) showBusyBar(label);
    }, BUSY_SHOW_DELAY_MS);
  } else if (busyBarEl && busyBarEl.classList.contains("is-on") && label) {
    showBusyBar(label);
  }
  return { done: false };
}

export function endBusy(token: unknown) {
  if (!token || (token as ReturnType<typeof beginBusy>).done) return;
  (token as ReturnType<typeof beginBusy>).done = true;
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount === 0) {
    (clearTimeout as (id: number | null) => void)(busyTimer);
    busyTimer = null;
    hideBusyBar();
  }
}

export async function withBusyBar<T>(label: string, fn: () => T | Promise<T>) {
  const token = beginBusy(label);
  try {
    return await fn();
  } finally {
    endBusy(token);
  }
}

