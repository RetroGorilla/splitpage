import { RelayError } from "./config.ts";

export function reportFailure(error: unknown, fallback: string): void {
  process.stderr.write((error instanceof RelayError ? error.message : fallback) + "\n");
  process.exitCode = 1;
}

export function restrictLibraryLogs(): void {
  // why: Hocuspocus 4.8.0 includes an untrusted document name in its pending-document warning.
  console.warn = () => { process.stderr.write("Relay library warning.\n"); };
  console.error = () => { process.stderr.write("Relay library error.\n"); };
}
