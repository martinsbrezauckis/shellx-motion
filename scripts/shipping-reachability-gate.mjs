#!/usr/bin/env node
/**
 * Fail when a module that ships is reachable from nothing.
 *
 * Role: `scripts/source-modules.mjs` decides "shipping" from the FILENAME — anything not matching
 * `*.test.ts` / `*.fixture(s).ts` / `*.test-support.ts` / `test-support/**` ships by definition. The
 * packed-files gate then asserts the tarball matches an expectation derived from that same rule, so
 * it cannot ever catch a test-only module that simply is not named like one. An adversarial regression
 * demonstrated this exactly: three obviously test-only modules added as `mockData.ts`,
 * `testUtils.ts` and `helpers-for-tests.ts` compiled into `dist/`, appeared in `npm pack --dry-run`
 * (4 files -> 13), and every gate stayed green — the gate BLESSED them as expected. Commit `a60a5a7`
 * removed the 18 files that were shipping that day; the convention did not stop tomorrow's.
 *
 * The check here does not try to guess intent from a name. It asks a question a name cannot answer:
 * starting from what the package actually publishes, can this module be reached at all? A shipping
 * module reachable from no entry point is dead code or test scaffolding, and neither belongs in a
 * tarball — so the rule needs no allowlist, which is the point. An allowlist would reopen the same
 * hole one entry at a time.
 *
 * Entry points come from `package.json` (`exports`, `main`, `module`, `types`, `bin`), mapped back
 * from `dist/x.js` to `src/x.ts` where a package publishes built output. That is the same mapping
 * the build uses, so a module the build emits is a module this walk starts from.
 *
 * Dependencies: typescript (for the parser) and scripts/source-modules.mjs. No network, no build.
 * Primary caller: the release gate list in package.json.
 *
 * Usage: node scripts/shipping-reachability-gate.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectModuleSpecifiers, isNonShippingSource } from "./source-modules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Every `.ts`/`.tsx` under `dir`, recursively. */
function listSources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Resolve a relative specifier to a source file, covering the shapes this tree uses: extensionless,
 * the NodeNext `.js` spelling that means `.ts`, and a directory meaning its `index.ts`.
 */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [];
  const jsMatch = /\.(js|jsx|mjs|cjs)$/.exec(base);
  if (jsMatch) candidates.push(base.slice(0, -jsMatch[0].length) + (jsMatch[1] === "jsx" ? ".tsx" : ".ts"));
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(join(base, `index${extension}`));
  if (existsSync(base) && statSync(base).isFile()) candidates.push(base);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Every string in a package.json entry-point field, flattened out of nested `exports` maps. */
function entryStrings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) entryStrings(item, found);
  else if (value && typeof value === "object") for (const item of Object.values(value)) entryStrings(item, found);
  return found;
}

/**
 * Source files a package publishes as its public surface.
 *
 * `./dist/main.js` maps back to `src/main.ts`: a package that publishes built output still starts
 * its graph at the source the build emitted from.
 */
function entryPointsFor(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const declared = ["exports", "main", "module", "types", "bin"].flatMap((field) => entryStrings(manifest[field]));
  // A package.json script target used to count as an entry point, so that `actions/src/coverage.ts`
  // and `prompt/src/smoke.ts` — dev tooling run by `pnpm run debug:coverage` and the prompt smoke —
  // would not fail the release. The exemption was load-bearing for the wrong thing: it also blessed
  // `prompt/src/smoke.ts` into the published tarball as `dist/smoke.js`, reachable from no export
  // subpath. Both modules now live in the repo's `scripts/` directory
  // with the other dev scripts, outside every package's `src/`, so a "run by a script" reason to
  // ship a module no longer exists and this gate asks only one question: does the published surface
  // lead here?
  const entries = new Set();
  for (const declaration of declared) {
    const cleaned = declaration.replace(/^\.\//, "");
    const asSource = cleaned
      .replace(/^dist\//, "src/")
      .replace(/\.d\.ts$/, ".ts")
      .replace(/\.(js|mjs|cjs)$/, ".ts");
    const resolved = resolveRelative(join(packageDir, "package.json"), `./${asSource}`);
    // A workspace `exports` map may carry a development-only subpath that `publishConfig.exports`
    // deliberately omits — `@shellx-motion/prompt`'s `./test-support` is one. Starting the walk
    // there would let scaffolding vouch for modules the published surface never reaches.
    if (resolved && !isNonShippingSource(relative(packageDir, resolved))) entries.add(resolved);
  }
  // A package that declares nothing still publishes its index; without this the walk starts nowhere
  // and every module looks unreachable, which would be a false alarm rather than a finding.
  if (entries.size === 0) {
    const fallback = resolveRelative(join(packageDir, "package.json"), "./src/index.ts");
    if (fallback) entries.add(fallback);
  }
  return [...entries];
}

/** Shipping modules reachable from `entries`, following relative imports only. */
function reachableFrom(entries, packageDir) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      false,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    for (const literal of collectModuleSpecifiers(sourceFile)) {
      if (!literal.text.startsWith(".")) continue;
      const target = resolveRelative(file, literal.text);
      // A non-shipping target is the other gate's business (shipping-imports-gate), not ours.
      if (target && !isNonShippingSource(relative(packageDir, target))) stack.push(target);
    }
  }
  return seen;
}

const orphans = [];
let inspected = 0;

for (const entry of readdirSync(PACKAGES_DIR).sort()) {
  const packageDir = join(PACKAGES_DIR, entry);
  if (!statSync(packageDir).isDirectory() || !existsSync(join(packageDir, "package.json"))) continue;

  const shipping = listSources(join(packageDir, "src"))
    .filter((file) => !isNonShippingSource(relative(packageDir, file)));
  if (shipping.length === 0) continue;

  const reachable = reachableFrom(entryPointsFor(packageDir), packageDir);
  inspected += shipping.length;
  for (const file of shipping) {
    if (!reachable.has(file)) orphans.push(relative(ROOT, file));
  }
}

if (orphans.length > 0) {
  console.error(`Shipping modules reachable from no entry point (${orphans.length}):`);
  for (const orphan of orphans) console.error(`  ${orphan}`);
  console.error("");
  console.error("Each of these is built and packed, but nothing a consumer can import leads to it.");
  console.error("That means it is dead code, or it is test scaffolding whose filename does not say so");
  console.error("— the case the filename convention cannot detect. Delete it, wire it to a real entry");
  console.error("point, or rename it to the non-shipping convention so it stops being built.");
  process.exit(1);
}

console.log(`shipping-reachability: OK — ${inspected} shipping module(s), all reachable from a package entry point.`);
