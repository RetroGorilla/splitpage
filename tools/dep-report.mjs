import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, resolve } from "node:path";
import ts from "typescript";
import { REPO, isScript, listRepoFiles, parseScript } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";

export const BASELINE_PATH = join(REPO, "tools", "dep-baseline.json");
export const STATE_MODULE = "src/js/_state.js";
export const STATE_EXPORT = "S";

const EXCLUDED = [/^node_modules\//, /\/node_modules\//, /^\.claude\/handoff\//, /^index\.html$/];
const RESOLVE_SUFFIXES = ["", ".ts", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json", "/index.ts", "/index.js", "/index.mjs"];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, "")]));

export const MIGRATED_LAYERS = ["core", "contracts", "application", "adapters", "features", "bootstrap", "legacy"];
const NON_PRODUCTION = ["tests", "tools", "other"];

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
  "exports", "__dirname", "__filename", "globalThis", "self", "electron",
  "DOMParser", "XMLSerializer", "Node", "Element", "HTMLElement", "Text", "DocumentFragment",
  "Range", "Selection", "getSelection", "getComputedStyle",
  "MutationObserver", "ResizeObserver", "IntersectionObserver",
  "Event", "CustomEvent", "EventTarget", "KeyboardEvent", "MouseEvent",
  "CSS", "matchMedia", "alert", "confirm", "prompt", "open",
  "Option", "Audio", "HTMLCanvasElement", "OffscreenCanvas", "createImageBitmap", "structuredClone",
  "atob", "btoa", "postMessage", "addEventListener", "removeEventListener", "dispatchEvent"
]);

const COMMONJS_GLOBALS = new Set(["require", "module", "exports"]);

export const RICHTEXT_ADAPTER = "src/adapters/richtext/";
export const RICHTEXT_BRIDGE = "src/legacy/richtext.ts";
const HTML_PARSE_METHODS = new Set(["createContextualFragment", "parseHTMLUnsafe", "setHTMLUnsafe", "setHTML"]);
const XML_MIME_TYPES = new Set(["application/xml", "text/xml", "image/svg+xml", "application/xhtml+xml"]);

const CLOCK_FREE_DATE_MEMBERS = new Set(["parse", "UTC"]);

export const MUTATING_METHODS = new Set(["push", "pop", "splice", "shift", "unshift", "sort", "reverse", "fill", "copyWithin"]);

const ELEMENT_CALLBACKS = new Map([
  ...["forEach", "map", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "flatMap"].map((m) => [m, 0]),
  ["reduce", 1],
  ["reduceRight", 1]
]);

const OBJECT_MUTATORS = {
  Object: new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]),
  Reflect: new Set(["set", "deleteProperty", "defineProperty", "setPrototypeOf"])
};

const MAX_STATE_PATH = 6;

const TYPE_ONLY_KINDS = new Set(["type", "import-type"]);
const VALUE_AND_TYPE_KINDS = new Set(["class", "enum", "namespace", "import", "import-equals"]);

const BINDING_KINDS = new Set([
  "ImportDeclaration", "ExportDeclaration", "ImportEqualsDeclaration", "ImportType", "ExportAssignment", "VariableStatement",
  "VariableDeclarationList", "FunctionDeclaration", "FunctionExpression", "ArrowFunction", "MethodDeclaration", "Constructor",
  "GetAccessor", "SetAccessor", "CallSignature", "ConstructSignature", "MethodSignature", "IndexSignature", "FunctionType",
  "ConstructorType", "JSDocFunctionType", "ClassStaticBlockDeclaration", "ClassDeclaration", "ClassExpression", "PropertyDeclaration",
  "TypeParameter", "InterfaceDeclaration", "TypeAliasDeclaration", "EnumDeclaration", "ModuleDeclaration", "ModuleBlock",
  "ForOfStatement", "ForStatement", "ForInStatement", "Block", "CaseBlock", "MappedType", "ConditionalType", "CatchClause",
  "CallExpression"
].map((name) => ts.SyntaxKind[name]));

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
  if (path.startsWith("src/")) return "src-unknown";
  if (path.startsWith("shared/")) return "shared";
  if (path.startsWith("server/")) return "server";
  if (path.startsWith("desktop/")) return "desktop";
  if (path.startsWith("tools/")) return "tools";
  return "other";
}

export function isMigrated(layer) {
  return MIGRATED_LAYERS.includes(layer.split("/")[0]);
}

export function isProduction(layer) {
  return !NON_PRODUCTION.includes(layer);
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
      if (source.startsWith("features/")) return isCore(target) || target === "features/common" || ["application", "contracts", "shared"].includes(target);
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

function keyOf(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node))) return node.text;
  return "*";
}

function staticName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isComputedPropertyName(node)) {
    const key = keyOf(node.expression);
    return key === "*" ? null : key;
  }
  return null;
}

function isWrapper(node) {
  return ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node);
}

function unwrap(node) {
  while (isWrapper(node)) node = node.expression;
  return node;
}

function outermost(node) {
  while (node.parent && isWrapper(node.parent)) node = node.parent;
  return node;
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((m) => m.kind === kind));
}

const NAMED_DECLARATIONS = [
  ts.isPropertyAssignment, ts.isPropertyDeclaration, ts.isPropertySignature, ts.isMethodDeclaration, ts.isMethodSignature,
  ts.isGetAccessorDeclaration, ts.isSetAccessorDeclaration, ts.isEnumMember, ts.isEnumDeclaration, ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration, ts.isClassDeclaration, ts.isClassExpression, ts.isFunctionDeclaration, ts.isFunctionExpression,
  ts.isVariableDeclaration, ts.isParameter, ts.isTypeParameterDeclaration, ts.isModuleDeclaration, ts.isImportClause,
  ts.isNamespaceImport, ts.isNamespaceExport, ts.isImportEqualsDeclaration, ts.isNamedTupleMember, ts.isJsxAttribute,
  ts.isImportAttribute, ts.isNamespaceExportDeclaration
];

function isReference(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p)) return p.expression === node;
  if (ts.isQualifiedName(p)) return p.left === node;
  if (ts.isShorthandPropertyAssignment(p)) return true;
  if (ts.isBindingElement(p)) return p.initializer === node;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isMetaProperty(p) || ts.isTypePredicateNode(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) return false;
  if (p.name === node && NAMED_DECLARATIONS.some((is) => is(p))) return false;
  return true;
}

