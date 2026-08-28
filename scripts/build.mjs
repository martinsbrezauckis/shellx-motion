#!/usr/bin/env node
/**
 * scripts/build.mjs — the workspace build: TypeScript emit + Node-ESM specifier repair.
 *
 * ROLE
 * ----
 * Turns every publishable workspace package under `packages/` into runnable JavaScript
 * (`dist/*.js`) plus type declarations (`dist/*.d.ts`), so the packages can be packed and
 * installed. Before this existed, `bin` and `exports` pointed at raw `.ts` and nothing about
 * ShellX Motion could be installed by a user.
 *
 * WHY A SCRIPT INSTEAD OF PLAIN `tsc -b`
 * --------------------------------------
 * The source tree is written for a bundler-style resolver: `tsconfig.base.json` sets
 * `moduleResolution: "Bundler"`, and ~540 relative imports are extensionless
 * (`from "./types"`) while ~320 already carry `.js`. `tsc` copies module specifiers through
 * verbatim — there is no compiler flag that adds extensions (checked against TS 5.9). So a
 * plain `tsc` emit produces `.js` that Node's ESM resolver rejects with ERR_MODULE_NOT_FOUND.
 *
 * The two ways out are (a) rewrite every extensionless import in `src/**` to `./x.js`, or
 * (b) repair the specifiers on the emitted output. (a) is the better end state but touches
 * hundreds of source files; (b) keeps `src/**` untouched and is deterministic. This script
 * does (b), and it does it against the parsed AST (never a regex over source text), so only
 * genuine module specifiers are rewritten — string literals in ordinary code are never touched.
 *
 * PIPELINE (per package, in workspace-dependency topological order)
 * ----------------------------------------------------------------
 *   1. Parse the package's own `tsconfig.json`, drop every non-shipping module from the emit set
 *      (tests, fixtures, test-support helpers, and explicitly unadopted implementation — see
 *      `scripts/source-modules.mjs` for the convention that defines "non-shipping").
 *   2. Emit `dist/` with `ts.createProgram`, resolving `@shellx-motion/*` imports to the
 *      already-built `dist/*.d.ts` of the dependency (via generated `paths`), so each package
 *      is typechecked against exactly the declarations it will ship.
 *   3. Repair relative specifiers in the emitted `.js` and `.d.ts`: `./x` -> `./x.js`,
 *      `./dir` -> `./dir/index.js`. Resolution is checked against files that actually exist
 *      in `dist/`; an unresolvable specifier fails the build.
 *   4. For packages with a `bin`, normalise the shebang to `#!/usr/bin/env node` and mark the
 *      file executable. (`debug-server/src/cli.ts` carries a `#!/usr/bin/env tsx` shebang that
 *      is correct for source and wrong for built output.)
 *
 * DEPENDENCIES: `typescript` (already a root devDependency). Nothing else — no bundler.
 *
 * CALLERS: root `pnpm build`; per-package `pnpm --filter <pkg> build` (each package's `build`
 * script delegates here with `--package <name>`); `scripts/verify-install.mjs`.
 *
 * USAGE
 *   node scripts/build.mjs                  # build every package, topological order
 *   node scripts/build.mjs --package NAME   # build one package (dependencies must be built)
 *   node scripts/build.mjs --clean          # remove every packages/<pkg>/dist first
 */
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectModuleSpecifiers, isNonShippingSource } from "./source-modules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");

/** Relative specifier suffixes that already resolve under Node ESM and must be left alone. */
const RESOLVED_EXTENSIONS = [".js", ".mjs", ".cjs", ".json", ".node", ".css", ".wasm"];

/**
 * Read every workspace package that has a manifest.
 * `packages/fixtures` has no package.json and is intentionally skipped, matching pnpm.
 *
 * @returns {Array<{name: string, dir: string, manifest: any}>}
 */
