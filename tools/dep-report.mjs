import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { REPO, isScript, listRepoFiles, parseScript, lineOf } from "./source-scan.mjs";

export const BASELINE_PATH = join(REPO, "tools", "dep-baseline.json");

const EXCLUDED = [/^node_modules\//, /\/node_modules\//, /^\.claude\/handoff\//, /^index\.html$/];
const RESOLVE_SUFFIXES = ["", ".ts", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json", "/index.ts", "/index.js", "/index.mjs"];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, "")]));

export const MIGRATED_LAYERS = ["core", "contracts", "application", "adapters", "features", "bootstrap", "legacy"];

const CORE_DEPENDENCIES = {
  "core/document": ["core/document"],
  "core/text": ["core/text", "core/document"],
  "core/merge": ["core/merge", "core/document", "core/text"],
  "core/production": ["core/production", "core/document", "core/text"]
};

const PLATFORM_GLOBALS = new Set([
  "window", "document", "navigator", "location", "history", "localStorage", "sessionStorage", "indexedDB",
  "caches", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "BroadcastChannel", "Worker",
  "AbortController", "URL", "TextDecoder", "TextEncoder", "Blob", "File", "FileReader", "Image",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "queueMicrotask", "performance", "crypto", "process", "Buffer", "require", "module",
  "exports", "__dirname", "__filename", "globalThis", "self", "electron"
]);

const COMMONJS_GLOBALS = new Set(["require", "module", "exports"]);

export function layerOf(path) {
  if (path.startsWith("src/test/") || path.startsWith("tests/") || /\.test\.[cm]?[jt]s$/.test(path)) return "tests";
  const core = /^src\/core\/([^/]+)\//.exec(path);
  if (core) return CORE_DEPENDENCIES[`core/${core[1]}`] ? `core/${core[1]}` : "core";
  if (/^src\/core\//.test(path)) return "core";
  const feature = /^src\/features\/([^/]+)\//.exec(path);
  if (feature) return `features/${feature[1]}`;
  const top = /^src\/(application|contracts|adapters|bootstrap|legacy)\//.exec(path);
  if (top) return top[1];
  if (path.startsWith("src/js/")) return "legacy-js";
  if (path.startsWith("shared/")) return "shared";
  if (path.startsWith("server/")) return "server";
  if (path.startsWith("desktop/")) return "desktop";
  if (path.startsWith("tools/")) return "tools";
  return "other";
}

export function isMigrated(layer) {
  return MIGRATED_LAYERS.includes(layer.split("/")[0]);
}

function isCore(layer) {
  return layer === "core" || layer.startsWith("core/");
}

export function layerAllows(source, target) {
  if (source === target) return true;
  if (target === "tests") return ["tools", "other"].includes(source);
  if (isCore(source)) {
    if (target === "shared") return true;
    if (source === "core") return isCore(target);
    return (CORE_DEPENDENCIES[source] ?? []).includes(target);
  }
  switch (source) {
    case "shared": return false;
    case "contracts": return target === "shared";
    case "application": return isCore(target) || target === "contracts" || target === "shared";
    case "adapters": return isCore(target) || ["application", "contracts", "shared"].includes(target);
    case "legacy": return isCore(target) || ["legacy-js", "application", "contracts", "adapters", "shared"].includes(target);
    case "bootstrap": return true;
    default:
      if (source.startsWith("features/")) return isCore(target) || ["application", "contracts", "shared"].includes(target);
      return true;
  }
}

export function platformImportAllowed(layer) {
  return !(isCore(layer) || layer.startsWith("features/") || ["shared", "contracts", "application"].includes(layer));
}

export function platformGlobalsBanned(layer) {
  return isCore(layer) || ["shared", "contracts", "application"].includes(layer);
}

function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function resolveSpecifier(from, spec, fileSet) {
  if (spec.startsWith("node:") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0])) return { kind: "builtin", target: `builtin:${spec.replace(/^node:/, "")}` };
  if (!spec.startsWith(".") && !spec.startsWith("/")) return { kind: "package", target: `package:${packageName(spec)}` };
  const base = spec.startsWith("/") ? spec.slice(1) : posix.join(posix.dirname(from), spec);
  const normalized = posix.normalize(base);
  const candidates = RESOLVE_SUFFIXES.map((s) => normalized + s);
  if (/\.js$/.test(normalized)) candidates.push(normalized.replace(/\.js$/, ".ts"));
  for (const c of candidates) if (fileSet.has(c)) return { kind: "file", target: c };
  return { kind: "missing", target: normalized };
}

function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function isDeclarationName(node) {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === node) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)
    || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === node) return true;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && (p.propertyName === node || p.name === node)) return true;
  if ((ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === node) return true;
  if (ts.isBindingElement(p) && p.propertyName === node) return true;
  if (ts.isJsxAttribute(p) && p.name === node) return true;
  return false;
}