function clockOrRandomUse(node) {
  const name = node.text;
  if (name !== "Date" && name !== "Math") return null;
  const n = outermost(node);
  const p = n.parent;
  let member = null;
  if (ts.isPropertyAccessExpression(p) && p.expression === n) member = p.name.text;
  else if (ts.isElementAccessExpression(p) && p.expression === n) member = keyOf(p.argumentExpression);
  if (name === "Math") return member !== null && member !== "*" && member !== "random" ? null : "Math.random";
  if (member !== null) return CLOCK_FREE_DATE_MEMBERS.has(member) ? null : "Date";
  if (ts.isNewExpression(p) && p.expression === n) return (p.arguments ?? []).some((a) => !ts.isSpreadElement(a)) ? null : "Date";
  if (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return null;
  return "Date";
}

function htmlParseSink(call) {
  const callee = unwrap(call.expression);
  let name = null;
  if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
  else if (ts.isElementAccessExpression(callee)) name = literalText(callee.argumentExpression);
  if (name === null) return null;
  if (HTML_PARSE_METHODS.has(name)) return name;
  if (name !== "parseFromString") return null;
  const mime = literalText(call.arguments[1]);
  return mime !== null && XML_MIME_TYPES.has(mime) ? null : name;
}

export function ownsHtmlCells(path) {
  return path.startsWith(RICHTEXT_ADAPTER) || path === RICHTEXT_BRIDGE;
}

function dynamicCodeUse(node) {
  const name = node.text;
  if (name !== "eval" && name !== "Function") return null;
  const n = outermost(node);
  const p = n.parent;
  if (name === "Function" && ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return null;
  return name;
}

function referenceSpace(node) {
  const p = node.parent;
  if (ts.isTypeReferenceNode(p) && p.typeName === node) return "type";
  if ((ts.isQualifiedName(p) && p.left === node) || (ts.isTypeQueryNode(p) && p.exprName === node)) return "typeof";
  if (ts.isExpressionWithTypeArguments(p) && p.expression === node && ts.isHeritageClause(p.parent)
    && (p.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(p.parent.parent))) return "type";
  return "value";
}

function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isPatternTarget(literal) {
  if (!ts.isArrayLiteralExpression(literal) && !ts.isObjectLiteralExpression(literal)) return false;
  return writeKind(literal) !== null;
}

function writeKind(node) {
  const n = outermost(node);
  const p = n.parent;
  if (!p) return null;
  if (ts.isBinaryExpression(p) && p.left === n && isAssignmentOperator(p.operatorToken.kind)) return "assign";
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p))
    && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return "assign";
  if (ts.isDeleteExpression(p)) return "delete";
  if ((ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === n) return "assign";
  if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) {
    const literal = ts.isArrayLiteralExpression(p) ? p : p.parent;
    return isPatternTarget(literal) ? "assign" : null;
  }
  if (ts.isPropertyAssignment(p) && p.initializer === n) return isPatternTarget(p.parent) ? "assign" : null;
  if (ts.isShorthandPropertyAssignment(p) && p.name === n) return isPatternTarget(p.parent) ? "assign" : null;
  return null;
}

function chainOf(expr) {
  const path = [];
  let e = expr;
  for (;;) {
    if (isWrapper(e)) { e = e.expression; continue; }
    if (ts.isPropertyAccessExpression(e)) { path.unshift(e.name.text); e = e.expression; continue; }
    if (ts.isQualifiedName(e)) { path.unshift(e.right.text); e = e.left; continue; }
    if (ts.isElementAccessExpression(e)) { path.unshift(keyOf(e.argumentExpression)); e = e.expression; continue; }
    break;
  }
  return ts.isIdentifier(e) ? { root: e, path } : null;
}

