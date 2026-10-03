import { relative } from "node:path";
import ts from "typescript";

export const BRAND_HOME = "src/core/document/validated.ts";
export const BRAND_PRODUCER = "src/core/migrate.ts";

const MAX_DEPTH = 6;
const LEAF_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.EnumLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Void |
  ts.TypeFlags.Undefined | ts.TypeFlags.Null;

const repoPath = (repo, fileName) => relative(repo, fileName).split("\\").join("/");

const inBrandHome = (repo, decls) => (decls ?? []).some((d) => repoPath(repo, d.getSourceFile().fileName) === BRAND_HOME);

function isBrandProperty(repo, prop) {
  return inBrandHome(repo, (prop.declarations ?? []).filter((d) => d.name && ts.isComputedPropertyName(d.name)));
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

  function carries(type, depth, seen) {
    if (!type || depth > MAX_DEPTH || seen.has(type)) return false;
    if (type.flags & ts.TypeFlags.Never) return true;
    if (type.flags & ts.TypeFlags.UniqueESSymbol) return inBrandHome(repo, type.getSymbol()?.declarations);
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
    return found;
  }

  return {
    checker,
    carriesBrand: (type) => carries(type, 0, new Set())
  };
}

function isAmbient(node) {
  const sf = node.getSourceFile();
  if (sf.isDeclarationFile || !ts.isExternalModule(sf)) return true;
  for (let n = node; n; n = n.parent) {
    if (ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

const MEMBER_SIGNATURE = (node) => ts.isMethodSignature(node) || ts.isPropertySignature(node) || ts.isCallSignatureDeclaration(node) ||
  ts.isConstructSignatureDeclaration(node) || ts.isIndexSignatureDeclaration(node);

export function brandForgeries(program, repo, files) {
  const { checker, carriesBrand } = brandChecker(program, repo);
  const out = [];
  const typeOf = (node) => checker.getTypeAtLocation(node);
  const signatureForges = (call) => {
    const sig = checker.getResolvedSignature(call);
    if (!sig) return false;
    const given = [...(call.arguments ?? [])];
    if (ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression)) given.push(call.expression.expression);
    if (given.some((a) => carriesBrand(typeOf(a)))) return false;
    const decl = sig.getDeclaration();
    const declared = decl ? checker.getSignatureFromDeclaration(decl) : null;
    if (!declared) {
      const cls = ts.isNewExpression(call) ? checker.getSymbolAtLocation(call.expression) : null;
      return !!cls && carriesBrand(sig.getReturnType()) && !carriesBrand(checker.getDeclaredTypeOfSymbol(cls));
    }
    const predicate = checker.getTypePredicateOfSignature(sig);
    const declaredPredicate = checker.getTypePredicateOfSignature(declared);
    if (predicate?.type && carriesBrand(predicate.type) && !(declaredPredicate?.type && carriesBrand(declaredPredicate.type))) return true;
    return carriesBrand(sig.getReturnType()) && !carriesBrand(declared.getReturnType());
  };
  for (const sf of program.getSourceFiles()) {
    const path = repoPath(repo, sf.fileName);
    if (!files.has(path) || path === BRAND_PRODUCER) continue;
    const report = (node, what) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ path, line: line + 1, what });
    };
    const declaredType = (node) => (node.type ? checker.getTypeFromTypeNode(node.type) : null);
    const visit = (node) => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const target = checker.getTypeFromTypeNode(node.type);
        if (carriesBrand(target) && !checker.isTypeAssignableTo(typeOf(node.expression), target)) {
          report(node, "a type assertion to the validated document brand or to never");
        }
      } else if (ts.isTypePredicateNode(node) && node.type && carriesBrand(checker.getTypeFromTypeNode(node.type))) {
        report(node, "a type predicate to the validated document brand or to never");
      } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && signatureForges(node)) {
        report(node, "a generic call that returns the validated document brand or never from no branded input");
      } else if (MEMBER_SIGNATURE(node) && isAmbient(node) && node.type && carriesBrand(declaredType(node))) {
        report(node, "an ambient member that yields the validated document brand");
      } else if (ts.isFunctionLike(node) && !ts.isFunctionTypeNode(node) && !ts.isConstructorTypeNode(node) && !MEMBER_SIGNATURE(node) &&
        !node.body && node.type && carriesBrand(checker.getTypeFromTypeNode(node.type))) {
        report(node, "a function signature with no body that returns the validated document brand");
      } else if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.type && (isAmbient(node) || node.exclamationToken) &&
        !(path === BRAND_HOME && ts.isTypeOperatorNode(node.type) && node.type.operator === ts.SyntaxKind.UniqueKeyword) &&
        carriesBrand(checker.getTypeFromTypeNode(node.type))) {
        report(node, "an ambient or definitely-assigned declaration of the validated document brand");
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