function collectDeclaredNames(sf) {
  const names = new Set();
  const visit = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) names.add(node.name.text);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)
      || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) names.add(node.name.text);
    if (ts.isImportClause(node) && node.name) names.add(node.name.text);
    if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

export function analyzeScript(path, text) {
  const sf = parseScript(path, text);
  const imports = [];
  const unresolved = [];
  const globals = new Map();
  const state = { importsState: false, stateWrites: 0, stateFieldWrites: 0, stateReads: 0 };
  const declared = collectDeclaredNames(sf);
  const commonjs = /\.c[jt]s$/.test(path) || sf.statements.some((s) => ts.isExpressionStatement(s) && literalText(s.expression) === "use strict");
  const at = (node) => lineOf(text, node.getStart(sf));
  const add = (spec, typeOnly, kind, node) => imports.push({ spec, typeOnly, kind, line: at(node) });
  let stateName = null;

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = literalText(node.moduleSpecifier);
      if (spec !== null) {
        add(spec, Boolean(node.importClause?.isTypeOnly), "import", node);
        if (/(^|\/)_state(\.js)?$/.test(spec) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const el of node.importClause.namedBindings.elements) {
            if ((el.propertyName ?? el.name).text === "S") { state.importsState = true; stateName = el.name.text; }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = literalText(node.moduleSpecifier);
      if (spec !== null) add(spec, node.isTypeOnly, "re-export", node);
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      const spec = ts.isLiteralTypeNode(arg) ? literalText(arg.literal) : null;
      if (spec !== null) add(spec, true, "type-import", node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require" && !declared.has("require");
      if (isDynamicImport || isRequire) {
        const spec = literalText(node.arguments[0]);
        const kind = isDynamicImport ? "dynamic-import" : "require";
        if (spec !== null) add(spec, false, kind, node);
        else unresolved.push({ kind, expression: node.getText(sf).replace(/\s+/g, " "), line: at(node) });
      }
    } else if (ts.isIdentifier(node) && PLATFORM_GLOBALS.has(node.text) && !declared.has(node.text) && !isDeclarationName(node)) {
      if (!(commonjs && COMMONJS_GLOBALS.has(node.text))) {
        if (!globals.has(node.text)) globals.set(node.text, at(node));
      }
    }
    if (stateName && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === stateName) {
      const p = node.parent;
      const written = p && ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const updated = p && (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator);
      const deleted = p && ts.isDeleteExpression(p);
      if (written || updated || deleted) {
        state.stateFieldWrites++;
        if (node.name.text === "state") state.stateWrites++;
      } else {
        state.stateReads++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { imports, unresolved, globals: [...globals].map(([name, line]) => ({ name, line })), state };
}

export function isAnalyzed(path) {
  return isScript(path) && !EXCLUDED.some((re) => re.test(path)) && !/(^|\/)(eslint\.config|vitest\.config)\.[cm]?js$/.test(path);
}

export function buildGraph(sources, allFiles = sources.map((s) => s.path)) {
  const fileSet = new Set([...allFiles, ...sources.map((s) => s.path)]);
  const modules = new Map();
  for (const { path, text } of sources) {
    const analysis = analyzeScript(path, text);
    const edges = analysis.imports.map((i) => ({ ...i, ...resolveSpecifier(path, i.spec, fileSet) }));
    modules.set(path, { path, layer: layerOf(path), edges, unresolved: analysis.unresolved, globals: analysis.globals, state: analysis.state });
  }
  return modules;
}

export function stronglyConnected(modules, includeTypeOnly) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  const successors = (path) => [...new Set(modules.get(path).edges
    .filter((e) => e.kind === "file" && (includeTypeOnly || !e.typeOnly) && modules.has(e.target))
    .map((e) => e.target))];
  for (const start of [...modules.keys()].sort()) {
    if (index.has(start)) continue;
    const work = [{ node: start, next: 0, succ: null }];
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.succ === null) {
        index.set(frame.node, counter);
        low.set(frame.node, counter);
        counter++;
        stack.push(frame.node);
        onStack.add(frame.node);
        frame.succ = successors(frame.node);
      }
      if (frame.next < frame.succ.length) {
        const w = frame.succ[frame.next++];
        if (!index.has(w)) work.push({ node: w, next: 0, succ: null });
        else if (onStack.has(w)) low.set(frame.node, Math.min(low.get(frame.node), index.get(w)));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        let w;
        do { w = stack.pop(); onStack.delete(w); component.push(w); } while (w !== frame.node);
        const selfLoop = component.length === 1 && successors(component[0]).includes(component[0]);
        if (component.length > 1 || selfLoop) components.push(component.sort());
      }
    }
  }
  return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

function key(v) {
  return `${v.rule}\u0000${v.source}\u0000${v.target}`;
}

export function findViolations(modules) {
  const found = new Map();
  const add = (rule, source, target, line, detail) => {
    const v = { rule, source, target };
    if (!found.has(key(v))) found.set(key(v), { ...v, line, detail });
  };
  for (const m of modules.values()) {
    for (const e of m.edges) {
      if (e.kind === "file") {
        const targetLayer = layerOf(e.target);
        if (!layerAllows(m.layer, targetLayer)) add("layer", m.path, e.target, e.line, `${m.layer} may not import ${targetLayer}`);
      } else if (e.kind === "builtin" || e.kind === "package") {
        if (!platformImportAllowed(m.layer)) add("platform-import", m.path, e.target, e.line, `${m.layer} may not import ${e.target}`);
      } else if (e.kind === "missing") {
        add("missing-module", m.path, e.target, e.line, `${e.spec} does not resolve to a file`);
      }
    }
    for (const u of m.unresolved) add("unresolved-dynamic", m.path, u.expression, u.line, `${u.kind} with a computed specifier`);
    if (platformGlobalsBanned(m.layer)) {
      for (const g of m.globals) add("platform-global", m.path, `global:${g.name}`, g.line, `${m.layer} may not use ${g.name}`);
    }
  }
  return [...found.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

export function migratedCycles(modules) {
  const out = [];
  for (const [label, includeTypes] of [["runtime", false], ["with-types", true]]) {
    for (const c of stronglyConnected(modules, includeTypes)) {
      const migrated = c.filter((p) => isMigrated(layerOf(p)));
      if (migrated.length) out.push({ graph: label, modules: c, migrated });
    }
  }
  return out;
}

export function compareBaseline(violations, baseline) {
  const allowed = new Map((baseline.exceptions ?? []).map((e) => [key(e), e]));
  const current = new Set(violations.map(key));
  return {
    added: violations.filter((v) => !allowed.has(key(v))),
    resolved: [...allowed.values()].filter((e) => !current.has(key(e)))
  };
}

export function metrics(modules) {
  const frontend = new Map([...modules].filter(([p]) => p.startsWith("src/") && layerOf(p) !== "tests"));
  const runtime = stronglyConnected(frontend, false);
  const production = [...modules.values()].filter((m) => !["tests", "tools", "other"].includes(m.layer));
  return {
    frontendModules: frontend.size,
    largestFrontendRuntimeCycle: runtime[0]?.length ?? 0,
    frontendRuntimeCycles: runtime.length,
    stateImporters: production.filter((m) => m.state.importsState).map((m) => m.path),
    stateAssigners: production.filter((m) => m.state.stateWrites > 0).map((m) => m.path),
    stateFieldWriters: production.filter((m) => m.state.stateFieldWrites > 0).map((m) => ({ path: m.path, writes: m.state.stateFieldWrites, reads: m.state.stateReads })),
    migratedModules: [...modules.values()].filter((m) => isMigrated(m.layer)).length
  };
}

export function loadSources(repo = REPO, files = listRepoFiles(repo)) {
  return files.filter(isAnalyzed).filter((p) => existsSync(join(repo, p))).map((path) => ({ path, text: readFileSync(join(repo, path), "utf8") }));
}

export function loadGraph(repo = REPO) {
  const files = listRepoFiles(repo).filter((p) => existsSync(join(repo, p)));
  return buildGraph(loadSources(repo, files), files);
}

function readBaseline(path) {
  if (!existsSync(path)) return { exceptions: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeBaseline(path, exceptions, previous) {
  const reasons = new Map((previous.exceptions ?? []).filter((e) => e.reason).map((e) => [key(e), e.reason]));
  const body = { exceptions: exceptions.map(({ rule, source, target }) => {
    const reason = reasons.get(key({ rule, source, target }));
    return reason ? { rule, source, target, reason } : { rule, source, target };
  }) };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
}

function describe(v) {
  return `${v.rule}: ${v.source}${v.line ? ":" + v.line : ""} -> ${v.target}${v.detail ? " (" + v.detail + ")" : ""}`;
}

export function run({ repo = REPO, baselinePath = BASELINE_PATH, mode = "check", print = console.log, printError = console.error } = {}) {
  const modules = loadGraph(repo);
  const violations = findViolations(modules);
  const cycles = migratedCycles(modules);
  const baseline = readBaseline(baselinePath);
  const m = metrics(modules);

  if (mode === "metrics") {
    print(JSON.stringify(m, null, 2));
    return 0;
  }
  if (mode === "init") {
    if (existsSync(baselinePath)) { printError(`dep-report: ${baselinePath} already exists; use --prune`); return 2; }
    writeBaseline(baselinePath, violations, baseline);
    print(`dep-report: wrote ${violations.length} exceptions`);
    return 0;
  }

  const { added, resolved } = compareBaseline(violations, baseline);
  print(`dep-report: ${modules.size} modules, ${m.frontendModules} frontend, largest frontend runtime cycle ${m.largestFrontendRuntimeCycle}, ${m.stateImporters.length} S importers, ${m.stateAssigners.length} S.state assigners, ${violations.length} known exceptions`);

  if (mode === "prune") {
    if (added.length) {
      for (const v of added) printError("  new " + describe(v));
      printError("dep-report: --prune only removes resolved exceptions; fix the new ones first");
      return 1;
    }
    writeBaseline(baselinePath, violations, baseline);
    print(`dep-report: removed ${resolved.length} resolved exceptions`);
    return 0;
  }

  let failed = false;
  for (const c of cycles) {
    failed = true;
    printError(`  cycle (${c.graph}) through migrated ${c.migrated.join(", ")}: ${c.modules.join(" -> ")}`);
  }
  for (const v of added) { failed = true; printError("  new " + describe(v)); }
  for (const e of resolved) { failed = true; printError(`  resolved ${e.rule}: ${e.source} -> ${e.target} (remove it from the baseline with --prune)`); }
  if (failed) {
    printError("dep-report: FAILED");
    return 1;
  }
  print("dep-report: OK");
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const flag = process.argv[2];
  const mode = { "--metrics": "metrics", "--init": "init", "--prune": "prune" }[flag] ?? (flag ? null : "check");
  if (mode === null) {
    console.error(`dep-report: unknown argument ${flag}; use --metrics, --prune or --init`);
    process.exitCode = 2;
  } else {
    process.exitCode = run({ mode });
  }
}