function discoverPackages() {
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

/**
 * Order packages so every workspace dependency is built before its dependents.
 *
 * @param {Array<{name: string, manifest: any}>} packages
 * @returns {Array<any>} the same objects, dependency-first
 * @throws if the workspace dependency graph contains a cycle
 */
function topologicalOrder(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const ordered = [];
  const state = new Map(); // name -> "visiting" | "done"

  const visit = (pkg, trail) => {
    const mark = state.get(pkg.name);
    if (mark === "done") return;
    if (mark === "visiting") {
      throw new Error(`Workspace dependency cycle: ${[...trail, pkg.name].join(" -> ")}`);
    }
    state.set(pkg.name, "visiting");
    for (const dep of Object.keys(pkg.manifest.dependencies ?? {})) {
      const target = byName.get(dep);
      if (target) visit(target, [...trail, pkg.name]);
    }
    state.set(pkg.name, "done");
    ordered.push(pkg);
  };

  for (const pkg of packages) visit(pkg, []);
  return ordered;
}

/**
 * Build the `paths` map used during emit so `@shellx-motion/x` resolves to the dependency's
 * built `dist/*.d.ts` rather than its `src/*.ts`.
 *
 * The dev-time `exports` in each manifest deliberately still point at `./src/*.ts` (that is
 * what keeps `pnpm typecheck`, vitest and the tsx smoke scripts running straight off source
 * with no build). During emit we must not pull a dependency's source into this package's
 * program: with `rootDir: src` that is a TS6059 "not under rootDir" error, and it would also
 * mean each package re-typechecks its dependencies' sources. Mapping to the built `.d.ts`
 * gives the shipped-artifact view instead.
 *
 * @param {Array<{name: string, dir: string, manifest: any}>} packages
 * @returns {Record<string, string[]>}
 */
function buildPathsMap(packages) {
  const paths = {};
  for (const pkg of packages) {
    const exportsField = pkg.manifest.exports;
    if (!exportsField) continue;
    const entries = typeof exportsField === "string" ? { ".": exportsField } : exportsField;
    for (const [subpath, target] of Object.entries(entries)) {
      if (typeof target !== "string" || !target.endsWith(".ts")) continue;
      const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, "")}`;
      const declaration = join(pkg.dir, target.replace(/^\.\/src\//, "dist/").replace(/\.ts$/, ".d.ts"));
      paths[specifier] = [declaration];
    }
  }
  return paths;
}

/**
 * Emit one package to `<dir>/dist`.
 *
 * @param {{name: string, dir: string, manifest: any}} pkg
 * @param {Record<string, string[]>} paths generated `@shellx-motion/*` -> built `.d.ts` map
 * @returns {ts.Diagnostic[]} empty when the emit was clean
 */
function emitPackage(pkg, paths) {
  const configPath = join(pkg.dir, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) return [configFile.error];

  /**
   * Overrides applied on top of the package tsconfig. These are emit-only concerns and are
   * deliberately NOT written into the checked-in tsconfigs, which stay `--noEmit` typecheck
   * configs so the fast source-only typecheck loop is unchanged.
   *
   * `inlineSources` embeds the TypeScript into the `.js.map` so published sourcemaps are
   * self-contained; `src/` is not shipped in the tarball.
   */
  const overrides = {
    noEmit: false,
    declaration: true,
    declarationMap: false,
    sourceMap: true,
    inlineSources: true,
    composite: false,
    incremental: false,
    outDir: join(pkg.dir, "dist"),
    rootDir: join(pkg.dir, "src"),
    paths
  };

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    pkg.dir,
    overrides,
    configPath
  );
  if (parsed.errors.length > 0) return parsed.errors;

  // Nonshipping source is still typechecked from source, but is not part of the adopted artifact.
  // Excluding it here keeps it out of tarballs; the packed-files gate asserts the manifest and the
  // shipping-import gate proves no shipped module depends on an omitted module.
  const rootNames = parsed.fileNames.filter((file) => !isNonShippingSource(relative(pkg.dir, file)));

  const program = ts.createProgram({ rootNames, options: parsed.options });
  const emitResult = program.emit();
  return [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics];
}

/**
 * Recursively list files under `dir` matching one of `suffixes`.
 *
 * @param {string} dir
 * @param {string[]} suffixes
 * @returns {string[]} absolute paths
 */
function listFiles(dir, suffixes) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, suffixes));
    else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) out.push(full);
  }
  return out;
}

