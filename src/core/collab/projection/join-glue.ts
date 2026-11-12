export function sharedJoinGlueRegisterField(group: string): string { return "joinGlue:" + group; }

export function projectSharedJoinGlue(issued: "" | " ", register: unknown): "" | " " {
  return register === "" || register === " " ? register : issued;
}
