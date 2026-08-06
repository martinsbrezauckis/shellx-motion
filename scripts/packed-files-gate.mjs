#!/usr/bin/env node
/**
 * scripts/packed-files-gate.mjs — assert the complete packed file manifest of every package.
 *
 * ROLE
 * ----
 * `files: ["dist"]` in a manifest is an allowlist of *directories*, not of files: whatever the
 * build happens to drop in `dist/` ships. That is how `job-host.fixture.js`,
 * `main.test-support.js`, `main.fixtures-batch.js`, `main.fixtures-packages.js`,
 * `index.fixtures-text.js` and `test-support/png-fixture.js` — 18 files of internal test
 * scaffolding — ended up inside published tarballs.
 *
 * Excluding them from the build (see `scripts/build.mjs` and the convention in
 * `scripts/source-modules.mjs`) fixes today's tarball. It does not stop the next one: an
 * exclusion nobody asserts rots silently. So this gate states, file by file, exactly what each
 * package ships, and fails on anything missing OR anything unexpected.
 *
 * WHY DERIVED, NOT SNAPSHOTTED
 * ----------------------------
 * The expectation is computed from the source tree, not recorded from a previous pack:
 *
 *   dist/    every shipping module in the package's tsconfig emit set, as the exact trio the
 *            build produces — `<name>.js`, `<name>.d.ts`, `<name>.js.map`
 *   other    every other `files` entry (e.g. core's `assets`, debug-server's `workbench`) is a
 *            hand-maintained shipped directory: its contents are listed from disk, but each
 *            entry must still pass the non-shipping convention
 *   always   `package.json`, plus `README*` / `LICENSE*` / `CHANGELOG*` when present, which npm
 *            includes regardless of `files`
 *
 * A snapshot would have to be re-recorded whenever a module is added, and "just re-run the sync
 * command" would happily re-bless a reintroduced fixture. A derived expectation cannot be
 * silenced that way: a fixture in `dist/` is unexpected no matter how many times it is packed.
 * The cost is that this gate needs a current `dist/`, so it runs after a build rather than in
 * the source-only `pnpm test` chain.
 *
 * CALLERS
 *   pnpm run pack:check          this file as a CLI — `npm pack --dry-run` per package
 *   scripts/verify-install.mjs   imports the two exported helpers and checks the *real* tarballs
 *                                it has already packed, so the assertion is made against the
 *                                bytes a user would download
 *
 * USAGE
 *   node scripts/packed-files-gate.mjs                     # every package (requires dist/)
 *   node scripts/packed-files-gate.mjs --package NAME      # one package, by manifest name
 *
 * Exit code: 0 when every packed manifest matches, 1 otherwise (differences printed).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isNonShippingSource, NON_SHIPPING_SOURCE_CONVENTION } from "./source-modules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");

/**
 * Metadata files a package manager may add to a tarball on its own: npm always packs a package's
 * own README/LICENSE/CHANGELOG, and pnpm additionally copies the *workspace root* LICENSE into
 * every package that lacks one. They are allowed but never required, because which of them
 * appears depends on the packer rather than on this repository.
 */
const OPTIONAL_METADATA = ["README.md", "README", "LICENSE", "LICENCE", "CHANGELOG.md"];

/** Extensions the build emits for one TypeScript module, in `dist/`. */
const EMITTED_SUFFIXES = [".js", ".d.ts", ".js.map"];

/**
 * Every workspace package that has a manifest (`packages/fixtures` has none, and pnpm skips it
 * for the same reason).
 *
 * @returns {Array<{name: string, dir: string, manifest: any}>}
 */
export function discoverPackages() {
  const found = [];
  for (const entry of readdirSync(PACKAGES_DIR).sort()) {
    const dir = join(PACKAGES_DIR, entry);
    const manifestPath = join(dir, "package.json");
    if (!statSync(dir).isDirectory() || !existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    found.push({ name: manifest.name, dir, manifest });
  }
  return found;
}

/** Recursively list files under `dir`, as paths relative to `base`, posix-separated. */
function listRelativeFiles(dir, base) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listRelativeFiles(full, base));
    else found.push(relative(base, full).replaceAll("\\", "/"));
  }
  return found;
}

/**
 * The emit set for a package: exactly the root names `scripts/build.mjs` compiles, i.e. the
 * package tsconfig's file list minus every non-shipping module.
 *
 * @param {string} packageDir
 * @returns {string[]} paths relative to `<packageDir>/src`, posix-separated
 */
function shippingModules(packageDir) {
  const configPath = join(packageDir, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(`${relative(ROOT, configPath)} is unreadable`);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageDir, {}, configPath);
  const srcDir = join(packageDir, "src");
  return parsed.fileNames
    .filter((file) => !isNonShippingSource(relative(packageDir, file)))
    .filter((file) => !relative(srcDir, file).startsWith(".."))
    .map((file) => relative(srcDir, file).replaceAll("\\", "/"));
}