/**
 * Rewrite extensionless relative specifiers in a package's emitted output so Node's ESM
 * resolver can follow them.
 *
 * Resolution is checked against the emitted `dist/` tree itself — the same files Node will
 * see — rather than being inferred from the source layout. A `.d.ts` is repaired against its
 * sibling `.js` (they are emitted as a pair), which is also what a `NodeNext` consumer of the
 * declarations needs: `./x.js` resolves to `./x.d.ts`.
 *
 * @param {string} distDir
 * @returns {{files: number, rewrites: number, unresolved: string[]}}
 */
function repairSpecifiers(distDir) {
  const files = listFiles(distDir, [".js", ".d.ts"]);
  const unresolved = [];
  let rewrites = 0;

  for (const file of files) {
    const original = readFileSync(file, "utf8");
    const isDeclaration = file.endsWith(".d.ts");
    const sourceFile = ts.createSourceFile(
      file,
      original,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
      isDeclaration ? ts.ScriptKind.TS : ts.ScriptKind.JS
    );

    const edits = [];
    for (const literal of collectModuleSpecifiers(sourceFile)) {
      const specifier = literal.text;
      if (!specifier.startsWith(".")) continue;
      if (RESOLVED_EXTENSIONS.some((ext) => specifier.endsWith(ext))) continue;

      const target = resolve(dirname(file), specifier);
      let replacement = null;
      if (existsSync(`${target}.js`)) replacement = `${specifier}.js`;
      else if (existsSync(join(target, "index.js"))) replacement = `${specifier}/index.js`;

      if (replacement === null) {
        unresolved.push(`${relative(ROOT, file)}: ${specifier}`);
        continue;
      }
      // Splice inside the quotes, so the original quote style survives untouched.
      edits.push({ start: literal.getStart(sourceFile) + 1, end: literal.getEnd() - 1, replacement });
    }

    if (edits.length === 0) continue;
    let text = original;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
    }
    writeFileSync(file, text);
    rewrites += edits.length;
  }

  return { files: files.length, rewrites, unresolved };
}

/**
 * Make a built `bin` entry directly executable.
 *
 * Two things are needed and neither can come from `tsc`: a Node shebang (source either has
 * none, or has `#!/usr/bin/env tsx` which is right for source and wrong for `dist`), and the
 * executable bit. When a shebang has to be prepended, the file gains a line, so the paired
 * sourcemap gets one leading `;` group to shift every mapping down by one line and stay honest.
 *
 * @param {string} file absolute path to an emitted bin entry
 */
function prepareBinEntry(file) {
  const text = readFileSync(file, "utf8");
  if (text.startsWith("#!")) {
    const newlineIndex = text.indexOf("\n");
    writeFileSync(file, `#!/usr/bin/env node${text.slice(newlineIndex === -1 ? text.length : newlineIndex)}`);
  } else {
    writeFileSync(file, `#!/usr/bin/env node\n${text}`);
    const mapFile = `${file}.map`;
    if (existsSync(mapFile)) {
      const map = JSON.parse(readFileSync(mapFile, "utf8"));
      map.mappings = `;${map.mappings}`;
      writeFileSync(mapFile, JSON.stringify(map));
    }
  }
  chmodSync(file, 0o755);
}

/**
 * Copy runtime assets that must exist inside an installed package. The Workbench docs remain
 * single-sourced in docs/public; the build mirrors them into dist so an installed debug-server
 * never reaches outside its package looking for the repository tree.
 */
function copyPackageRuntimeAssets(pkg, distDir) {
  if (pkg.name !== "@shellx-motion/debug-server") return;
  const target = join(distDir, "docs", "public");
  rmSync(target, { recursive: true, force: true });
  cpSync(join(ROOT, "docs", "public"), target, { recursive: true });
}

