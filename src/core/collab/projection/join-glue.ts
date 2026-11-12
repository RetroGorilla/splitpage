export function sharedJoinGlueRegisterField(group: string): string { return "joinGlue:" + group; }
export function readSharedJoinGlue(register: unknown): "" | " " | null {
  return register === "" || register === " " ? register : null;
}

export function projectSharedJoinGlue(issued: "" | " ", register: unknown): "" | " " {
  return readSharedJoinGlue(register) ?? issued;
}