/**
 * The complete set of files a package is expected to pack.
 *
 * @param {{name: string, dir: string, manifest: any}} pkg
 * @returns {{expected: Set<string>, optional: Set<string>, problems: string[]}} `expected` must
 *          all be present, `optional` may be, `problems` carries scaffolding found inside a
 *          hand-maintained shipped directory, which no diff of `expected` could show
 */
export function expectedPackedFiles(pkg) {
  const expected = new Set(["package.json"]);
  const optional = new Set(OPTIONAL_METADATA);
  const problems = [];

  const files = pkg.manifest.files;
  if (!Array.isArray(files) || files.length === 0) {
    problems.push(`${pkg.name}: manifest declares no "files" allowlist, so the tarball contents are unbounded.`);
    return { expected, optional, problems };
  }

  for (const entry of files) {
    const target = join(pkg.dir, entry);
    if (entry === "dist") {
      for (const module of shippingModules(pkg.dir)) {
        const stem = module.replace(/\.tsx?$/, "");
        for (const suffix of EMITTED_SUFFIXES) expected.add(`dist/${stem}${suffix}`);
      }
      if (pkg.name === "@shellx-motion/debug-server") {
        const docsRoot = join(ROOT, "docs", "public");
        for (const file of listRelativeFiles(docsRoot, docsRoot)) {
          expected.add(`dist/docs/public/${file}`);
        }
      }
      continue;
    }
    if (!existsSync(target)) {
      problems.push(`${pkg.name}: manifest "files" lists ${entry}, which does not exist.`);
      continue;
    }
    if (statSync(target).isDirectory()) {
      for (const file of listRelativeFiles(target, pkg.dir)) {
        if (isNonShippingSource(file)) {
          problems.push(`${pkg.name}: test scaffolding inside shipped directory ${entry}: ${file}`);
          continue;
        }
        expected.add(file);
      }
      continue;
    }
    expected.add(entry.replaceAll("\\", "/"));
  }

  return { expected, optional, problems };
}

/**
 * Compare one package's actual packed manifest against its expectation.
 *
 * @param {string} name package name, for messages
 * @param {Set<string>} expected files that must all be present
 * @param {Iterable<string>} actual packed paths, relative to the package root
 * @param {Set<string>} [optional] files that may be present (packer-supplied metadata)
 * @returns {string[]} one line per difference; empty means the manifest is exactly right
 */
export function comparePackedFiles(name, expected, actual, optional = new Set()) {
  const actualSet = new Set(actual);
  const problems = [];
  for (const file of [...actualSet].sort()) {
    if (expected.has(file) || optional.has(file)) continue;
    const why = isNonShippingSource(file) ? " (test scaffolding — must not ship)" : "";
    problems.push(`${name}: unexpected file in tarball: ${file}${why}`);
  }
  for (const file of [...expected].sort()) {
    if (!actualSet.has(file)) problems.push(`${name}: expected file missing from tarball: ${file}`);
  }
  return problems;
}

/**
 * Ask npm what a pack would contain, without writing a tarball.
 *
 * @param {string} packageDir
 * @returns {string[]} packed paths relative to the package root
 */
function npmPackDryRun(packageDir) {
  // stderr is captured rather than inherited: npm prints unrelated env-config warnings there that
  // would otherwise bury this gate's own output. It resurfaces on `error.stderr` if npm fails.
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [report] = JSON.parse(stdout);
  return report.files.map((file) => file.path);
}

function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--package") ? args[args.indexOf("--package") + 1] : null;

  const packages = discoverPackages().filter((pkg) => only === null || pkg.name === only);
  if (packages.length === 0) {
    console.error(`packed-files: unknown package "${only}"`);
    process.exit(1);
  }

  const problems = [];
  let total = 0;
  for (const pkg of packages) {
    if (!existsSync(join(pkg.dir, "dist"))) {
      problems.push(`${pkg.name}: no dist/ — run pnpm build before pnpm run pack:check.`);
      continue;
    }
    const { expected, optional, problems: expectationProblems } = expectedPackedFiles(pkg);
    problems.push(...expectationProblems);
    const actual = npmPackDryRun(pkg.dir);
    total += actual.length;
    problems.push(...comparePackedFiles(pkg.name, expected, actual, optional));
    console.log(`packed-files: ${pkg.name.padEnd(34)} ${String(actual.length).padStart(4)} files`);
  }

  if (problems.length > 0) {
    console.error(`\npacked-files: FAIL — ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("\nNon-shipping naming convention (scripts/source-modules.mjs):");
    for (const line of NON_SHIPPING_SOURCE_CONVENTION) console.error(`  ${line}`);
    console.error("\nA stale dist/ also fails this gate — rebuild with `pnpm run build:clean && pnpm build`.");
    process.exit(1);
  }

  console.log(`\npacked-files: PASS — ${packages.length} package(s), ${total} files, manifest exactly as expected.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
