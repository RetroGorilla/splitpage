import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

interface MarkAuditEdit { file: string; before: string; after: string; count?: number }
interface MarkMutationDefinition { id: string; edits: MarkAuditEdit[]; outcome?: "SURVIVED" }
export interface MarkMutationEvidence { id: string; outcome: "DETECTED" | "SURVIVED"; failedTests: string[]; failedTestCount: number; edits: MarkAuditEdit[] }

const projection = "src/marks/projection.ts";
const commands = "src/marks/commands.ts";
const schema = "src/schema.ts";
const resolution = "src/marks/status-resolution.ts";

export const markMutationDefinitions: readonly MarkMutationDefinition[] = [
  { id: "root-initialization", edits: [{ file: schema, before: "if (initializeRoots) initializeSchemaRoots(this.doc, candidate);", after: "if (false) initializeSchemaRoots(this.doc, candidate);" }] },
  { id: "split-descendant-classification", edits: [{ file: "src/readers/structure.ts", before: 'removal.beat === row.id || row.characters.some(character => removalObserved([removal], character.identity))', after: 'removal.beat === row.id' }] },
  { id: "acceptance-extent-sort", outcome: "SURVIVED", edits: [{ file: projection, before: "[...extents.values()].sort((a, b) => a.start - b.start || b.end - a.end || compareCodeUnits(a.key, b.key))", after: "[...extents.values()]" }] },
  { id: "outer-inner-stack-sort", outcome: "SURVIVED", edits: [{ file: projection, before: ".sort((a, b) => (b.end - b.start) - (a.end - a.start) || compareCodeUnits(a.key, b.key))", after: "" }] },
  { id: "both-nesting-sorts", edits: [
    { file: projection, before: "[...extents.values()].sort((a, b) => a.start - b.start || b.end - a.end || compareCodeUnits(a.key, b.key))", after: "[...extents.values()]" },
    { file: projection, before: ".sort((a, b) => (b.end - b.start) - (a.end - a.start) || compareCodeUnits(a.key, b.key))", after: "" }
  ] },
  { id: "crossing-rejection", edits: [{ file: projection, before: 'crossing || !rootMap(doc, "tags")?.has(extent.tag)', after: '!rootMap(doc, "tags")?.has(extent.tag)' }] },
  { id: "crossing-recovery", edits: [{ file: projection, before: "if (rejected.length) (model.records ??= {}).tagRecovery = rejected;", after: "if (rejected.length) (model.records ??= {}).tagRecovery = [];" }] },
  { id: "whole-tag-comment-union", edits: [{ file: projection, before: 'if (key.startsWith("c:")) marks[key] = value;', after: 'if (key.startsWith("c:")) void value;' }] },
  { id: "first-link-over-stretch", edits: [{ file: projection, before: "link ??= found?.[1];", after: "if (found) link = found[1];" }] },
  { id: "smallest-link-per-character", edits: [{ file: projection, before: "if (links[0]) marks.href = links[0][1];", after: "if (links.at(-1)) marks.href = links.at(-1)![1];" }] },
  { id: "smallest-link-inside-tag", edits: [{ file: projection, before: 'const found = Object.entries(original).filter(([key]) => key.startsWith("l:")).sort(([a], [b]) => compareCodeUnits(a, b))[0];', after: 'const found = Object.entries(original).filter(([key]) => key.startsWith("l:")).sort(([a], [b]) => compareCodeUnits(a, b)).at(-1);' }] },
  { id: "per-comment-keys", edits: [{ file: commands, before: "{ [`c:${id}`]: true }", after: "{ cmt: id }" }] },
  { id: "per-tag-keys", edits: [{ file: schema, before: "text.format(start + offset, length, marks);", after: 'text.format(start + offset, length, Object.fromEntries(Object.entries(marks).map(([key, value]) => [key.startsWith("t:") ? "tag" : key, value])));' }] },
  { id: "explicit-insert-attributes", edits: [{ file: schema, before: "text.insert(start + offset, value, marks);", after: "text.insert(start + offset, value);" }] },
  { id: "detached-row-fallback", edits: [{ file: projection, before: "rowId: anchor?.row.id ?? original.rowId", after: "rowId: anchor?.row.id" }] },
  { id: "detached-field-fallback", edits: [{ file: projection, before: 'field: anchor ? "audioText" : original.field', after: 'field: "audioText"' }] },
  { id: "first-marked-anchor", edits: [{ file: projection, before: "rowId: anchor?.row.id ?? original.rowId", after: "rowId: original.rowId" }] },
  { id: "comment-recovery-classification", edits: [{ file: projection, before: "recovery: anchor?.recovery ?? true", after: "recovery: false" }] },
  { id: "reply-order", edits: [{ file: projection, before: "validated.sort((a, b) => a.createdAt - b.createdAt || compareCodeUnits(a.id, b.id));", after: "void validated;" }] },
  { id: "orphan-reply-recovery", edits: [{ file: projection, before: 'records.recoveryReplies = replies.filter(reply => !Object.hasOwn(comments, reply.commentId));', after: "records.recoveryReplies = [];" }] },
  { id: "author-command-guard", edits: [{ file: commands, before: 'if (item.get("author") !== author) return false;', after: "void author;" }] },
  { id: "tag-registry-id", edits: [{ file: commands, before: "const id = `tag-${kind}-${Array.from", after: "const id = `other-${kind}-${Array.from" }] },
  { id: "local-undo-origin", edits: [{ file: "src/structure.ts", before: "trackedOrigins: new Set([replica.localOrigin])", after: 'trackedOrigins: new Set([replica.localOrigin, "delivery"])' }] },
  { id: "status-target-filter", edits: [{ file: commands, before: 'event?.target === target', after: "event" }] },
  { id: "status-command-parents", edits: [{ file: commands, before: "parents: frontier.map(([key]) => key).sort()", after: "parents: []" }] },
  { id: "status-prior-after-retirement", edits: [{ file: commands, before: 'resolveBeatStatus(new Map(statusEvents(replica, target)), rootMap(replica.doc, "retiredStatus") ?? new Set<string>(),', after: 'resolveBeatStatus(new Map(statusEvents(replica, target)), new Set<string>(),' }] },
  { id: "status-reader-frontier", edits: [{ file: resolution, before: "return resolve(statusHeads(events));", after: "return resolve([...events.keys()]);" }] },
  { id: "status-reader-retirement", edits: [{ file: resolution, before: "retired.has(id) ? resolve(event.parents.filter(parent => events.has(parent))) : event.value", after: "event.value" }] },
  { id: "status-conflict-value", edits: [{ file: resolution, before: "heads = statusHeads(shared);", after: 'return values.at(-1) ?? stored;' }] },
  { id: "status-notices", edits: [{ file: projection, before: 'model.notices = [...new Set(conflict.map(([, event]) => `${event.by}: concurrent status change did not apply`))].sort();', after: "model.notices = [];" }] },
  { id: "status-undo-metadata", edits: [{ file: commands, before: 'item.meta.set("statusEvent", id);', after: 'item.meta.delete("statusEvent");' }] },
  { id: "status-command-boundaries", edits: [{ file: commands, before: "manager.stopCapturing();", after: "", count: 2 }] },
  { id: "status-retire-whole-frontier", edits: [{ file: commands, before: "for (const [key] of frontier)", after: "for (const [key] of frontier.filter(([key]) => key === id))" }] },
  { id: "status-noop-emits-no-update", edits: [{ file: commands, before: 'if (!replica.doc.getMap("retiredStatus").has(key)) ', after: "" }] },
  { id: "ineffective-status-consumption", edits: [
    { file: commands, before: "const frontier = statusFrontier(replica, event.target);", after: 'const alreadyRetired = replica.doc.getMap("retiredStatus").has(id);\n  const frontier = statusFrontier(replica, event.target);' },
    { file: commands, before: "manager.undoStack.pop();", after: "if (!alreadyRetired) manager.undoStack.pop();" }
  ] },
  { id: "projection-emits-repair", edits: [{ file: projection, before: "export function projectStructuralMarks(model: CollabModel, doc: Y.Doc): void {", after: 'export function projectStructuralMarks(model: CollabModel, doc: Y.Doc): void {\n  doc.getMap("meta").set("repair", true);' }] },
  { id: "format-selection-reanchor", outcome: "SURVIVED", edits: [{ file: commands, before: "return restoreStructuralAnchor(replica, selection.selection);", after: "return selection.selection;" }] }
];

