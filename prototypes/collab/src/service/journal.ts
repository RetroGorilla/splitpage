import { DatabaseSync } from "node:sqlite";

export class UpdateJournal {
  readonly database: DatabaseSync;
  readonly configuration: { journalMode: string; synchronous: number };

  constructor(path: string, settings = { journalMode: "WAL", synchronous: "FULL" }, timeout = 0) {
    this.database = new DatabaseSync(path, { timeout });
    try {
      if (!/^(WAL|DELETE|MEMORY)$/.test(settings.journalMode) || !/^(FULL|NORMAL|OFF)$/.test(settings.synchronous)) {
        throw new Error("Unsupported durability setting");
      }
      this.database.exec(`PRAGMA journal_mode=${settings.journalMode}; PRAGMA synchronous=${settings.synchronous}`);
      const mode = this.database.prepare("PRAGMA journal_mode").get();
      const sync = this.database.prepare("PRAGMA synchronous").get();
      this.configuration = { journalMode: String(mode?.journal_mode), synchronous: Number(sync?.synchronous) };
      if (this.configuration.journalMode !== "wal" || this.configuration.synchronous !== 2) {
        throw new Error(`Durability mismatch: ${JSON.stringify(this.configuration)}`);
      }
      this.database.exec("CREATE TABLE IF NOT EXISTS updates (sequence INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT NOT NULL, payload BLOB NOT NULL)");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  append(document: string, payloads: readonly Uint8Array[]): number[] {
    const insert = this.database.prepare("INSERT INTO updates(document, payload) VALUES (?, ?)");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const sequences = payloads.map(payload => Number(insert.run(document, payload).lastInsertRowid));
      this.database.exec("COMMIT");
      return sequences;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  read(document: string): { sequence: number; payload: Uint8Array }[] {
    return this.database.prepare("SELECT sequence, payload FROM updates WHERE document = ? ORDER BY sequence").all(document).map(row => {
      if (!(row.payload instanceof Uint8Array)) throw new Error("Invalid journal row");
      return { sequence: Number(row.sequence), payload: row.payload };
    });
  }

  close(): void {
    this.database.close();
  }
}
