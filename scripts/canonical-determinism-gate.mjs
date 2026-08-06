#!/usr/bin/env node
/**
 * scripts/canonical-determinism-gate.mjs — machine-enforced determinism rules for hash paths.
 *
 * ROLE
 * ----
 * `packages/core/src/canonical-json.ts` states the rule that every hash, fingerprint and
 * content-address path must serialize through `canonicalJson` and must never order strings with
 * `String.prototype.localeCompare`. Before this gate existed the rule was stated ONLY in that
 * comment, and the result was measurable: an adversarial regression reproduced three live hash
 * divergences on one machine by changing nothing but `LC_ALL`, and found SIX independent
 * re-implementations of stable-JSON, three of which sorted with `localeCompare`.
 *
 * A rule a machine does not check is a rule that decays. This gate checks it.
 *
 * RULES
 * -----
 * R1 — LOCALE ORDER (hard, default-deny).
 *   `localeCompare` may not appear in shipped source. `compareCodeUnits` from
 *   `@shellx-motion/core` is the fixed, locale-independent comparator and is what every ordering
 *   that reaches a hash, a fingerprint, a written file, or an agent-visible list must use.
 *   Escape hatch for a genuinely human-facing ordering: put `locale-order-ok: <reason>` in a
 *   comment on the same line or the line directly above. The reason is then greppable and
 *   reviewable, instead of invisible.
 *
 * R2 — ONE CANONICAL JSON (hard, default-deny).
 *   A *stable-JSON re-implementation* is a RECURSIVE function that sorts object keys and emits
 *   or rebuilds JSON from them. Exactly one may exist: `serialize` in `canonical-json.ts`.
 *   Detection is structural, not name-based, so renaming the function does not evade it:
 *     R2a — a template literal emitting `${JSON.stringify(key)}:` (the `"key":value` text form).
 *     R2b — `Object.fromEntries(<chain containing .sort(>)` (the re-insert form; note this form
 *           is ALSO wrong for integer-like keys, which JS re-orders on insertion).
 *     R2c — `for (const k of Object.keys(x).sort(...))` with an element assignment (loop form).
 *   Any of those inside a function that calls itself is a re-implementation. The recursion
 *   requirement is what keeps ordinary sorted-record builders (which are not serializers) out.
 *
 * R3 — HASH OF NON-CANONICAL JSON (ratchet, per-file count).
 *   `hashBuffer(Buffer.from(JSON.stringify(x)))` and `createHash(...).update(JSON.stringify(x))`
 *   are order-dependent unless `x` is an object/array literal written out in the source, because
 *   `JSON.stringify` follows insertion order. At the time this gate was written the repo had 80
 *   such sites spread across many packages, so converting them all was not a change this gate
 *   could demand atomically. Instead the gate freezes them: the per-file
 *   counts in `canonical-determinism-baseline.json` may go DOWN (and should), never UP. A new
 *   hash path therefore cannot be written this way.
 *
 * PENDING FILES
 * -------------
 * `R1_PENDING_FILES` lists files exempt from R1 because they could not be converted safely at the
 * time the gate landed. They are debt, they are visible here, and each one must be resolved before
 * release. The list is currently empty. Do not add to it to silence a new finding —
 * use the `locale-order-ok:` marker when the ordering really is human-facing, or fix it.
 *
 * SCOPE: `packages/<pkg>/src/**\/*.ts(x)` excluding tests and other non-shipping modules, plus
 * `scripts/**\/*.{ts,mjs}`. Browser assets under `packages/debug-server/workbench/**` are a
 * rendered UI surface, not shipped hashing code, and are out of scope.
 *
 * WIRING: `pnpm run source-hygiene:check`, therefore the first step of `pnpm test`. Parse only —
 * no build, no network, deterministic.
 *
 * USAGE
 *   node scripts/canonical-determinism-gate.mjs                    # check (exit 1 on violation)
 *   node scripts/canonical-determinism-gate.mjs --update-baseline  # rewrite the R3 baseline
 *   node scripts/canonical-determinism-gate.mjs --root <dir>       # scan another tree
 *
 * `--root` exists so the gate can be tested on a synthetic tree that deliberately contains the
 * patterns it bans. A gate nobody has watched fail is an untested gate, and this one was written
 * precisely because an unenforced rule had already failed silently.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootFlag = process.argv.indexOf("--root");
const ROOT = rootFlag === -1
  ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
  : resolve(process.argv[rootFlag + 1] ?? ".");
const BASELINE_PATH = join(ROOT, "scripts", "canonical-determinism-baseline.json");

/** The single permitted canonical-JSON implementation. Every other module must import it. */
const CANONICAL_JSON_SPINE = "packages/core/src/canonical-json.ts";

/**
 * Files exempt from R1 only because they could not be converted safely when this gate landed.
 * Each entry is release-blocking debt, not an approved pattern. Empty, and meant to stay that way.
 */
