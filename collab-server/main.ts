import { reportFailure, restrictLibraryLogs } from "./logging.ts";
import { startRelay } from "./relay.ts";

restrictLibraryLogs();
try {
  const relay = await startRelay(process.env);
  process.stdout.write(`Relay listening on port ${relay.address.port}.\n`);
} catch (error) {
  reportFailure(error, "Relay startup failed.");
}
