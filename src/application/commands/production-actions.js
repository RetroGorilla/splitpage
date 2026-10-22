import { newBrollShot } from "../../core/document/broll.ts";
import { cappedText } from "../../core/document/text-policy.ts";
import { addShotCommand, removeShotPropCommand } from "./broll-records.ts";
import { retagCommand } from "./production-records.ts";

export function renameTag(cat, oldName, newName, ports) {
  const clean = cappedText(newName, 80);
  if (!clean) return false;
  const tag = { cat: cat, name: oldName };
  return ports.run(retagCommand(tag, clean, ports.rewrites([tag], clean), ports.stamps));
}

export function removeTag(cat, name, ports) {
  const tag = { cat: cat, name: name };
  const n = ports.read(function (doc) { return ports.mentions(doc, [tag]); });
  if (!n) return 0;
  return ports.run(retagCommand(tag, null, ports.rewrites([tag], null), ports.stamps)) ? n : 0;
}

export function newBrollRecord(fields, ports) {
  const rec = newBrollShot(ports.ids.id("bs"), fields || {});
  ports.run(addShotCommand(rec));
  return rec;
}

export function removeBrollProp(shotId, ref, ports) {
  return ports.run(removeShotPropCommand(shotId, ref));
}
