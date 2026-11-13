import { FORMAT_MARKS } from "../../text/runs.ts";
import type { FormatMark } from "../../text/runs.ts";

export function sharedJoinGlueRegisterField(group: string): string { return "joinGlue:" + group; }
export function sharedJoinFormatRegisterField(group: string, format: FormatMark): string { return "joinFormat:" + format + ":" + group; }
export function isSharedJoinFormatRegisterField(key: string): boolean { return key.startsWith("joinFormat:"); }
export function readSharedJoinGlue(register: unknown): "" | " " | null {
  return register === "" || register === " " ? register : null;
}

export function projectSharedJoinGlue(issued: "" | " ", register: unknown): "" | " " {
  return readSharedJoinGlue(register) ?? issued;
}

export function projectSharedJoinFormats(group: string, read: (field: string) => unknown): FormatMark[] {
  return FORMAT_MARKS.filter(format => read(sharedJoinFormatRegisterField(group, format)) === true);
}
