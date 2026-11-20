import { backupRelay } from "./backup.ts";
import { reportFailure } from "./logging.ts";

try {
  process.stdout.write(`Verified relay backup ${await backupRelay(process.env)}.\n`);
} catch (error) {
  reportFailure(error, "Relay backup failed. Check the database and data volume permissions.");
}
