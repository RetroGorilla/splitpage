export function sharedJoinGlueRegisterField(join: string): string { return "joinGlue:" + join; }

export function projectSharedJoinGlue(issued: "" | " ", register: unknown): "" | " " {
  return register === "" || register === " " ? register : issued;
}