/**
 * Files exempt from R1. EMPTY, and it must stay that way.
 *
 * The four entries this list was created with were all resolved during cross-host verification, in the same session:
 * `debug-api/src/domains/agent.ts` and `package-edit-transaction.ts` now use `compareCodeUnits`,
 * `scripts/version-parity.ts` likewise, and `scripts/generate-debug-api-reference.mjs` compares code
 * units inline (it is an .mjs script and cannot import the TypeScript helper).
 *
 * Do not add to this list to silence a new finding. Where an ordering really is human-facing, use
 * the machine-checked `locale-order-ok: <reason>` marker; otherwise fix it. An exemption list with
 * entries is indistinguishable, six months later, from a rule nobody enforces.
 */
const R1_PENDING_FILES = new Set([]);

/** Marker that downgrades an R1 finding to an accepted human-facing ordering. */
const LOCALE_MARKER = /locale-order-ok:\s*\S/;

/** Recursively list candidate sources under `dir`. */
function listSources(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSources(full, out);
    } else if (/\.(tsx?|mjs)$/.test(entry.name) && !isExcluded(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Test and fixture scaffolding is not shipped and may exercise the very patterns banned here. */
function isExcluded(name) {
  return /\.test\.(tsx?|mjs)$/.test(name)
    || /\.fixture\.tsx?$/.test(name)
    || /\.test-support\.tsx?$/.test(name);
}

/** Every shipped source file the gate inspects, repo-relative and sorted for stable output. */
function gateSources() {
  const files = [];
  const packagesDir = join(ROOT, "packages");
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    listSources(join(packagesDir, pkg.name, "src"), files);
  }
  listSources(join(ROOT, "scripts"), files);
  return files
    .map((file) => relative(ROOT, file).split("\\").join("/"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * True when `node` (a function-like declaration) contains a call to itself.
 *
 * This is what separates a canonical-JSON serializer from an ordinary sorted-record builder:
 * a serializer walks the value tree, so it recurses. Matching is by the declared name, which is
 * enough for the local `function foo()` / `const foo = (…) =>` forms used in this repo.
 */
function callsItself(node, sourceFile) {
  const name = functionName(node);
  if (!name) return false;
  let found = false;
  const walk = (child) => {
    if (found) return;
    if (ts.isCallExpression(child) && child.expression.getText(sourceFile) === name) {
      found = true;
      return;
    }
    // A serializer commonly recurses through `.map(foo)` rather than `foo(x)`.
    if (ts.isIdentifier(child) && child.text === name && child.parent && !ts.isFunctionDeclaration(child.parent)
      && !ts.isVariableDeclaration(child.parent)) {
      const parent = child.parent;
      if (ts.isCallExpression(parent) && parent.arguments.includes(child)) found = true;
    }
    ts.forEachChild(child, walk);
  };
  if (node.body) ts.forEachChild(node.body, walk);
  return found;
}

/** Declared name of a function declaration, or of the variable an arrow/function expression is bound to. */
function functionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

/**
 * Every enclosing function-like declaration of `node`, innermost first.
 *
 * All of them matter, not just the nearest: the key emit of a canonical serializer normally sits
 * inside an anonymous `.map(([key, item]) => …)` callback, so the recursive function that owns the
 * pattern is one or two frames further out.
 */
function enclosingFunctions(node) {
  const owners = [];
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)
      || ts.isMethodDeclaration(current)) {
      owners.push(current);
    }
  }
  return owners;
}

/** R2a/R2b/R2c: does this node emit or rebuild JSON from sorted object keys? */
function sortedKeyEmit(node, sourceFile) {
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const expression = span.expression;
      if (ts.isCallExpression(expression) && expression.expression.getText(sourceFile) === "JSON.stringify"
        && span.literal.text.startsWith(":")) {
        return "R2a";
      }
    }
  }
  if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "Object.fromEntries"
    && node.arguments.length > 0 && node.arguments[0].getText(sourceFile).includes(".sort(")) {
    return "R2b";
  }
  if (ts.isForOfStatement(node)) {
    const iterated = node.expression.getText(sourceFile);
    if (/Object\.keys\([\s\S]*\)\s*\.sort\(/.test(iterated)
      && /\[[A-Za-z_$][\w$]*\]\s*=/.test(node.statement.getText(sourceFile))) {
      return "R2c";
    }
  }
  return null;
}

/**
 * R3: is this `JSON.stringify` call the direct payload of a hash sink, over a value whose key
 * order is NOT fixed by the source text?
 *
 * An object/array literal written out in the source has its key order fixed at authoring time, so
 * hashing it is reproducible. A spread (`{ ...record }`) or a computed key re-opens the hole, and
 * so does any identifier or call result, because those carry whatever insertion order they were
 * built with.
 */
