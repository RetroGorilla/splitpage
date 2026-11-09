import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import ts from "typescript";
import { REPO, isScript, listRepoFiles, parseScript } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";

export const BASELINE_PATH = join(REPO, "tools", "dep-baseline.json");

const EXCLUDED = [/^node_modules\//, /\/node_modules\//, /^\.claude\/handoff\//, /^index\.html$/];
const RESOLVE_SUFFIXES = ["", ".ts", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json", "/index.ts", "/index.js", "/index.mjs"];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, "")]));

export const MIGRATED_LAYERS = ["core", "application", "adapters", "features", "bootstrap"];
const NON_PRODUCTION = ["tests", "tools", "other", "prototypes"];

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
export const RICHTEXT_READER = "src/bootstrap/richtext.ts";
const HTML_PARSE_METHODS = new Set(["createContextualFragment", "parseHTMLUnsafe", "setHTMLUnsafe", "setHTML"]);
const XML_MIME_TYPES = new Set(["application/xml", "text/xml", "image/svg+xml", "application/xhtml+xml"]);

const CLOCK_FREE_DATE_MEMBERS = new Set(["parse", "UTC"]);

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
  if (path.startsWith("prototypes/")) return "prototypes";
  if (path.startsWith("src/test/") || path.startsWith("tests/") || /\.test\.[cm]?[jt]s$/.test(path)) return "tests";
  const core = /^src\/core\/([^/]+)\//.exec(path);
  if (core) return CORE_DEPENDENCIES[`core/${core[1]}`] ? `core/${core[1]}` : "core";
  if (/^src\/core\//.test(path)) return "core";
  const feature = /^src\/features\/([^/]+)\//.exec(path);
  if (feature) return `features/${feature[1]}`;
  const top = /^src\/(application|adapters|bootstrap|starters)\//.exec(path);
  if (top) return top[1];
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
  if (target === "prototypes") return false;
  if (source === "prototypes") return isCore(target) || target === "shared";
  if (target === "tests") return ["tools", "other"].includes(source);
  if (isCore(source)) {
    if (target === "shared") return true;
    if (source === "core") return isCore(target);
    return (CORE_DEPENDENCIES[source] ?? []).includes(target);
  }
  switch (source) {
    case "shared": return false;
    case "starters": return false;
    case "application": return isCore(target) || target === "shared";
    case "adapters": return isCore(target) || ["application", "shared"].includes(target);
    case "bootstrap": return true;
    default:
      if (source.startsWith("features/")) return isCore(target) || target === "features/common" || ["application", "shared"].includes(target);
      return true;
  }
}

export function platformImportAllowed(layer) {
  return !(isCore(layer) || layer.startsWith("features/") || ["shared", "application"].includes(layer));
}

export function platformGlobalsBanned(layer) {
  return isCore(layer) || ["shared", "application"].includes(layer);
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
  return path.startsWith(RICHTEXT_ADAPTER) || path === RICHTEXT_READER;
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

function bindScopes(sf) {
  const refs = [];
  const refOf = new Map();
  const loads = [];
  const ambient = [];
  const scopeOf = (parent, isFunction) => ({ parent, isFunction, values: new Map(), types: new Map() });
  const moduleScope = scopeOf(null, true);
  const functionScope = (s) => { while (!s.isFunction) s = s.parent; return s; };

  const declare = (s, id, kind) => {
    const spaces = TYPE_ONLY_KINDS.has(kind) ? [s.types] : VALUE_AND_TYPE_KINDS.has(kind) ? [s.values, s.types] : [s.values];
    if (spaces[0].has(id.text)) return;
    const binding = { kind };
    for (const names of spaces) names.set(id.text, binding);
  };
  const declarePattern = (name, target, kind, s) => {
    if (ts.isIdentifier(name)) { declare(target, name, kind); return; }
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) walk(el.propertyName.expression, s);
      if (el.initializer) walk(el.initializer, s);
      declarePattern(el.name, target, kind, s);
    }
  };
  const declareVariables = (list, s) => {
    const flags = list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using);
    const kind = flags === 0 ? "var" : flags === ts.NodeFlags.Let ? "let" : "const";
    const target = flags === 0 ? functionScope(s) : s;
    for (const d of list.declarations) {
      declarePattern(d.name, target, kind, s);
      if (d.type) walk(d.type, s);
      if (d.initializer) walk(d.initializer, s);
    }
  };
  const declareParameter = (p, fs) => {
    for (const m of p.modifiers ?? []) if (ts.isDecorator(m)) walk(m.expression, fs);
    declarePattern(p.name, fs, "param", fs);
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
    const kind = (typeOnly) => (clause.isTypeOnly || typeOnly ? "import-type" : "import");
    if (clause.name) declare(s, clause.name, kind(false));
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) declare(s, nb.name, kind(false));
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) declare(s, el.name, kind(el.isTypeOnly));
    }
  };

  const walkFunction = (node, s) => {
    for (const m of node.modifiers ?? []) if (ts.isDecorator(m)) walk(m.expression, s);
    if (node.name && ts.isComputedPropertyName(node.name)) walk(node.name.expression, s);
    if (ts.isFunctionDeclaration(node) && node.name) declare(s, node.name, "function");
    const fs = scopeOf(s, true);
    if (ts.isFunctionExpression(node) && node.name) declare(fs, node.name, "function");
    for (const tp of node.typeParameters ?? []) walk(tp, fs);
    (node.parameters ?? []).forEach((p) => declareParameter(p, fs));
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
    if (ts.isExportDeclaration(node)) return;
    if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      declare(s, node.name, node.isTypeOnly ? "import-type" : "import-equals");
      if (!ts.isExternalModuleReference(ref)) walk(ref, s);
      return;
    }
    if (ts.isImportTypeNode(node)) { for (const t of node.typeArguments ?? []) walk(t, s); return; }
    if (ts.isExportAssignment(node)) {
      walk(node.expression, s);
      return;
    }
    if (ts.isVariableStatement(node)) {
      declareVariables(node.declarationList, s);
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
      if (ts.isVariableDeclarationList(node.initializer)) declareVariables(node.initializer, ls);
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
      if (node.variableDeclaration) declarePattern(node.variableDeclaration.name, cs, "let", cs);
      walk(node.block, cs);
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) recordLoad(node, "dynamic-import");
      else if (ts.isIdentifier(callee) && callee.text === "require") recordLoad(node, "require");
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
  }
  const isFree = (identifier) => !refOf.get(identifier)?.binding;
  return { refs, loads, ambient, isFree };
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
  const { refs, isFree } = scopes;

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

  return { imports, unresolved, htmlParses: [...htmlParses].map(([name, line]) => ({ name, line })), globals: [...globals].map(([name, line]) => ({ name, line })), ambients: [...ambients].map(([name, line]) => ({ name, line })) };
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
    modules.set(path, { path, text, layer: layerOf(path), edges, unresolved: analysis.unresolved, htmlParses: analysis.htmlParses, globals: analysis.globals, ambients: analysis.ambients });
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
  const richtextModules = [...modules.values()].filter((m) => m.path.startsWith(RICHTEXT_ADAPTER));
  const htmlCellModules = new Set(richtextModules.filter((m) => m.path !== RICHTEXT_ADAPTER + "tag-anchors.ts").map((m) => m.path));
  for (const m of richtextModules) if (m.htmlParses.length) htmlCellModules.add(m.path);
  let addedHtmlCellModule = true;
  while (addedHtmlCellModule) {
    addedHtmlCellModule = false;
    for (const m of richtextModules) {
      if (!htmlCellModules.has(m.path) && m.edges.some((e) => e.kind === "file" && !e.typeOnly && htmlCellModules.has(e.target))) {
        htmlCellModules.add(m.path);
        addedHtmlCellModule = true;
      }
    }
  }
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
      for (const a of m.ambients) add("platform-global", m.path, `ambient:${a.name}`, a.line, `${m.layer} may not declare an ambient ${a.name}`);
    }
    if (isProduction(m.layer) && !ownsHtmlCells(m.path)) {
      for (const e of m.edges) {
        if (e.kind === "file" && !e.typeOnly && htmlCellModules.has(e.target)) {
          add("html-cells", m.path, e.target, e.line, `reaches the HTML decoder; only ${RICHTEXT_READER} may import ${RICHTEXT_ADAPTER}`);
        }
      }
      for (const p of m.htmlParses) add("html-cells", m.path, `html-parse:${p.name}`, p.line, `parses HTML with ${p.name}; only ${RICHTEXT_ADAPTER} builds cells from HTML`);
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
    added: violations.filter((v) => !allowed.has(key(v))),
    resolved: [...allowed.values()].filter((e) => !current.has(key(e)))
  };
}