function bindScopes(sf) {
  const refs = [];
  const refOf = new Map();
  const bindings = [];
  const elementOf = new Map();
  const loads = [];
  const reexports = [];
  const localExports = [];
  const ambient = [];
  const scopeOf = (parent, isFunction) => ({ parent, isFunction, values: new Map(), types: new Map() });
  const moduleScope = scopeOf(null, true);
  const functionScope = (s) => { while (!s.isFunction) s = s.parent; return s; };

  const declare = (s, id, kind, extra = {}) => {
    const spaces = TYPE_ONLY_KINDS.has(kind) ? [s.types] : VALUE_AND_TYPE_KINDS.has(kind) ? [s.values, s.types] : [s.values];
    const existing = spaces[0].get(id.text);
    if (existing) { existing.reassigned = true; return existing; }
    const b = { name: id.text, kind, reassigned: false, source: null, aliasInit: null, aliasPath: null, accesses: [], ...extra };
    for (const names of spaces) names.set(id.text, b);
    bindings.push(b);
    return b;
  };

  const loadOf = (init) => {
    let e = unwrap(init);
    let awaited = false;
    if (ts.isAwaitExpression(e)) { awaited = true; e = unwrap(e.expression); }
    if (!ts.isCallExpression(e)) return null;
    const spec = literalText(e.arguments[0]);
    if (spec === null) return null;
    if (e.expression.kind === ts.SyntaxKind.ImportKeyword && awaited) return { spec, call: e, requireCallee: null };
    if (ts.isIdentifier(e.expression) && e.expression.text === "require") return { spec, call: e, requireCallee: e.expression };
    return null;
  };

  const declarePattern = (name, target, kind, init, path, load, s, out) => {
    if (ts.isIdentifier(name)) {
      const b = declare(target, name, kind);
      if (path !== null && load) b.source = { spec: load.spec, via: path, node: load.call, requireCallee: load.requireCallee };
      else if (path !== null && init) { b.aliasInit = init; b.aliasPath = path; }
      out.push(b);
      return;
    }
    const isObject = ts.isObjectBindingPattern(name);
    name.elements.forEach((el, i) => {
      if (ts.isOmittedExpression(el)) return;
      let key = null;
      if (!el.dotDotDotToken) key = isObject ? staticName(el.propertyName ?? el.name) : String(i);
      if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) walk(el.propertyName.expression, s);
      if (el.initializer) walk(el.initializer, s);
      declarePattern(el.name, target, kind, init, path !== null && key !== null ? [...path, key] : null, load, s, out);
    });
  };

  const declareVariables = (list, s, element = null) => {
    const flags = list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using);
    const kind = flags === 0 ? "var" : flags === ts.NodeFlags.Let ? "let" : "const";
    const target = flags === 0 ? functionScope(s) : s;
    const out = [];
    for (const d of list.declarations) {
      const init = d.initializer ?? null;
      declarePattern(d.name, target, kind, init ?? element, init || !element ? [] : ["*"], init ? loadOf(init) : null, s, out);
      if (d.type) walk(d.type, s);
      if (init) walk(init, s);
    }
    return out;
  };

  const declareParameter = (p, fs, element) => {
    for (const m of p.modifiers ?? []) if (ts.isDecorator(m)) walk(m.expression, fs);
    declarePattern(p.name, fs, "param", element, element ? ["*"] : null, null, fs, []);
    if (p.type) walk(p.type, fs);
    if (p.initializer) walk(p.initializer, fs);
  };

  const recordLoad = (call, kind) => {
    const spec = literalText(call.arguments[0]);
    const requireCallee = kind === "require" ? call.expression : null;
    loads.push({ call, kind, spec, requireCallee });
  };

  const handleImport = (node, s) => {
    const spec = literalText(node.moduleSpecifier);
    const clause = node.importClause;
    if (!clause || spec === null) return;
    const source = (via) => ({ source: { spec, via, node, requireCallee: null } });
    const kind = (typeOnly) => (clause.isTypeOnly || typeOnly ? "import-type" : "import");
    if (clause.name) declare(s, clause.name, kind(false), source(["default"]));
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) declare(s, nb.name, kind(false), source([]));
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) declare(s, el.name, kind(el.isTypeOnly), source([(el.propertyName ?? el.name).text]));
    }
  };

  const handleExport = (node, s) => {
    const spec = node.moduleSpecifier ? literalText(node.moduleSpecifier) : null;
    if (spec !== null) {
      if (!node.exportClause) reexports.push({ star: true, spec, node });
      else if (ts.isNamespaceExport(node.exportClause)) reexports.push({ name: node.exportClause.name.text, spec, via: [], node });
      else {
        for (const el of node.exportClause.elements) reexports.push({ name: el.name.text, spec, via: [(el.propertyName ?? el.name).text], node });
      }
      return;
    }
    if (node.moduleSpecifier || !node.exportClause || !ts.isNamedExports(node.exportClause)) return;
    for (const el of node.exportClause.elements) {
      const local = el.propertyName ?? el.name;
      if (ts.isIdentifier(local)) localExports.push({ name: el.name.text, local, scope: s, node });
    }
  };

  const walkFunction = (node, s) => {
    for (const m of node.modifiers ?? []) if (ts.isDecorator(m)) walk(m.expression, s);
    if (node.name && ts.isComputedPropertyName(node.name)) walk(node.name.expression, s);
    if (ts.isFunctionDeclaration(node) && node.name) declare(s, node.name, "function");
    const fs = scopeOf(s, true);
    if (ts.isFunctionExpression(node) && node.name) declare(fs, node.name, "function");
    for (const tp of node.typeParameters ?? []) walk(tp, fs);
    const element = elementOf.get(node);
    (node.parameters ?? []).forEach((p, i) => declareParameter(p, fs, element && element.index === i ? element.init : null));
    if (node.type) walk(node.type, fs);
    const body = node.body;
    if (!body) return;
    const bs = scopeOf(fs, true);
    if (ts.isBlock(body)) for (const st of body.statements) walk(st, bs);
    else walk(body, bs);
  };

  const walkClass = (node, s) => {
    for (const m of node.modifiers ?? []) if (ts.isDecorator(m)) walk(m.expression, s);
    if (ts.isClassDeclaration(node) && node.name) declare(s, node.name, "class");
    const cs = scopeOf(s, false);
    if (ts.isClassExpression(node) && node.name) declare(cs, node.name, "class");
    for (const tp of node.typeParameters ?? []) walk(tp, cs);
    for (const h of node.heritageClauses ?? []) walk(h, cs);
    for (const m of node.members) walk(m, cs);
  };

  const ambientNames = (name) => (ts.isIdentifier(name) ? [name] : name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : ambientNames(el.name))));

  const collectAmbient = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) ambient.push(...ambientNames(d.name));
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      ambient.push(node.name);
    } else if (ts.isModuleDeclaration(node)) {
      if (node.flags & ts.NodeFlags.GlobalAugmentation) {
        if (node.body && ts.isModuleBlock(node.body)) for (const st of node.body.statements) collectAmbient(st);
      } else ambient.push(node.name);
    }
  };

  const children = (node, s) => ts.forEachChild(node, (c) => { walk(c, s); });

  function walk(node, s) {
    if (ts.isIdentifier(node)) {
      if (isReference(node)) {
        const r = { node, scope: s, space: referenceSpace(node), binding: null };
        refs.push(r);
        refOf.set(node, r);
      }
      return;
    }
    if (!BINDING_KINDS.has(node.kind)) { children(node, s); return; }
    if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) { collectAmbient(node); return; }
    if (ts.isImportDeclaration(node)) { handleImport(node, s); return; }
    if (ts.isExportDeclaration(node)) { handleExport(node, s); return; }
    if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      const spec = ts.isExternalModuleReference(ref) ? literalText(ref.expression) : null;
      declare(s, node.name, node.isTypeOnly ? "import-type" : "import-equals",
        ts.isExternalModuleReference(ref)
          ? spec === null ? {} : { source: { spec, via: [], node, requireCallee: null } }
          : { aliasInit: ref, aliasPath: [] });
      if (!ts.isExternalModuleReference(ref)) walk(ref, s);
      return;
    }
    if (ts.isImportTypeNode(node)) { for (const t of node.typeArguments ?? []) walk(t, s); return; }
    if (ts.isExportAssignment(node)) {
      walk(node.expression, s);
      if (!node.isExportEquals) localExports.push({ name: "default", expression: node.expression, scope: s, node });
      return;
    }
    if (ts.isVariableStatement(node)) {
      const declared = declareVariables(node.declarationList, s);
      if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) for (const b of declared) localExports.push({ name: b.name, binding: b, scope: s, node });
      return;
    }
    if (ts.isVariableDeclarationList(node)) { declareVariables(node, s); return; }
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) { walkFunction(node, s); return; }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) { walkClass(node, s); return; }
    if (ts.isTypeParameterDeclaration(node)) { declare(s, node.name, "type"); children(node, s); return; }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      declare(s, node.name, ts.isEnumDeclaration(node) ? "enum" : "type");
      children(node, scopeOf(s, false));
      return;
    }
    if (ts.isModuleDeclaration(node)) {
      if (ts.isIdentifier(node.name)) declare(s, node.name, "namespace");
      if (node.body) walk(node.body, s);
      return;
    }
    if (ts.isModuleBlock(node)) { children(node, scopeOf(s, true)); return; }
    if (ts.isForOfStatement(node)) {
      const ls = scopeOf(s, false);
      if (ts.isVariableDeclarationList(node.initializer)) declareVariables(node.initializer, ls, node.expression);
      else walk(node.initializer, ls);
      walk(node.expression, ls);
      walk(node.statement, ls);
      return;
    }
    if (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isForStatement(node) || ts.isForInStatement(node)
      || ts.isMappedTypeNode(node) || ts.isConditionalTypeNode(node)) {
      children(node, scopeOf(s, false));
      return;
    }
    if (ts.isCatchClause(node)) {
      const cs = scopeOf(s, false);
      if (node.variableDeclaration) declarePattern(node.variableDeclaration.name, cs, "let", null, null, null, cs, []);
      walk(node.block, cs);
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const fn = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) recordLoad(node, "dynamic-import");
      else if (ts.isIdentifier(callee) && callee.text === "require") recordLoad(node, "require");
      else if (ts.isPropertyAccessExpression(callee) && ELEMENT_CALLBACKS.has(callee.name.text) && fn && (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn))) {
        elementOf.set(fn, { init: callee.expression, index: ELEMENT_CALLBACKS.get(callee.name.text) });
      }
    }
    children(node, s);
  }

  walk(sf, moduleScope);

  const lookup = (s, name, space = "typeof") => {
    for (let c = s; c; c = c.parent) {
      const b = (space === "type" ? c.types : c.values).get(name);
      if (b) return b;
      const typeImport = space === "typeof" ? c.types.get(name) : null;
      if (typeImport?.kind === "import-type") return typeImport;
    }
    return null;
  };
  for (const r of refs) {
    r.binding = lookup(r.scope, r.node.text, r.space);
    if (r.binding && writeKind(r.node) === "assign") r.binding.reassigned = true;
  }
  const isFree = (identifier) => !refOf.get(identifier)?.binding;
  return { refs, refOf, bindings, loads, reexports, localExports, ambient, lookup, isFree };
}

function accessAt(identifier, isFree) {
  const path = [];
  let n = identifier;
  for (;;) {
    const p = n.parent;
    if (isWrapper(p)) { n = p; continue; }
    if (ts.isPropertyAccessExpression(p) && p.expression === n) { path.push(p.name.text); n = p; continue; }
    if (ts.isQualifiedName(p) && p.left === n) { path.push(p.right.text); n = p; continue; }
    if (ts.isElementAccessExpression(p) && p.expression === n) { path.push(keyOf(p.argumentExpression)); n = p; continue; }
    break;
  }
  if (writeKind(n)) return { path, write: "set", node: n };
  const p = n.parent;
  if (ts.isCallExpression(p) && p.expression === n && path.length && MUTATING_METHODS.has(path[path.length - 1])) {
    return { path: path.slice(0, -1), write: "mutate", node: n };
  }
  if (ts.isCallExpression(p) && p.arguments[0] === n && ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression)) {
    const owner = p.expression.expression;
    if (OBJECT_MUTATORS[owner.text]?.has(p.expression.name.text) && isFree(owner)) return { path, write: "mutate", node: n };
  }
  return { path, write: null, node: n };
}

