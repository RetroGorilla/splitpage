import { relative } from "node:path";
import ts from "typescript";

export const BRAND_HOME = "src/core/document/validated.ts";
export const BRAND_PRODUCER = "src/core/migrate.ts";

const MAX_DEPTH = 6;
const LEAF_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.EnumLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Void |
  ts.TypeFlags.Undefined | ts.TypeFlags.Null;

const repoPath = (repo, fileName) => relative(repo, fileName).split("\\").join("/");

function isBrandProperty(repo, prop) {
  return (prop.declarations ?? []).some((d) => d.name && ts.isComputedPropertyName(d.name) && repoPath(repo, d.getSourceFile().fileName) === BRAND_HOME);
}

function fromLibrary(program, type) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const decls = symbol?.declarations ?? [];
  return decls.length > 0 && decls.every((d) => {
    const sf = d.getSourceFile();
    return program.isSourceFileDefaultLibrary(sf) || program.isSourceFileFromExternalLibrary(sf) || /[\\/]node_modules[\\/]/.test(sf.fileName);
  });
}

export function brandChecker(program, repo) {
  const checker = program.getTypeChecker();
  const memo = new Map();

  function carries(type, depth, seen) {
    if (!type || depth > MAX_DEPTH || seen.has(type)) return false;
    if (memo.has(type)) return memo.get(type);
    if (type.flags & LEAF_FLAGS) return false;
    seen.add(type);
    let found = false;
    if (type.isUnion() || type.isIntersection()) {
      found = type.types.some((t) => carries(t, depth, seen));
    } else if (type.flags & ts.TypeFlags.TypeParameter) {
      found = carries(checker.getBaseConstraintOfType(type), depth, seen);
    } else if (type.flags & ts.TypeFlags.Object) {
      found = checker.getPropertiesOfType(type).some((p) => isBrandProperty(repo, p));
      const args = type.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(type) : (type.aliasTypeArguments ?? []);
      if (!found) found = args.some((t) => carries(t, depth + 1, seen));
      if (!found && !fromLibrary(program, type)) {
        found = checker.getPropertiesOfType(type).some((p) => carries(checker.getTypeOfSymbol(p), depth + 1, seen)) ||
          checker.getSignaturesOfType(type, ts.SignatureKind.Call).some((s) => carries(s.getReturnType(), depth + 1, seen)) ||
          checker.getSignaturesOfType(type, ts.SignatureKind.Construct).some((s) => carries(s.getReturnType(), depth + 1, seen)) ||
          checker.getIndexInfosOfType(type).some((i) => carries(i.type, depth + 1, seen));
      }
    }
    seen.delete(type);
    if (depth === 0) memo.set(type, found);
    return found;
  }

  return {
    checker,
    carriesBrand: (type) => carries(type, 0, new Set())
  };
}

function isAmbient(node) {
  for (let n = node; n; n = n.parent) {
    if (ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

export function brandForgeries(program, repo, files) {
  const { checker, carriesBrand } = brandChecker(program, repo);
  const out = [];
  for (const sf of program.getSourceFiles()) {
    const path = repoPath(repo, sf.fileName);
    if (!files.has(path) || path === BRAND_PRODUCER) continue;
    const report = (node, what) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ path, line: line + 1, what });
    };
    const visit = (node) => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const target = checker.getTypeFromTypeNode(node.type);
        if (carriesBrand(target) && !checker.isTypeAssignableTo(checker.getTypeAtLocation(node.expression), target)) {
          report(node, "a type assertion to the validated document brand");
        }
      } else if (ts.isTypePredicateNode(node) && node.type && carriesBrand(checker.getTypeFromTypeNode(node.type))) {
        report(node, "a type predicate to the validated document brand");
      } else if (ts.isFunctionLike(node) && !ts.isFunctionTypeNode(node) && !ts.isConstructorTypeNode(node) && !ts.isCallSignatureDeclaration(node) &&
        !ts.isMethodSignature(node) && !ts.isConstructSignatureDeclaration(node) && !ts.isIndexSignatureDeclaration(node) && !node.body && node.type &&
        carriesBrand(checker.getTypeFromTypeNode(node.type))) {
        report(node, "a function signature with no body that returns the validated document brand");
      } else if (ts.isVariableDeclaration(node) && isAmbient(node) && node.type && carriesBrand(checker.getTypeFromTypeNode(node.type))) {
        report(node, "an ambient declaration of the validated document brand");
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
