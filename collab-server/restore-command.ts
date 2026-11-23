import { restoreRelay } from "./backup.ts";
import { RelayError } from "./config.ts";
import { reportFailure } from "./logging.ts";

try {
  const [archive, target, ...extra] = process.argv.slice(2);
  if (!archive || !target || extra.length) {
    throw new RelayError("Usage: node restore-command.ts <backup> <new-data-directory>");
  }
  await restoreRelay(archive, target);
  process.stdout.write("Verified relay restore. All invitations are revoked.\n");
} catch (error) {
  reportFailure(error, "Relay restore failed. Check the backup and choose a new data directory.");
}
