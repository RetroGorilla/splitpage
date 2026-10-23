let launcherAsking = false;

export function askingFromLauncher<T>(read: () => T): T {
  launcherAsking = true;
  try {
    return read();
  } finally {
    launcherAsking = false;
  }
}

export function dialogOpen(): boolean {
  return document.querySelector(".modal-backdrop:not([hidden])") !== null;
}

export function onlyDialogOpen(id: string): boolean {
  const open = document.querySelectorAll(".modal-backdrop:not([hidden])");
  return open.length === 1 && open[0]?.id === id;
}

export function launcherShown(): boolean {
  return document.querySelector(".cmdk-backdrop:not([hidden])") !== null;
}

export function launcherOpen(): boolean {
  return !launcherAsking && launcherShown();
}