export function auditMarkMutations(): { baselinePasses: number; results: MarkMutationEvidence[] } {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const temporaryBase = resolve(tmpdir());
  const fixture = mkdtempSync(join(temporaryBase, "marks-mutation-"));
  const suffix = relative(temporaryBase, fixture);
  if (!suffix || suffix.startsWith("..") || isAbsolute(suffix) || !basename(fixture).startsWith("marks-mutation-")) throw new Error("Unsafe mutation fixture path");
  const logDirectory = join(temporaryBase, "marks-mutation-logs");
  mkdirSync(logDirectory, { recursive: true });
  const args = ["--test", "--test-concurrency=1", "--test-reporter=tap", "--test-skip-pattern=mark result table", "test/marks/marks.test.ts", "test/marks/root-initialization.test.ts", "test/marks/reader-rules.test.ts"];
  const run = (): { status: number | null; output: string; failures: string[] } => {
    const child = spawnSync(process.execPath, args, { cwd: fixture, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (child.error) throw child.error;
    const output = child.stdout + child.stderr;
    const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1] ?? "");
    return { status: child.status, output, failures };
  };
  try {
    for (const directory of ["src", "test"]) cpSync(join(root, directory), join(fixture, directory), { recursive: true });
    cpSync(join(root, "package.json"), join(fixture, "package.json"));
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const baseline = run();
    writeFileSync(join(logDirectory, "baseline.tap"), baseline.output);
    const baselinePasses = Number(baseline.output.match(/^# pass (\d+)$/m)?.[1]);
    if (baseline.status !== 0 || !baselinePasses) throw new Error(`Baseline failed: ${join(logDirectory, "baseline.tap")}`);
    const results: MarkMutationEvidence[] = [];
    for (const mutation of markMutationDefinitions) {
      const originals = new Map<string, string>();
      try {
        for (const edit of mutation.edits) {
          const path = join(fixture, edit.file);
          const source = readFileSync(path, "utf8");
          if (!originals.has(path)) originals.set(path, source);
          const pieces = source.split(edit.before);
          if (pieces.length - 1 !== (edit.count ?? 1)) throw new Error(`Mutation target changed: ${mutation.id}`);
          writeFileSync(path, pieces.join(edit.after));
        }
        const result = run();
        writeFileSync(join(logDirectory, `${mutation.id}.tap`), result.output);
        const outcome = result.status === 0 ? "SURVIVED" : "DETECTED";
        if (outcome === "DETECTED" && !result.failures.some(name => name.startsWith("A:") || name.startsWith("B:"))) throw new Error(`Mutation caused a load failure: ${mutation.id}`);
        if (outcome !== (mutation.outcome ?? "DETECTED")) throw new Error(`Unexpected ${outcome}: ${mutation.id}; see ${logDirectory}`);
        results.push({ id: mutation.id, outcome, failedTests: result.failures.slice(0, 3), failedTestCount: result.failures.length, edits: mutation.edits });
        console.log(`${mutation.id}: ${outcome} (${result.failures.length} failed tests)`);
      } finally {
        for (const [path, source] of originals) writeFileSync(path, source);
      }
    }
    return { baselinePasses, results };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = auditMarkMutations();
  if (process.argv.includes("--write")) writeFileSync(new URL("../../mark-mutations.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Baseline ${evidence.baselinePasses} passes; ${evidence.results.filter(result => result.outcome === "DETECTED").length} detected, ${evidence.results.filter(result => result.outcome === "SURVIVED").length} survived (claims withdrawn).`);
}
