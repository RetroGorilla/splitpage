import { loadGraph } from "./dep-report.mjs";

export const TREE_INVENTORIES = [
  "tests/adapters/collab/guarded-subscriptions.test.ts",
  "tests/adapters/collab/operation-families.test.ts",
  "tests/adapters/collab/trial-replica.test.ts",
  "tests/application/commit-time-writers.test.ts"
];

export const nativePath = (path) => /^(?:src|tests)\/adapters\/collab\/native\//.test(path);
const oldAdapterArea = (path) => !nativePath(path) &&
  /^(?:src\/(?:core|application|adapters\/collab)\/|shared\/|src\/bootstrap\/wiring\/(?:ports\/)?shared-|tests\/)/.test(path);

const oldSource = (path) => path.startsWith("src/adapters/collab/") && !nativePath(path);
const candidate = (path) => !nativePath(path) && /^tests\/(?:collab|adapters\/collab)\/.*\.test\.[cm]?[jt]s$/.test(path);
const testLibraries = new Set(["builtin:assert/strict", "builtin:test", "builtin:util", "package:lib0", "package:yjs"]);

export function oldAdapterFiles(repo, graph = loadGraph(repo)) {
  const imports = new Map();
  const dependencies = new Set();
  const wiringImporters = [...graph.values()]
    .filter(({ path, edges }) => path.startsWith("src/bootstrap/wiring/") && edges.some(({ target }) => oldSource(target)))
    .map(({ path }) => path);
  for (const test of graph.keys()) {
    if (!candidate(test) || TREE_INVENTORIES.includes(test)) continue;
    const reach = new Set([test]);
    let safe = true;
    for (const path of reach) {
      const module = graph.get(path);
      if (!oldAdapterArea(path) || !module || module.unresolved.length) {
        safe = false;
        break;
      }
      for (const edge of module.edges) {
        if (edge.kind === "file" || edge.kind === "missing") reach.add(edge.target);
        if (!edge.typeOnly && (edge.kind === "builtin" || edge.kind === "package") && !testLibraries.has(edge.target)) safe = false;
      }
      if (!safe) break;
    }
    if (!safe || ![...reach].some(oldSource)) continue;
    imports.set(test, reach);
    for (const path of reach) dependencies.add(path);
  }
  return { isOldTest: (path) => imports.has(path), dependencies, imports, wiringImporters };
}

export function partitionRootTests(entries, isOldTest) {
  return {
    always: entries.map((entry) => ({ ...entry, files: entry.files.filter((path) => !isOldTest(path)) })),
    "old-adapter": entries.map((entry) => ({ ...entry, files: entry.files.filter(isOldTest) }))
  };
}