function loadedNames(call, kind) {
  let n = outermost(call);
  const awaited = ts.isAwaitExpression(n.parent);
  if (kind === "dynamic-import" && !awaited) return null;
  if (awaited) n = outermost(n.parent);
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === n) return [p.name.text];
  if (ts.isElementAccessExpression(p) && p.expression === n) {
    const name = literalText(p.argumentExpression);
    return name === null ? null : [name];
  }
  if (!ts.isVariableDeclaration(p) || p.initializer !== n || !ts.isObjectBindingPattern(p.name)) return null;
  const names = [];
  for (const el of p.name.elements) {
    const name = el.dotDotDotToken ? null : staticName(el.propertyName ?? el.name);
    if (name === null) return null;
    names.push(name);
  }
  return names;
}

export function analyzeScript(path, text) {
  const sf = parseScript(path, text);
  const commonjs = /\.c[jt]s$/.test(path) || sf.statements.some((s) => ts.isExpressionStatement(s) && literalText(s.expression) === "use strict");
  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const scopes = bindScopes(sf);
  const { refs, refOf, isFree } = scopes;

  const loadsByCall = new Map(scopes.loads.map((l) => [l.call, l]));
  const liveLoad = (l) => l.kind !== "require" || isFree(l.requireCallee);
  const imports = [];
  const unresolved = [];
  const htmlParses = new Map();
  const visitEdges = (node) => {
    if (ts.isCallExpression(node)) {
      const sink = htmlParseSink(node);
      if (sink !== null && (!htmlParses.has(sink) || htmlParses.get(sink) > at(node))) htmlParses.set(sink, at(node));
    }
    if (ts.isImportDeclaration(node)) {
      const spec = literalText(node.moduleSpecifier);
      const clause = node.importClause;
      const names = [];
      if (clause?.name) names.push("default");
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.push("*");
        else for (const el of clause.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
      }
      if (spec !== null) imports.push({ spec, names, typeOnly: Boolean(clause?.isTypeOnly), kind: "import", line: at(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literalText(node.moduleReference.expression);
      if (spec !== null) imports.push({ spec, names: [node.name.text], typeOnly: node.isTypeOnly, kind: "import-equals", line: at(node) });
      else unresolved.push({ kind: "import-equals", expression: node.getText(sf).replace(/\s+/g, " "), line: at(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = literalText(node.moduleSpecifier);
      const names = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((el) => (el.propertyName ?? el.name).text) : ["*"];
      if (spec !== null) imports.push({ spec, names, typeOnly: node.isTypeOnly, kind: "re-export", line: at(node) });
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      const spec = ts.isLiteralTypeNode(arg) ? literalText(arg.literal) : null;
      if (spec !== null) imports.push({ spec, typeOnly: true, kind: "type-import", line: at(node) });
    } else if (ts.isCallExpression(node) && loadsByCall.has(node)) {
      const l = loadsByCall.get(node);
      if (liveLoad(l)) {
        if (l.spec !== null) imports.push({ spec: l.spec, names: loadedNames(node, l.kind), typeOnly: false, kind: l.kind, line: at(node) });
        else unresolved.push({ kind: l.kind, expression: node.getText(sf).replace(/\s+/g, " "), line: at(node) });
      }
    }
    ts.forEachChild(node, visitEdges);
  };
  visitEdges(sf);

  const globals = new Map();
  for (const r of refs) {
    if (r.binding) continue;
    const text = r.node.text;
    const name = PLATFORM_GLOBALS.has(text) ? text : r.space === "value" ? dynamicCodeUse(r.node) ?? clockOrRandomUse(r.node) : null;
    if (!name || (commonjs && COMMONJS_GLOBALS.has(name))) continue;
    const line = at(r.node);
    if (!globals.has(name) || globals.get(name) > line) globals.set(name, line);
  }

  const ambients = new Map();
  const noteAmbient = (name, line) => {
    if (!ambients.has(name) || ambients.get(name) > line) ambients.set(name, line);
  };
  for (const id of scopes.ambient) noteAmbient(ts.isStringLiteral(id) ? `"${id.text}"` : id.text, at(id));
  const directives = [["lib", sf.libReferenceDirectives], ["types", sf.typeReferenceDirectives], ["path", sf.referencedFiles]];
  for (const [kind, list] of directives) {
    for (const d of list) noteAmbient(`reference ${kind}="${d.fileName}"`, sf.getLineAndCharacterOfPosition(d.pos).line + 1);
  }

  const memo = new Map();
  const targetOf = (b, seen) => {
    if (memo.has(b)) return memo.get(b);
    let t = null;
    if (b.source) {
      if (!b.source.requireCallee || isFree(b.source.requireCallee)) t = { root: b, path: [] };
    } else if (b.aliasInit && !b.reassigned && !seen.has(b)) {
      seen.add(b);
      const chain = chainOf(b.aliasInit);
      const inner = chain ? refOf.get(chain.root)?.binding : null;
      const it = inner ? targetOf(inner, seen) : null;
      if (it) t = { root: it.root, path: [...it.path, ...chain.path, ...b.aliasPath] };
    }
    memo.set(b, t);
    return t;
  };

  for (const r of refs) {
    if (!r.binding) continue;
    const t = targetOf(r.binding, new Set());
    if (!t) continue;
    const access = accessAt(r.node, isFree);
    t.root.accesses.push({ path: [...t.path, ...access.path], write: access.write, line: access.write ? at(access.node) : 0 });
  }

  const sources = [];
  const boundCalls = new Set();
  for (const b of scopes.bindings) {
    if (!b.source || (b.source.requireCallee && !isFree(b.source.requireCallee))) continue;
    if (ts.isCallExpression(b.source.node)) boundCalls.add(b.source.node);
    sources.push({ spec: b.source.spec, via: b.source.via, line: at(b.source.node), accesses: b.accesses });
  }

  const loads = scopes.loads
    .filter((l) => l.spec !== null && liveLoad(l) && !boundCalls.has(l.call))
    .map((l) => ({ spec: l.spec, line: at(l.call) }));

  const exportsOut = scopes.reexports.map((e) => (e.star ? { star: true, spec: e.spec, line: at(e.node) } : { name: e.name, spec: e.spec, via: e.via, line: at(e.node) }));
  for (const e of scopes.localExports) {
    let binding = e.binding ?? null;
    let extra = [];
    if (e.local) binding = scopes.lookup(e.scope, e.local.text);
    if (e.expression) {
      const chain = chainOf(e.expression);
      binding = chain ? refOf.get(chain.root)?.binding ?? null : null;
      extra = chain ? chain.path : [];
    }
    const t = binding ? targetOf(binding, new Set()) : null;
    if (!t) continue;
    exportsOut.push({ name: e.name, spec: t.root.source.spec, via: [...t.root.source.via, ...t.path, ...extra], line: at(e.node) });
  }

  return { imports, unresolved, htmlParses: [...htmlParses].map(([name, line]) => ({ name, line })), globals: [...globals].map(([name, line]) => ({ name, line })), ambients: [...ambients].map(([name, line]) => ({ name, line })), sources, loads, exports: exportsOut };
}

export function isAnalyzed(path) {
  return isScript(path) && !EXCLUDED.some((re) => re.test(path)) && !/(^|\/)(eslint\.config|vitest\.config)\.[cm]?js$/.test(path);
}

function prefixOf(a, b) {
  return a.length <= b.length && a.every((k, i) => k === b[i] || k === "*" || b[i] === "*");
}

function stateProviders(modules) {
  const provides = new Map();
  const truncated = new Set();
  const add = (path, entry) => {
    if (entry.path.length > MAX_STATE_PATH || entry.sub.length > MAX_STATE_PATH) { truncated.add(path); return false; }
    const list = provides.get(path) ?? [];
    const k = JSON.stringify(entry);
    if (list.some((e) => JSON.stringify(e) === k)) return false;
    list.push(entry);
    provides.set(path, list);
    return true;
  };
  if (modules.has(STATE_MODULE)) add(STATE_MODULE, { path: [STATE_EXPORT], sub: [] });
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of modules.values()) {
      for (const e of m.stateLinks.exports) {
        const from = e.target ? provides.get(e.target) : null;
        if (!from) continue;
        for (const q of [...from]) {
          let entry = null;
          if (e.star) { if (q.path[0] !== "default") entry = q; }
          else if (prefixOf(q.path, e.via)) entry = { path: [e.name], sub: [...q.sub, ...e.via.slice(q.path.length)] };
          else if (prefixOf(e.via, q.path)) entry = { path: [e.name, ...q.path.slice(e.via.length)], sub: q.sub };
          if (entry && add(m.path, entry)) changed = true;
        }
      }
    }
  }
  return { provides, truncated };
}

function stateUsage(m, provides, truncated) {
  const usage = { importsState: false, bridge: false, truncated: truncated.has(m.path), line: null, reads: 0, writes: [] };
  if (m.path === STATE_MODULE) return usage;
  const seen = (line) => { usage.importsState = true; usage.line = usage.line === null ? line : Math.min(usage.line, line); };
  if (provides.has(m.path)) {
    usage.bridge = true;
    for (const e of m.stateLinks.exports) if (e.target && provides.has(e.target)) seen(e.line);
  }
  for (const s of m.stateLinks.sources) {
    const from = s.target ? provides.get(s.target) : null;
    const matches = (from ?? []).filter((q) => prefixOf(q.path, s.via) || prefixOf(s.via, q.path));
    if (!matches.length) continue;
    seen(s.line);
    for (const a of s.accesses) {
      const full = [...s.via, ...a.path];
      const q = matches.find((c) => prefixOf(c.path, full));
      if (!q) { if (matches.some((c) => prefixOf(full, c.path))) usage.reads++; continue; }
      const spath = [...q.sub, ...full.slice(q.path.length)];
      if (a.write) usage.writes.push({ spath, write: a.write, line: a.line });
      else usage.reads++;
    }
  }
  for (const l of m.stateLinks.loads) if (l.target && provides.has(l.target)) seen(l.line);
  usage.writes.sort((a, b) => a.line - b.line);
  return usage;
}

export function stateWriteTarget(spath, write) {
  if (spath.length === 0) return write === "mutate" ? `global:${STATE_EXPORT}.*` : null;
  const member = spath[0] === "*" ? `${STATE_EXPORT}[?]` : `${STATE_EXPORT}.${spath[0]}`;
  return `global:${member}${write === "mutate" || spath.length > 1 ? ".*" : ""}`;
}

function stateWriteDetail(target) {
  const name = target.slice("global:".length);
  if (name === `${STATE_EXPORT}.*`) return `changes members of ${STATE_EXPORT} in place`;
  return name.endsWith(".*") ? `changes ${name.slice(0, -2)} in place` : `replaces ${name}`;
}

export function buildGraph(sources, allFiles = sources.map((s) => s.path)) {
  const fileSet = new Set([...allFiles, ...sources.map((s) => s.path)]);
  const modules = new Map();
  for (const { path, text } of sources) {
    const analysis = analyzeScript(path, text);
    const fileTarget = (spec) => {
      const r = resolveSpecifier(path, spec, fileSet);
      return r.kind === "file" ? r.target : null;
    };
    const edges = analysis.imports.map((i) => ({ ...i, ...resolveSpecifier(path, i.spec, fileSet) }));
    const stateLinks = {
      sources: analysis.sources.map((s) => ({ ...s, target: fileTarget(s.spec) })),
      loads: analysis.loads.map((l) => ({ ...l, target: fileTarget(l.spec) })),
      exports: analysis.exports.map((e) => ({ ...e, target: fileTarget(e.spec) }))
    };
    modules.set(path, { path, text, layer: layerOf(path), edges, unresolved: analysis.unresolved, htmlParses: analysis.htmlParses, globals: analysis.globals, ambients: analysis.ambients, stateLinks });
  }
  const { provides, truncated } = stateProviders(modules);
  for (const m of modules.values()) {
    m.state = stateUsage(m, provides, truncated);
    m.stateProviders = new Map(m.edges.filter((e) => e.kind === "file" && provides.has(e.target))
      .map((e) => [e.spec, provides.get(e.target)]));
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
  for (const start of [...modules.keys()].sort(byCodePoint)) {
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
        if (component.length > 1 || selfLoop) components.push(component.sort(byCodePoint));
      }
    }
  }
  return components.sort((a, b) => b.length - a.length || byCodePoint(a[0], b[0]));
}

function key(v) {
  return `${v.rule}\u0000${v.source}\u0000${v.target}`;
}

export function byCodePoint(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function compareExceptions(a, b) {
  return byCodePoint(a.rule, b.rule) || byCodePoint(a.source, b.source) || byCodePoint(a.target, b.target);
}

export function cycleEdges(modules) {
  const component = new Map();
  for (const c of stronglyConnected(modules, false)) for (const p of c) component.set(p, c);
  const out = new Map();
  for (const m of modules.values()) {
    const c = component.get(m.path);
    if (!c) continue;
    for (const e of m.edges) {
      const pair = `${m.path}\u0000${e.target}`;
      if (e.kind === "file" && !e.typeOnly && component.get(e.target) === c && !out.has(pair)) out.set(pair, { source: m.path, target: e.target, line: e.line, size: c.length });
    }
  }
  return [...out.values()];
}

export function findViolations(modules) {
  const found = new Map();
  const add = (rule, source, target, line, detail) => {
    const v = { rule, source, target };
    if (!found.has(key(v))) found.set(key(v), { ...v, line, detail });
  };
  for (const m of modules.values()) {
    if (m.layer === "src-unknown") {
      const folder = m.path.split("/").length > 2 ? m.path.split("/").slice(0, 2).join("/") + "/" : "src/";
      add("unknown-layer", m.path, folder, null, `${folder} is not a folder in the layer table`);
    }
    for (const e of m.edges) {
      if (e.kind === "file") {
        const targetLayer = layerOf(e.target);
        if (m.layer === "bootstrap" && e.target === STATE_MODULE) add("layer", m.path, e.target, e.line, `bootstrap may not import ${STATE_MODULE}`);
        else if (!layerAllows(m.layer, targetLayer)) add("layer", m.path, e.target, e.line, `${m.layer} may not import ${targetLayer}`);
      } else if (e.kind === "builtin" || e.kind === "package") {
        if (!platformImportAllowed(m.layer)) add("platform-import", m.path, e.target, e.line, `${m.layer} may not import ${e.target}`);
      } else if (e.kind === "missing") {
        add("missing-module", m.path, e.target, e.line, `${e.spec} does not resolve to a file`);
      }
    }
    for (const u of m.unresolved) add("unresolved-dynamic", m.path, u.expression, u.line, `${u.kind} with a computed specifier`);
    if (platformGlobalsBanned(m.layer)) {
      for (const g of m.globals) add("platform-global", m.path, `global:${g.name}`, g.line, `${m.layer} may not use ${g.name}`);
      for (const a of m.ambients) add("platform-global", m.path, `ambient:${a.name}`, a.line, `${m.layer} may not declare an ambient ${a.name}`);
    }
    if (isProduction(m.layer) && !ownsHtmlCells(m.path)) {
      for (const e of m.edges) {
        if (e.kind === "file" && !e.typeOnly && e.target.startsWith(RICHTEXT_ADAPTER)) {
          add("html-cells", m.path, e.target, e.line, `reaches the HTML decoder; only ${RICHTEXT_BRIDGE} may import ${RICHTEXT_ADAPTER}`);
        }
      }
      for (const p of m.htmlParses) add("html-cells", m.path, `html-parse:${p.name}`, p.line, `parses HTML with ${p.name}; only ${RICHTEXT_ADAPTER} builds cells from HTML`);
    }
    if (isProduction(m.layer)) {
      if (m.state.importsState) add("state-import", m.path, `global:${STATE_EXPORT}`, m.state.line, m.state.bridge ? `re-exports ${STATE_EXPORT}` : `imports ${STATE_EXPORT}`);
      for (const w of m.state.writes) {
        const target = stateWriteTarget(w.spath, w.write);
        if (target) add("state-write", m.path, target, w.line, stateWriteDetail(target));
      }
    }
    if (m.state.truncated) {
      add("state-bridge-limit", m.path, `global:${STATE_EXPORT}`, null, `re-exports ${STATE_EXPORT} through more than ${MAX_STATE_PATH} names; the report stops following it here`);
    }
  }
  for (const e of cycleEdges(modules)) add("cycle-edge", e.source, e.target, e.line, `runtime import inside a ${e.size}-module cycle`);
  return [...found.values()].sort(compareExceptions);
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
    added: violations.filter((v) => !allowed.has(key(v)) || (v.count !== undefined && v.count > (allowed.get(key(v)).count ?? 0))),
    resolved: [...allowed.values()].filter((e) => !current.has(key(e)) || (e.count !== undefined && violations.some((v) => key(v) === key(e) && v.count < e.count)))
  };
}

export function isNumbered(path) {
  return /^src\/js\/[0-9][^/]*$/.test(path) && isScript(path);
}

function legacyStateNodes(sf, providers) {
  const nodes = new Map();
  const unresolved = [];
  const ignored = new Set();
  const scopes = bindScopes(sf);
  const position = (node) => (ts.isPropertyAccessExpression(node) ? node.name : ts.isQualifiedName(node) ? node.right : node).getStart(sf);
  const add = (node, prefix = [], resolved = false) => nodes.set(position(node), { node, prefix, resolved });
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === STATE_EXPORT && isReference(node)
      || ts.isPropertyAccessExpression(node) && node.name.text === STATE_EXPORT) {
      const chain = chainOf(node);
      if (chain && scopes.refOf.get(chain.root)?.binding) ignored.add(position(node));
      else add(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const sourceOf = (binding, seen = new Set()) => {
    if (!binding || seen.has(binding)) return null;
    if (binding.source) return binding.source;
    if (binding.kind !== "import-equals" || !binding.aliasInit) return null;
    seen.add(binding);
    const chain = chainOf(binding.aliasInit);
    const source = chain ? sourceOf(scopes.refOf.get(chain.root)?.binding, seen) : null;
    return source ? { ...source, via: [...source.via, ...chain.path] } : null;
  };
  for (const r of scopes.refs) {
    const source = sourceOf(r.binding);
    if (!source || source.requireCallee && !scopes.isFree(source.requireCallee)) continue;
    const from = providers ? providers.get(source.spec) ?? [] : [{ path: [STATE_EXPORT], sub: [] }];
    for (const q of from) {
      if (!prefixOf(source.via, q.path) && !prefixOf(q.path, source.via)) continue;
      let node = r.node;
      let unknown = false;
      let matches = true;
      for (const name of q.path.slice(source.via.length)) {
        const n = outermost(node);
        const p = n.parent;
        const member = ts.isPropertyAccessExpression(p) && p.expression === n ? p.name.text
          : ts.isQualifiedName(p) && p.left === n ? p.right.text
          : ts.isElementAccessExpression(p) && p.expression === n ? literalText(p.argumentExpression) : null;
        if (ts.isImportEqualsDeclaration(p) && p.moduleReference === n) { matches = false; break; }
        if (member === null || name === "*") { unknown = true; break; }
        if (member !== name) { matches = false; break; }
        node = p;
      }
      if (unknown) {
        unresolved.push({ line: sf.getLineAndCharacterOfPosition(r.node.getStart(sf)).line + 1,
          detail: `state import ${r.binding.name} from ${source.spec} cannot be resolved statically; use an explicit named import or static namespace member` });
      } else if (matches) add(node, [...q.sub, ...source.via.slice(q.path.length)], true);
    }
  }
  return { nodes, unresolved, ignored };
}

export function legacyMeasurements(text, path = "legacy.js", providers) {
  const lines = text.split("\n");
  const directWrite = /\bS\.state(\.[A-Za-z_]+|\[[^\]]+\])*\s*(=[^=]|\+=|-=)|\bS\.state\.[a-zA-Z_]+\.(push|splice|pop|shift|unshift|sort)\(/;
  const sf = parseScript(path, text);
  const references = new Set([...text.matchAll(/\bS\.[A-Za-z_]+/g)].map((match) => match.index));
  const { nodes, ignored } = legacyStateNodes(sf, providers);
  for (const start of ignored) references.delete(start);
  for (const { node, prefix, resolved } of nodes.values()) {
    const n = outermost(node);
    const p = n.parent;
    const access = (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n;
    const alias = (resolved || ts.isIdentifier(node)) && (ts.isVariableDeclaration(p) && p.initializer === n
      || ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n
      || ts.isImportEqualsDeclaration(p) && p.moduleReference === n);
    if (access || alias || prefix.length) references.add((ts.isPropertyAccessExpression(node) ? node.name : ts.isQualifiedName(node) ? node.right : node).getStart(sf));
  }
  return {
    references: references.size,
    directWrites: lines.filter((line) => directWrite.test(line)).length,
    lines: lines.length - 1
  };
}

function legacyWriteCount(path, text, providers) {
  const sf = parseScript(path, text);
  const methods = new Set(["push", "splice", "pop", "shift", "unshift", "sort"]);
  let count = 0;
  const { nodes, unresolved } = legacyStateNodes(sf, providers);
  for (const { node, prefix } of nodes.values()) {
    const access = accessAt(node, () => false);
    if ([...prefix, ...access.path][0] === "state" && (access.write === "set"
      || access.write === "mutate" && methods.has(chainOf(access.node)?.path.at(-1)))) count++;
  }
  return { count, unresolved };
}

export function legacyViolations(modules) {
  const out = [];
  for (const m of modules.values()) {
    if (!m.path.startsWith("src/")) continue;
    const counts = legacyMeasurements(m.text, m.path, m.stateProviders);
    const { count: directWrites, unresolved } = legacyWriteCount(m.path, m.text, m.stateProviders);
    for (const l of m.stateLinks.loads) {
      if (m.stateProviders.has(l.spec)) unresolved.push({ line: l.line,
        detail: `state import from ${l.spec} cannot be resolved statically; use an explicit named import or static namespace member` });
    }
    for (const u of unresolved) out.push({ rule: "state-import", source: m.path, target: "global:S", ...u, unknownNames: true });
    if (isNumbered(m.path)) out.push({ rule: "legacy-file", source: m.path, target: "src/js" });
    if (counts.references) out.push({ rule: "legacy-state-refs", source: m.path, target: "global:S", count: counts.references });
    if (directWrites) out.push({ rule: "state-write", source: m.path, target: "direct:S.state", count: directWrites });
    if (!isNumbered(m.path)) continue;
    for (const e of m.edges) {
      if (e.kind !== "file" || !isNumbered(e.target)) continue;
      for (const name of e.names?.length ? e.names : ["*"]) {
        out.push({ rule: "loop-import", source: m.path, target: `${e.target}#${name}`, line: e.line,
          ...(e.names === null ? { detail: `${e.kind} imported names cannot be determined statically; use explicit named destructuring`, unknownNames: true } : {}) });
      }
    }
  }
  const unique = new Map();
  for (const v of out) if (!unique.has(key(v)) || v.unknownNames) unique.set(key(v), v);
  return [...unique.values()].sort(compareExceptions);
}

export function legacyMetrics(modules) {
  const app = new Map([...modules].filter(([p]) => p.startsWith("src/") && layerOf(p) !== "tests"));
  const tests = [...modules.values()].filter((m) => m.path.startsWith("src/test/"));
  const numbered = [...app.values()].filter((m) => isNumbered(m.path));
  const total = (items, field) => items.reduce((sum, m) => sum + legacyMeasurements(m.text, m.path, m.stateProviders)[field], 0);
  const state = modules.get(STATE_MODULE);
  let stateFields = 0;
  if (state) {
    const sf = parseScript(state.path, state.text);
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === STATE_EXPORT && d.initializer && ts.isObjectLiteralExpression(d.initializer)) stateFields = d.initializer.properties.length;
      }
    }
  }
  return {
    loopModules: stronglyConnected(app, false).flat().length,
    loopLinks: cycleEdges(app).length,
    stateModules: state ? 1 : 0,
    stateFields,
    stateReferences: total([...app.values()], "references"),
    testStateReferences: total(tests, "references"),
    stateImporters: [...app.values()].filter((m) => m.state.importsState).length,
    testStateImporters: tests.filter((m) => m.state.importsState).length,
    stateAssigners: metrics(app).stateAssigners.length,
    directWriteLines: total([...app.values()], "directWrites"),
    numberedFiles: numbered.length,
    numberedLines: total(numbered, "lines")
  };
}

export function assertLegacyMetrics(actual, thresholds) {
  if (!thresholds || Array.isArray(thresholds) || typeof thresholds !== "object" || !Object.keys(thresholds).length) throw new Error("legacy thresholds must be a non-empty object of upper bounds");
  const failures = [];
  for (const [name, limit] of Object.entries(thresholds)) {
    if (!Object.hasOwn(actual, name) || !Number.isFinite(limit) || limit < 0) throw new Error(`invalid legacy threshold: ${name}`);
    if (actual[name] > limit) failures.push(`${name}: ${actual[name]} exceeds ${limit}`);
  }
  return failures;
}

export function loopModel(modules, steps) {
  const kindsAllowed = ["rule", "page-helper", "value", "changing", "stateful", "calls-loop"];
  if (!Array.isArray(steps) || steps.some((s) => !s || typeof s.label !== "string"
    || ["kinds", "names", "exceptNames"].some((k) => s[k] !== undefined && (!Array.isArray(s[k]) || s[k].some((v) => typeof v !== "string")))
    || s.kinds?.some((k) => !kindsAllowed.includes(k)))) throw new Error("invalid loop steps: expected labels with kinds, exceptNames and names arrays");
  const frontend = new Map([...modules].filter(([p]) => p.startsWith("src/") && layerOf(p) !== "tests"));
  const loop = new Set(stronglyConnected(frontend, false).flat());
  const files = new Map();
  const pageGlobals = new Set(["window", "document", "navigator", "location", "history", "localStorage", "sessionStorage", "indexedDB", "caches", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "BroadcastChannel", "Worker", "AbortController", "URL", "TextDecoder", "TextEncoder", "Blob", "File", "FileReader", "Image", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "queueMicrotask", "performance", "crypto", "getComputedStyle", "HTMLElement", "Node", "Element"]);
  const parse = (path) => {
    if (files.has(path)) return files.get(path);
    const sf = parseScript(path, modules.get(path).text);
    const imported = new Map(), fns = new Map(), vars = new Set(), assigned = new Set(), exported = new Map();
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) {
        const target = modules.get(path).edges.find((e) => e.spec === literalText(st.moduleSpecifier))?.target;
        const b = st.importClause?.namedBindings;
        if (b && ts.isNamedImports(b)) for (const el of b.elements) imported.set(el.name.text, target);
        if (b && ts.isNamespaceImport(b)) imported.set(b.name.text, target);
        if (st.importClause?.name) imported.set(st.importClause.name.text, target);
      }
      const isExport = hasModifier(st, ts.SyntaxKind.ExportKeyword);
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
        fns.set(st.name.text, st);
        if (isExport) exported.set(st.name.text, st.name.text);
      }
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (d.initializer && (ts.isFunctionExpression(d.initializer) || ts.isArrowFunction(d.initializer))) fns.set(d.name.text, d.initializer);
        else vars.add(d.name.text);
        if (isExport) exported.set(d.name.text, d.name.text);
      }
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) exported.set(el.name.text, st.moduleSpecifier ? null : (el.propertyName ?? el.name).text);
      }
    }
    const walk = (n) => {
      if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind) && ts.isIdentifier(n.left)) assigned.add(n.left.text);
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator) && ts.isIdentifier(n.operand)) assigned.add(n.operand.text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    const result = { imported, fns, vars, assigned, exported };
    files.set(path, result);
    return result;
  };
  const profile = (path, name, seen) => {
    const f = parse(path), node = f.fns.get(name), p = { state: false, page: false, loop: false };
    const id = `${path}#${name}`;
    if (!node || seen.has(id)) return p;
    seen.add(id);
    const walk = (n) => {
      if (ts.isIdentifier(n)) {
        const nameHere = n.text, target = f.imported.get(nameHere);
        if (f.vars.has(nameHere) || (nameHere === "S" && target)) p.state = true;
        if (pageGlobals.has(nameHere)) p.page = true;
        if (target && nameHere !== "S") {
          if (loop.has(target)) p.loop = true;
          else if (!target.startsWith("src/core/") && !target.startsWith("shared/")) p.state = true;
        }
        if (nameHere !== name && f.fns.has(nameHere)) {
          const q = profile(path, nameHere, seen);
          p.state ||= q.state; p.page ||= q.page; p.loop ||= q.loop;
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return p;
  };
  const kindOf = (path, name) => {
    const f = parse(path), local = f.exported.get(name);
    if (local == null || f.imported.has(local)) return "value";
    if (!f.fns.has(local)) return f.assigned.has(local) ? "changing" : "value";
    const p = profile(path, local, new Set());
    return p.loop ? "calls-loop" : p.state ? "stateful" : p.page ? "page-helper" : "rule";
  };
  const kinds = {};
  for (const m of frontend.values()) for (const e of m.edges) {
    if (!loop.has(m.path) || !loop.has(e.target) || e.typeOnly) continue;
    for (const name of e.names ?? []) kinds[`${e.target}#${name}`] ??= kindOf(e.target, name);
  }
  const counts = {};
  for (const kind of Object.values(kinds)) counts[kind] = (counts[kind] ?? 0) + 1;
  const moved = new Set();
  const report = (label) => {
    const kept = new Map([...frontend].map(([path, m]) => [path, { ...m, edges: m.edges.filter((e) => !e.names?.length || !e.names.every((n) => moved.has(`${e.target}#${n}`))) }]));
    const c = stronglyConnected(kept, false);
    return { label, largest: c[0]?.length ?? 0, loopModules: c.flat().length, loops: c.length, loopLinks: cycleEdges(kept).length };
  };
  const rows = [report("now")];
  for (const step of steps) {
    for (const [key, kind] of Object.entries(kinds)) {
      const name = key.slice(key.lastIndexOf("#") + 1);
      if ((step.kinds?.includes(kind) && !step.exceptNames?.includes(name)) || step.names?.includes(name)) moved.add(key);
    }
    rows.push(report(step.label));
  }
  return { counts, steps: rows };
}

export function metrics(modules) {
  const frontend = new Map([...modules].filter(([p]) => p.startsWith("src/") && layerOf(p) !== "tests"));
  const runtime = stronglyConnected(frontend, false);
  const production = [...modules.values()].filter((m) => isProduction(m.layer));
  const directSets = (m) => m.state.writes.filter((w) => w.write === "set" && w.spath.length === 1);
  return {
    frontendModules: frontend.size,
    largestFrontendRuntimeCycle: runtime[0]?.length ?? 0,
    frontendRuntimeCycles: runtime.length,
    runtimeCycleEdges: cycleEdges(modules).length,
    stateImporters: production.filter((m) => m.state.importsState).map((m) => m.path),
    stateBridges: production.filter((m) => m.state.bridge).map((m) => m.path),
    stateAssigners: production.filter((m) => directSets(m).some((w) => w.spath[0] === "state")).map((m) => m.path),
    stateFieldWriters: production.filter((m) => directSets(m).length > 0).map((m) => ({ path: m.path, writes: directSets(m).length, reads: m.state.reads })),
    stateWriters: production.filter((m) => m.state.writes.length > 0).map((m) => ({
      path: m.path,
      targets: [...new Set(m.state.writes.map((w) => stateWriteTarget(w.spath, w.write)).filter(Boolean))].sort(byCodePoint)
    })),
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
  const unique = new Map(exceptions.map((e) => [key(e), e]));
  const rows = [...unique.values()].sort(compareExceptions).map(({ rule, source, target, count, reason: given }) => {
    const reason = given ?? reasons.get(key({ rule, source, target }));
    return JSON.stringify({ rule, source, target, ...(count === undefined ? {} : { count }), ...(reason ? { reason } : {}) });
  });
  writeFileSync(path, rows.length ? `{\n  "exceptions": [\n    ${rows.join(",\n    ")}\n  ]\n}\n` : "{\n  \"exceptions\": []\n}\n");
}

function describe(v) {
  return `${v.rule}: ${v.source}${v.line ? ":" + v.line : ""} -> ${v.target}${v.count === undefined ? "" : ` (count ${v.count})`}${v.detail ? " (" + v.detail + ")" : ""}`;
}

export function run({ repo = REPO, baselinePath = BASELINE_PATH, mode = "check", reason = "", assertPath, stepsPath, print = console.log, printError = console.error } = {}) {
  const acceptReason = typeof reason === "string" ? reason.trim() : "";
  if (mode === "accept" && !acceptReason) {
    printError('dep-report: --accept needs a reason, e.g. --accept "helper moved from 05-render.js to 06-rows.js"');
    return 2;
  }
  const modules = loadGraph(repo);
  const violations = [...findViolations(modules), ...legacyViolations(modules)].sort(compareExceptions);
  const cycles = migratedCycles(modules);
  const baseline = readBaseline(baselinePath);
  const m = metrics(modules);

  if (mode === "legacy-metrics" || assertPath) {
    const actual = legacyMetrics(modules);
    print(JSON.stringify(actual, null, 2));
    if (!assertPath) return 0;
    try {
      const failures = assertLegacyMetrics(actual, JSON.parse(readFileSync(resolve(repo, assertPath), "utf8")));
      for (const failure of failures) printError(`dep-report: ${failure}`);
      return failures.length ? 1 : 0;
    } catch (error) {
      printError(`dep-report: ${error.message}`);
      return 2;
    }
  }
  if (mode === "loop-model") {
    try {
      print(JSON.stringify(loopModel(modules, JSON.parse(readFileSync(resolve(repo, stepsPath), "utf8"))), null, 2));
      return 0;
    } catch (error) {
      printError(`dep-report: ${error.message}`);
      return 2;
    }
  }
  if (mode === "metrics") {
    print(JSON.stringify(m, null, 2));
    return 0;
  }
  const unknownNames = violations.filter((v) => v.unknownNames);
  if (unknownNames.length) {
    for (const v of unknownNames) printError("  " + describe(v));
    printError("dep-report: FAILED");
    return 1;
  }
  if (mode === "init") {
    if (existsSync(baselinePath)) { printError(`dep-report: ${baselinePath} already exists; use --prune`); return 2; }
    writeBaseline(baselinePath, violations, baseline);
    print(`dep-report: wrote ${violations.length} exceptions`);
    return 0;
  }

  const { added, resolved } = compareBaseline(violations, baseline);
  const recorded = baseline.exceptions ?? [];
  print(`dep-report: ${modules.size} modules, ${m.frontendModules} frontend, largest frontend runtime cycle ${m.largestFrontendRuntimeCycle}, ${m.runtimeCycleEdges} runtime cycle edges, ${m.stateImporters.length} S importers, ${m.stateAssigners.length} S.state assigners, ${m.stateWriters.length} S writers; ${recorded.length} exceptions in the baseline, ${added.length} new, ${resolved.length} resolved`);
  const printCycles = () => {
    for (const c of cycles) printError(`  cycle (${c.graph}) through migrated ${c.migrated.join(", ")}: ${c.modules.join(" -> ")}`);
  };

  if (mode === "prune") {
    if (added.length) {
      for (const v of added) printError("  new " + describe(v));
      printError('dep-report: --prune only removes resolved exceptions; fix the new ones, or record them with --accept "<reason>"');
      return 1;
    }
    writeBaseline(baselinePath, violations, baseline);
    print(`dep-report: removed ${resolved.length} resolved exceptions`);
    return 0;
  }

  if (mode === "accept") {
    if (cycles.length) {
      printCycles();
      printError("dep-report: a cycle through a migrated folder cannot be accepted; nothing was written");
      return 1;
    }
    if (!added.length) {
      print("dep-report: nothing new to accept");
      return 0;
    }
    writeBaseline(baselinePath, [...recorded, ...added.map((v) => ({ ...v, reason: acceptReason }))], baseline);
    for (const v of added) print("  + " + describe(v));
    print(`dep-report: accepted ${added.length} new exceptions with the reason "${acceptReason}"${resolved.length ? `; ${resolved.length} resolved remain, remove them with --prune` : ""}`);
    return 0;
  }

  let failed = cycles.length > 0;
  printCycles();
  for (const v of added) { failed = true; printError("  new " + describe(v)); }
  for (const e of resolved) { failed = true; printError(`  resolved ${e.rule}: ${e.source} -> ${e.target} (remove it from the baseline with --prune)`); }
  if (failed) {
    printError("dep-report: FAILED");
    return 1;
  }
  print("dep-report: OK");
  return 0;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const modes = { "--metrics": "metrics", "--legacy-metrics": "legacy-metrics", "--init": "init", "--prune": "prune" };
  let options = null;
  if (args.length === 0) options = { mode: "check" };
  else if (args.length === 1 && modes[args[0]]) options = { mode: modes[args[0]] };
  else if (args[0] === "--accept" && args.length <= 2) options = { mode: "accept", reason: args[1] ?? "" };
  else if (args[0] === "--assert" && args.length === 2) options = { mode: "legacy-metrics", assertPath: args[1] };
  else if (args[0] === "--legacy-metrics" && args[1] === "--assert" && args.length === 3) options = { mode: "legacy-metrics", assertPath: args[2] };
  else if (args[0] === "--loop-model" && args.length === 2) options = { mode: "loop-model", stepsPath: args[1] };
  if (options === null) {
    console.error(`dep-report: unknown argument ${args.join(" ")}; use --metrics, --legacy-metrics [--assert <file>], --assert <file>, --loop-model <steps.json>, --prune, --init or --accept "<reason>"`);
    process.exitCode = 2;
  } else {
    process.exitCode = run(options);
  }
}
