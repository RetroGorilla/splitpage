import { deliverBytes } from "../adapters/files/deliver.ts";
import { showToast } from "./effects-bridge.ts";

export interface DeliverOptions {
  readonly savedMsg?: string;
}

export async function deliverFile(filename: string, data: unknown, opts?: DeliverOptions | null): Promise<boolean> {
  const delivered = await deliverBytes(filename, data);
  if (delivered === "saved") showToast((opts && opts.savedMsg) || ("Saved " + filename), "ok");
  else if (delivered === "failed") showToast("Could not save the file. Please try again.", "error");
  return delivered === "saved";
}