function nonCanonicalHashPayload(node, sourceFile) {
  if (!ts.isCallExpression(node) || node.expression.getText(sourceFile) !== "JSON.stringify") return false;
  const parent = node.parent;
  const inSink = parent && ts.isCallExpression(parent)
    && /(^|\.)(from|update)$/.test(parent.expression.getText(sourceFile).split("(")[0])
    && parent.arguments.includes(node);
  const inDirectHash = parent && ts.isCallExpression(parent)
    && /^(hashBuffer|sha256)$/.test(parent.expression.getText(sourceFile));
  if (!inSink && !inDirectHash) return false;
  const payload = node.arguments[0];
  if (!payload) return true;
  const literal = ts.isObjectLiteralExpression(payload) || ts.isArrayLiteralExpression(payload);
  if (!literal) return true;
  const text = payload.getText(sourceFile);
  return text.includes("...") || /\[[^\]]+\]\s*:/.test(text);
}

/** Comment text on the same line as, or the line directly above, `line` (1-based). */
function markerNearby(lines, line) {
  const here = lines[line - 1] ?? "";
  const above = lines[line - 2] ?? "";
  return LOCALE_MARKER.test(here) || LOCALE_MARKER.test(above);
}

/** Line number (1-based) of a node's first token. */
function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function main() {
  const updateBaseline = process.argv.includes("--update-baseline");
  const violations = [];
  const r3Counts = {};

  for (const file of gateSources()) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const lines = text.split("\n");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const walk = (node) => {
      // R1 — locale-sensitive ordering. Reading it off the AST means occurrences inside comments
      // and string literals (this file's own prose, the doc comment in canonical-json.ts) are not
      // matched, so the rule can be written down without tripping itself.
      if (ts.isPropertyAccessExpression(node) && node.name.text === "localeCompare") {
        const line = lineOf(node, sourceFile);
        if (!R1_PENDING_FILES.has(file) && !markerNearby(lines, line)) {
          violations.push({
            rule: "R1",
            file,
            line,
            message: "localeCompare is locale-dependent; use compareCodeUnits from @shellx-motion/core"
              + " (or annotate the line `locale-order-ok: <reason>` if the order is human-facing)"
          });
        }
      }

      // R2 — a second canonical-JSON implementation.
      const emit = sortedKeyEmit(node, sourceFile);
      if (emit && file !== CANONICAL_JSON_SPINE) {
        const owner = enclosingFunctions(node).find((candidate) => callsItself(candidate, sourceFile));
        if (owner) {
          violations.push({
            rule: emit,
            file,
            line: lineOf(node, sourceFile),
            message: `recursive stable-JSON re-implementation in ${functionName(owner) ?? "an anonymous function"};`
              + " import canonicalJson / canonicalJsonSha256 from @shellx-motion/core instead"
          });
        }
      }

      // R3 — hashing JSON.stringify over a value whose key order is not fixed by the source.
      if (nonCanonicalHashPayload(node, sourceFile)) {
        r3Counts[file] = (r3Counts[file] ?? 0) + 1;
      }

      ts.forEachChild(node, walk);
    };
    walk(sourceFile);
  }

  if (updateBaseline) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ rule: "R3", counts: r3Counts }, null, 2)}\n`, "utf8");
    console.log(`canonical-determinism-gate: baseline updated (${Object.keys(r3Counts).length} files, `
      + `${Object.values(r3Counts).reduce((sum, count) => sum + count, 0)} sites).`);
    return 0;
  }

  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")).counts ?? {}
    : {};
  const loosened = [];
  const tightened = [];
  for (const [file, count] of Object.entries(r3Counts)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) loosened.push({ file, allowed, count });
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = r3Counts[file] ?? 0;
    if (count < allowed) tightened.push({ file, allowed, count });
  }

  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}  [${violation.rule}] ${violation.message}`);
  }
  for (const entry of loosened) {
    console.error(`${entry.file}  [R3] hashes JSON.stringify of a non-literal value at `
      + `${entry.count} sites, baseline allows ${entry.allowed}. Serialize through canonicalJson `
      + `(canonicalJsonSha256) instead of adding another order-dependent hash.`);
  }
  if (tightened.length > 0) {
    // Not a failure: a shrinking count is the direction of travel, and failing here would break
    // unrelated work that happens to remove a site. Reported so the baseline gets re-tightened.
    for (const entry of tightened) {
      console.log(`canonical-determinism-gate: ${entry.file} improved to ${entry.count} R3 sites `
        + `(baseline ${entry.allowed}); re-run with --update-baseline to lock it in.`);
    }
  }

  if (violations.length > 0 || loosened.length > 0) {
    console.error(`\ncanonical-determinism-gate: FAILED — ${violations.length} rule violation(s), `
      + `${loosened.length} file(s) over the R3 baseline.`);
    return 1;
  }
  const total = Object.values(r3Counts).reduce((sum, count) => sum + count, 0);
  console.log(`canonical-determinism-gate: ok (R1/R2 clean, R3 at ${total} baselined sites, `
    + `${R1_PENDING_FILES.size} file(s) pending R1 cleanup).`);
  return 0;
}

process.exit(main());
