#!/usr/bin/env node
/**
 * scripts/shipping-imports-gate.mjs — no shipped module may depend on test scaffolding.
 *
 * ROLE
 * ----
 * `scripts/build.mjs` excludes non-shipping modules (tests, `*.fixture.ts`, `*.test-support.ts`,
 * `test-support/**` — the convention lives in `scripts/source-modules.mjs`) from the emit, so
 * they never reach an npm tarball. That exclusion introduces exactly one new way to break an
 * installed user: a *shipping* module importing one of them.
 *
 * Such an import is invisible to every other check. `pnpm typecheck` passes (the file exists in
 * source), vitest passes (it runs off source), and even `pnpm build` passes (tsc happily pulls
 * the import into the program as a non-root file — it just does not emit it). The failure only
 * appears after `npm install`, as ERR_MODULE_NOT_FOUND from a file that is not in the tarball.
 *
 * This gate closes that hole statically: it parses every shipping module and fails if any
 * relative import resolves to a non-shipping module.
 *
 * SCOPE: `packages/<pkg>/src/**` for every workspace package with a manifest. Only relative
 * specifiers are followed — a bare `@shellx-motion/x` specifier resolves through that package's
 * `exports` map, which cannot name a fixture module.
 *
 * WIRING: `pnpm run source-hygiene:check`, therefore the first step of `pnpm test`. Cheap and
 * deterministic — parse only, no build, no network.
 *
 * Exit code: 0 when clean, 1 when any shipping module imports test scaffolding.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  collectModuleSpecifiers,
  isNonShippingSource,
  NON_SHIPPING_SOURCE_CONVENTION
} from "./source-modules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");

/** Source extensions a relative specifier can resolve to. */
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Recursively list every `.ts`/`.tsx` file under `dir`. */
function listSources(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSources(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Resolve a relative module specifier written in `fromFile` to a source file on disk.
 *
 * Handles the three shapes the tree actually uses: extensionless (`./types`), explicit `.js`
 * (`./types.js`, the NodeNext spelling that maps to `types.ts`), and directory (`./domains`
 * -> `./domains/index.ts`).
 *
 * @returns {string|null} absolute path, or null when nothing resolves (tsc would have failed)
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

const offenders = [];
let inspected = 0;

for (const entry of readdirSync(PACKAGES_DIR).sort()) {
  const packageDir = join(PACKAGES_DIR, entry);
  if (!statSync(packageDir).isDirectory() || !existsSync(join(packageDir, "package.json"))) continue;

  for (const file of listSources(join(packageDir, "src"))) {
    if (isNonShippingSource(relative(packageDir, file))) continue;
    inspected += 1;
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ false,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    for (const literal of collectModuleSpecifiers(sourceFile)) {
      if (!literal.text.startsWith(".")) continue;
      const target = resolveRelative(file, literal.text);
      if (target === null) continue; // unresolvable specifiers are tsc's failure to report
      if (isNonShippingSource(relative(packageDir, target))) {
        offenders.push(`${relative(ROOT, file)} imports "${literal.text}" -> ${relative(ROOT, target)}`);
      }
    }
  }
}

if (offenders.length > 0) {
  console.error(`Shipping modules importing test scaffolding (${offenders.length}):`);
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error("");
  console.error("Non-shipping modules are excluded from the build emit, so an installed user");
  console.error("would hit ERR_MODULE_NOT_FOUND. Move the shared code into a shipping module,");
  console.error("or keep the import inside a test. Non-shipping naming convention:");
  for (const line of NON_SHIPPING_SOURCE_CONVENTION) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`shipping-imports: OK — ${inspected} shipping module(s), none import test scaffolding.`);
