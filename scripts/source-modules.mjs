/**
 * scripts/source-modules.mjs — shared static facts about the TypeScript source tree.
 *
 * ROLE
 * ----
 * Two questions are asked about `packages/<pkg>/src/**` by more than one tool, and both must
 * be answered identically everywhere or the answers stop meaning anything:
 *
 *   1. "Is this module part of the shipped artifact?"  -> `isNonShippingSource()`
 *   2. "Which modules does this file import?"          -> `collectModuleSpecifiers()`
 *
 * Keeping both here means the build, the import gate and the packed-manifest gate cannot drift
 * apart: excluding a file from the emit while a gate still believes it ships (or vice versa)
 * would produce either a broken tarball or a gate that passes on a broken tarball.
 *
 * NON-SHIPPING SOURCE CONVENTION
 * ------------------------------
 * A module is *non-shipping* — test scaffolding, never part of an npm tarball — when its name
 * or location matches one of the patterns below. This is a naming convention rather than a
 * hand-maintained exclusion list on purpose: a list has to be edited every time a fixture module
 * is added, and the failure mode of forgetting is silent (scaffolding ships). A convention is
 * enforced by `scripts/packed-files-gate.mjs`, which asserts the complete packed manifest.
 *
 *   <name>.test.ts              vitest suites
 *   <name>.fixture.ts           a single fixture module
 *   <name>.fixtures.ts          a fixture module
 *   <name>.fixtures-<topic>.ts  a fixture module split by topic (main.fixtures-batch.ts)
 *   <name>.test-support.ts      shared helpers for a suite (main.test-support.ts)
 *   <name>.test-support-<x>.ts  the same, split by topic
 *   test-support/**             a directory of test-only helpers (test-support/png-fixture.ts)
 *   __tests__/**, __fixtures__/**, __mocks__/**
 *
 * The patterns match the emitted forms too (`.js`, `.d.ts`, `.js.map`), so the same predicate
 * classifies a source file and the artifact it would produce.
 *
 * INVARIANT (enforced by `scripts/shipping-imports-gate.mjs`)
 * ----------------------------------------------------------
 * A shipping module must never import a non-shipping module. Such an import type-checks and
 * passes vitest — which runs off source — but produces an ERR_MODULE_NOT_FOUND at runtime for
 * an installed user, because the imported file was never emitted.
 *
 * DEPENDENCIES: `typescript` (a root devDependency).
 *
 * CALLERS: `scripts/build.mjs`, `scripts/shipping-imports-gate.mjs`,
 * `scripts/packed-files-gate.mjs`.
 */
import ts from "typescript";

/**
 * Code-file suffixes a module name can carry, in source or emitted form:
 * `.ts`, `.tsx`, `.js`, `.d.ts`, `.js.map`, …
 */
const CODE_SUFFIX = String.raw`(\.d)?\.(ts|tsx|js|jsx|mjs|cjs)(\.map)?`;

/** Directory names whose entire contents are test-only. */
const NON_SHIPPING_DIRECTORIES = new Set(["test-support", "__tests__", "__fixtures__", "__mocks__"]);

/** Basename patterns that mark a module as test-only. See the file header for the convention. */
const NON_SHIPPING_BASENAMES = [
  new RegExp(String.raw`\.test${CODE_SUFFIX}$`),
  new RegExp(String.raw`\.fixture${CODE_SUFFIX}$`),
  new RegExp(String.raw`\.fixtures${CODE_SUFFIX}$`),
  new RegExp(String.raw`\.fixtures-[^./]+${CODE_SUFFIX}$`),
  new RegExp(String.raw`\.test-support${CODE_SUFFIX}$`),
  new RegExp(String.raw`\.test-support-[^./]+${CODE_SUFFIX}$`)
];

/**
 * Human-readable rendering of the convention, printed by the gates when they fail so a reader
 * gets the rule and not just the offending path.
 */
export const NON_SHIPPING_SOURCE_CONVENTION = [
  "*.test.ts            vitest suites",
  "*.fixture.ts         a fixture module",
  "*.fixtures.ts        a fixture module",
  "*.fixtures-<topic>.ts fixture modules split by topic",
  "*.test-support.ts    shared helpers for a suite",
  "*.test-support-<x>.ts the same, split by topic",
  "test-support/**      a directory of test-only helpers",
  "__tests__/**, __fixtures__/**, __mocks__/**"
];

/**
 * Whether a module is test scaffolding that must never reach an npm tarball.
 *
 * Accepts a source path or an emitted path, absolute or relative, with either separator; only
 * the path segments are inspected, so the caller does not have to normalise first.
 *
 * @param {string} path e.g. "src/main.test-support.ts" or "dist/test-support/png-fixture.js"
 * @returns {boolean}
 */
export function isNonShippingSource(path) {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.some((segment) => NON_SHIPPING_DIRECTORIES.has(segment))) return true;
  const basename = segments.at(-1) ?? "";
  return NON_SHIPPING_BASENAMES.some((pattern) => pattern.test(basename));
}

/**
 * Collect every module-specifier string literal in a parsed file.
 *
 * Covers the five forms that appear in source and in emitted output: `import ... from "x"`,
 * bare `import "x"`, `export ... from "x"` / `export * from "x"`, dynamic `import("x")`,
 * `import x = require("x")`, and — in declaration output — `import("x").Type`.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {ts.StringLiteral[]}
 */
export function collectModuleSpecifiers(sourceFile) {
  const literals = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) literals.push(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        literals.push(argument.literal);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      literals.push(node.arguments[0]);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      literals.push(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}
