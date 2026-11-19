import { ALL_RULES, NativeReplica } from "../../src/native/variant.ts";

// why: E2 and E5 run unedited against the new reader; this preload only changes the default every replica starts with
NativeReplica.defaultRules = ALL_RULES;