export function metrics(modules) {
  const frontend = new Map([...modules].filter(([p]) => p.startsWith("src/") && layerOf(p) !== "tests"));
  const runtime = stronglyConnected(frontend, false);
  return {
    frontendModules: frontend.size,
    frontendRuntimeCycles: runtime.length,
    runtimeCycleEdges: cycleEdges(modules).length,
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
  const rows = [...unique.values()].sort(compareExceptions).map(({ rule, source, target, reason: given }) => {
    const reason = given ?? reasons.get(key({ rule, source, target }));
    return JSON.stringify({ rule, source, target, ...(reason ? { reason } : {}) });
  });
  writeFileSync(path, rows.length ? `{\n  "exceptions": [\n    ${rows.join(",\n    ")}\n  ]\n}\n` : "{\n  \"exceptions\": []\n}\n");
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
  const recorded = baseline.exceptions ?? [];
  print(`dep-report: ${modules.size} modules, ${m.frontendModules} frontend, ${m.runtimeCycleEdges} runtime cycle edges; ${recorded.length} exceptions in the baseline, ${added.length} new, ${resolved.length} resolved`);
  const printCycles = () => {
    for (const c of cycles) printError(`  cycle (${c.graph}) through migrated ${c.migrated.join(", ")}: ${c.modules.join(" -> ")}`);
  };

  if (mode === "prune") {
    if (added.length) {
      for (const v of added) printError("  new " + describe(v));
      printError("dep-report: baselines only shrink; fix the violation");
      return 1;
    }
    writeBaseline(baselinePath, violations, baseline);
    print(`dep-report: removed ${resolved.length} resolved exceptions`);
    return 0;
  }

  let failed = cycles.length > 0;
  printCycles();
  for (const v of added) { failed = true; printError("  new " + describe(v)); }
  for (const e of resolved) printError(`  warning: resolved ${e.rule}: ${e.source} -> ${e.target} (remove it with \`node tools/dep-report.mjs --prune\`)`);
  if (failed) {
    printError("dep-report: FAILED");
    return 1;
  }
  print("dep-report: OK");
  return 0;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const modes = { "--metrics": "metrics", "--init": "init", "--prune": "prune" };
  let options = null;
  if (args.length === 0) options = { mode: "check" };
  else if (args.length === 1 && modes[args[0]]) options = { mode: modes[args[0]] };
  if (options === null) {
    console.error(`dep-report: unknown argument ${args.join(" ")}; use --metrics, --prune or --init`);
    process.exitCode = 2;
  } else {
    process.exitCode = run(options);
  }
}
