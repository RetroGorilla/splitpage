import { targetLengthOf } from "../../core/document/timing.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, Plan } from "../session/document-session.ts";
import { sharedScalar } from "./shared-values.ts";
import type { SharedValuePorts } from "./shared-values.ts";

function targetChange(): ChangeSet {
  return changeSet({ docFields: ["targetSeconds"], saveNow: true });
}

function paceChange(): ChangeSet {
  return changeSet({ docFields: ["wordsPerMinute"], saveNow: true });
}

export const WPM_MIN = 60;

export const WPM_MAX = 400;

export function targetLengthCommand(seconds: number | null | undefined, shared?: SharedValuePorts): Command {
  const after = seconds == null ? null : targetLengthOf({ targetSeconds: seconds });
  return {
    name: "set-target-length",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (targetLengthOf({ targetSeconds: doc["targetSeconds"] }) === after) return null;
      const by = shared?.author();
      return {
        ...by ? { shared: { operations: [sharedScalar(by, "document", doc.docId, "targetSeconds", after)] } } : {},
        changes: targetChange(),
        apply: function (live) {
          if (after === null) Reflect.deleteProperty(live, "targetSeconds");
          else live["targetSeconds"] = after;
        }
      };
    }
  };
}

export function wordsPerMinuteCommand(value: number, shared?: SharedValuePorts): Command {
  const wpm = Math.round(value);
  return {
    name: "set-words-per-minute",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (!isFinite(wpm) || wpm < WPM_MIN || wpm > WPM_MAX || wpm === doc["wordsPerMinute"]) return null;
      const by = shared?.author();
      return {
        ...by ? { shared: { operations: [sharedScalar(by, "document", doc.docId, "wordsPerMinute", wpm)] } } : {},
        changes: paceChange(),
        apply: function (live) { live["wordsPerMinute"] = wpm; }
      };
    }
  };
}
