import type { NoticePort } from "../effects/ports.ts";
import type { FileDelivery } from "../files/file-delivery.ts";
import type { LocalFileAccess } from "../files/local-file-access.ts";
import type { DocumentLocation } from "../location/document-location.ts";
import type { SaveJob, SaveOutcome, WriterResult } from "./coordinator.ts";
import type { SaveDestination } from "./destinations.ts";

export interface ImportSaveRequest {
  readonly kind: string;
  readonly target?: unknown;
}

export interface ImportSaveItem {
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly reason: string;
  readonly label: string;
}

export interface BuiltLocalFile {
  readonly data: unknown;
  readonly filename: string;
}

export interface ImportSavingPorts {
  readonly location: Pick<DocumentLocation, "importHome" | "amendHome">;
  readonly saving: {
    readonly request: (request: ImportSaveRequest) => Promise<SaveOutcome>;
    readonly unsavedFor: (target: unknown) => boolean;
  };
  readonly buildFileData: (kind: string, baseName: string) => Promise<BuiltLocalFile>;
  readonly files: Pick<LocalFileAccess, "read" | "checkConflict" | "createWritable">;
  readonly delivery: FileDelivery;
  readonly notices: Pick<NoticePort, "show">;
}

export interface ImportSavingOwner {
  readonly startImportSaving: (ports: ImportSavingPorts) => () => void;
  readonly saveBackItemState: () => ImportSaveItem;
  readonly saveBackToFile: (options?: { force?: boolean }) => Promise<void>;
  readonly writeBackToFile: (job: SaveJob<ImportSaveRequest>) => Promise<WriterResult>;
  readonly importSaveDestination: () => SaveDestination<ImportSaveRequest>;
}