/**
 * Validate package-local executable assets that are deliberately packed beside dist rather than
 * emitted by TypeScript. The enforced-untrusted shims are launched directly by renderer hosts,
 * so a missing shebang mode would turn a supposedly enforced host policy into a launch failure.
 */
function assertExecutableRuntimeAssets(pkg) {
  const launchers = pkg.name === "@shellx-motion/renderer-browser"
    ? ["enforced-untrusted-browser-launcher.mjs"]
    : pkg.name === "@shellx-motion/renderer-ffmpeg"
      ? ["enforced-untrusted-ffmpeg-launcher.mjs"]
      : [];
  for (const name of launchers) assertExecutableRuntimeAsset(pkg, join(pkg.dir, "bin", name));
}

/**
 * Assert that a repository-owned runtime launcher is present as a regular source file.
 *
 * Windows ships the `.mjs` shim as source but cannot express a meaningful POSIX executable bit.
 * POSIX hosts execute the shim directly, so their source mode remains an integrity requirement.
 *
 * @param {{name: string}} pkg
 * @param {string} launcher
 * @param {NodeJS.Platform} platform
 */
export function assertExecutableRuntimeAsset(pkg, launcher, platform = process.platform) {
  if (!existsSync(launcher)) throw new Error(`build: ${pkg.name} runtime launcher is missing: ${relative(ROOT, launcher)}`);
  const facts = statSync(launcher);
  const missingPosixExecutableBit = platform !== "win32" && (facts.mode & 0o111) === 0;
  if (!facts.isFile() || missingPosixExecutableBit) {
    throw new Error(`build: ${pkg.name} runtime launcher must be a source executable: ${relative(ROOT, launcher)}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--package") ? args[args.indexOf("--package") + 1] : null;
  const clean = args.includes("--clean");

  const packages = discoverPackages();
  const ordered = topologicalOrder(packages);
  const paths = buildPathsMap(packages);

  if (clean) {
    for (const pkg of ordered) rmSync(join(pkg.dir, "dist"), { recursive: true, force: true });
  }

  const selected = only ? ordered.filter((pkg) => pkg.name === only) : ordered;
  if (only && selected.length === 0) {
    console.error(`build: unknown package "${only}"`);
    process.exit(1);
  }

  const started = Date.now();
  for (const pkg of selected) {
    const packageStarted = Date.now();
    assertExecutableRuntimeAssets(pkg);
    const diagnostics = emitPackage(pkg, paths);
    if (diagnostics.length > 0) {
      console.error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (f) => f,
          getCurrentDirectory: () => ROOT,
          getNewLine: () => "\n"
        })
      );
      console.error(`build: ${pkg.name} FAILED (${diagnostics.length} diagnostic(s))`);
      process.exit(1);
    }

    const distDir = join(pkg.dir, "dist");
    copyPackageRuntimeAssets(pkg, distDir);
    const repair = repairSpecifiers(distDir);
    if (repair.unresolved.length > 0) {
      console.error(`build: ${pkg.name} has unresolvable relative imports in its output:`);
      for (const entry of repair.unresolved) console.error(`  ${entry}`);
      process.exit(1);
    }

    for (const target of Object.values(pkg.manifest.bin ?? {})) {
      const binFile = join(pkg.dir, target.replace(/^\.\//, ""));
      if (!existsSync(binFile)) {
        console.error(`build: ${pkg.name} bin target missing after emit: ${relative(ROOT, binFile)}`);
        process.exit(1);
      }
      prepareBinEntry(binFile);
    }

    const seconds = ((Date.now() - packageStarted) / 1000).toFixed(1);
    console.log(
      `build: ${pkg.name.padEnd(34)} ${String(repair.files).padStart(4)} files, ` +
        `${String(repair.rewrites).padStart(4)} specifiers repaired  (${seconds}s)`
    );
  }

  console.log(`build: ${selected.length} package(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
