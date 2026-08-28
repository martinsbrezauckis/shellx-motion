#!/usr/bin/env node
/**
 * scripts/verify-install.mjs — proves ShellX Motion is actually installable.
 *
 * ROLE
 * ----
 * The workspace `exports` fields deliberately point at `./src/*.ts` so `pnpm typecheck`,
 * vitest and the tsx smoke scripts keep running straight off source with no build step. The
 * installed shape comes from `publishConfig` (see scripts/build.mjs and any package.json),
 * which pnpm applies when it packs. A consequence is that the built `dist/` tree cannot be
 * exercised from inside the workspace — its workspace imports would resolve back to source.
 *
 * So the only honest check is the real one: pack every package, install the tarballs into
 * a throwaway project, and run them. That exercises the exact artifacts a user would get — built
 * JS, `publishConfig` exports, `bin` shebang, `files` allowlist, `workspace:*` version
 * rewriting — end to end.
 *
 * CHECKS
 *   packed-files      every tarball contains exactly the files it should — the complete manifest
 *                     is asserted per package against `scripts/packed-files-gate.mjs`, so neither
 *                     nonshipping source (test scaffolding or `unadopted/**`) nor a stale/missing
 *                     emit can ship unnoticed
 *   packed-manifest   the installed manifests expose ./dist/*, not ./src/*.ts, and carry no
 *                     leftover `workspace:` specifiers
 *   packed-runtime-exports every production workspace export resolves from the installed
 *                     tarballs, with built JavaScript and declarations in its export map;
 *                     source-only test-support exports stay private
 *   built-entry       `node <pkg>/dist/main.js validate <fixture>` returns ok:true, i.e. the
 *                     built JavaScript and its cross-package imports genuinely run
 *   npm-bin           the `bin` as npm exposes it (a symlink in node_modules/.bin) runs
 *   pnpm-bin          the `bin` as pnpm exposes it (a shell shim) runs
 *   installed-version both installed bin shapes report the packed CLI's exact version
 *   installed-discovery both installed bin shapes run the read-only runtime probe, catalog, and
 *                     capability description with packed/unmanaged truth and closed identities
 *   installed-doctor  both installed bin shapes run the real host requirements probe
 *   workbench-bin     the installed human launcher plans persistent local access and auto-open
 *   installed-ui      the installed server serves Workbench, Connections, and packaged docs
 *   mcp-bridge        the installed stdio bridge starts and reports a stopped engine clearly
 *
 * `npm-bin` and `pnpm-bin` differ in one way that matters: npm symlinks the bin, so
 * `process.argv[1]` stays the symlink path while `import.meta.url` is realpath-resolved;
 * pnpm writes a shim that execs node with the real path, so both agree. Any entry guard that
 * compares those two by basename therefore works under pnpm and silently no-ops under npm.
 *
 * CALLERS: root `pnpm build:verify`.
 *
 * USAGE
 *   node scripts/verify-install.mjs                # build, pack, install, run
 *   node scripts/verify-install.mjs --skip-build   # reuse the existing dist/
 *
 * Output lands in `.scratch/install-verify/` (gitignored).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installedWorkbenchProbeSource } from "./installed-workbench-probe.mjs";
import { comparePackedFiles, discoverPackages, expectedPackedFiles } from "./packed-files-gate.mjs";
import { collectPackedRuntimeExportContract } from "./packed-runtime-exports.mjs";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";

// Package managers create large nested trees using the caller's umask. A common
// developer umask of 0002 would make the installed fixture ancestry group-writable,
// which Motion must refuse. Keep the disposable consumer apps private from their
// first mkdir through every npm/pnpm child process instead of weakening authority.
if (process.platform !== "win32") process.umask(0o077);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = await preparePrivateRepoScratch(ROOT);
const WORK = join(SCRATCH, "install-verify");
const TARBALLS = join(WORK, "tarballs");
const NPM_APP = join(WORK, "npm-app");
const PNPM_APP = join(WORK, "pnpm-app");
const FIXTURE = join(ROOT, "fixtures", "packages", "lower-third");

// Admit the complete release-owned work root before the first rmSync below.
// A pre-existing nested competitor remains untouched when this refuses.
await assertPrivateRepoScratchPath(ROOT, WORK);

const results = [];

/**
 * Run a command, echoing it first. Throws on a non-zero exit.
 *
 * @returns trimmed stdout, or "" when the caller streamed output with `stdio: "inherit"`.
 */
function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}${options.cwd ? `   (cwd: ${options.cwd})` : ""}`);
  return (execFileSync(command, args, { encoding: "utf8", ...options }) ?? "").trim();
}

/**
 * Invoke the exact pnpm JavaScript entrypoint that launched this verification.
 *
 * Windows commonly exposes pnpm through a PowerShell shim. `execFileSync("pnpm")`
 * cannot execute that shim and reports ENOENT even though `pnpm run build:verify`
 * is already running successfully. pnpm publishes its real entrypoint in
 * `npm_execpath`, so executing it with the current Node binary is shell-free and
 * works identically on Windows, macOS, and Linux.
 */
function runPnpm(args, options = {}) {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (pnpmEntrypoint && /pnpm(?:\.c?js)?$/i.test(pnpmEntrypoint) && existsSync(pnpmEntrypoint)) {
    return run(process.execPath, [pnpmEntrypoint, ...args], options);
  }
  if (process.platform === "win32") {
    throw new Error(
      "Could not resolve pnpm's JavaScript entrypoint. On Windows run this gate as `pnpm run build:verify`."
    );
  }
  return run("pnpm", args, options);
}

/**
 * Invoke npm without asking Node to execute a Windows `.cmd` shim.
 *
 * `execFileSync("npm")` works on POSIX but Windows CreateProcess neither applies
 * PATHEXT nor executes batch files. The official Windows Node installer keeps
 * npm's JavaScript entrypoint beside node.exe, so call that entrypoint with the
 * exact Node binary already running this gate. This stays shell-free and keeps
 * paths with spaces as individual arguments.
 */
function runNpm(args, options = {}) {
  if (process.platform === "win32") {
    const npmEntrypoint = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(npmEntrypoint)) {
      throw new Error(`Could not resolve npm's JavaScript entrypoint beside ${process.execPath}.`);
    }
    return run(process.execPath, [npmEntrypoint, ...args], options);
  }
  return run("npm", args, options);
}

/**
 * Run an installed package bin on the current host.
 *
 * npm and pnpm expose executable `.cmd` shims on Windows. Node's shell-free
 * execFile APIs cannot execute those batch files directly, so use cmd.exe only
 * for the exact generated shim and a deliberately narrow argument alphabet.
 * The shim path travels through the environment to keep spaces out of command
 * construction; all normal executable files continue through execFileSync.
 */
function runInstalledExecutable(command, args, options = {}) {
  const windowsShim = `${command}.cmd`;
  if (process.platform !== "win32" || !existsSync(windowsShim)) {
    return run(command, args, options);
  }
  if (!args.every((value) => /^[A-Za-z0-9._/:=@+-]+$/.test(value))) {
    throw new Error("Windows install verification accepts only fixed, shell-safe package-bin arguments.");
  }
  const commandLine = `""%SHELLX_MOTION_VERIFY_BIN%"${args.length > 0 ? ` ${args.join(" ")}` : ""}"`;
  return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
    ...options,
    windowsVerbatimArguments: true,
    env: {
      ...process.env,
      ...options.env,
      SHELLX_MOTION_VERIFY_BIN: windowsShim
    }
  });
}

/**
 * Record a check outcome.
 *
 * @param {string} name check id, as documented in the file header
 * @param {boolean} ok
 * @param {string} detail one line of evidence or diagnosis
 */
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

/**
 * Invoke the installed CLI and decide whether it really ran the requested command.
 *
 * A no-op exit-0 with empty stdout counts as a failure: that is precisely what an entry guard
 * that missed produces, and it is indistinguishable from success by exit code alone.
 *
 * @param {string} label check id
 * @param {string} command executable to run
 * @param {string[]} args
 * @param {string} cwd
 */
function expectValidate(label, command, args, cwd) {
  let stdout;
  try {
    stdout = runInstalledExecutable(command, args, { cwd });
  } catch (error) {
    record(label, false, `invocation failed: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const lastLine = stdout.split("\n").filter(Boolean).pop();
  if (!lastLine) {
    record(label, false, "exited 0 but produced no output — the entry point never ran");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    record(label, false, `output was not the expected JSON result: ${lastLine.slice(0, 120)}`);
    return;
  }
  record(
    label,
    parsed.ok === true && parsed.command === "validate",
    parsed.ok === true ? lastLine : `unexpected result: ${lastLine.slice(0, 200)}`
  );
}

function expectJsonPlan(label, command, args, cwd, predicate) {
  try {
    const stdout = runInstalledExecutable(command, args, { cwd });
    const parsed = JSON.parse(stdout.split("\n").filter(Boolean).pop() ?? "null");
    record(label, Boolean(predicate(parsed)), JSON.stringify(parsed).slice(0, 500));
  } catch (error) {
    record(label, false, `invocation failed: ${String(error.message).split("\n")[0]}`);
  }
}

function isCatalogIdentity(value) {
  return value?.schema === "shellx-motion/capability-catalog@2" &&
    typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint);
}

function isUnmanagedInstalledProbe(result) {
  const probe = result?.probe;
  return result?.ok === true && result.command === "runtime-probe" &&
    probe?.schema === "shellx-motion/runtime-probe@1" &&
    probe?.provenance?.execution === "packed" &&
    probe?.provenance?.managedDistribution === "unmanaged" &&
    probe?.provenance?.distributionQualification === "unverified" &&
    probe?.provenance?.cleanHostQualification === "unverified" &&
    isCatalogIdentity(probe?.catalog) && Number.isInteger(probe.catalog.descriptorCount) &&
    probe.catalog.descriptorCount >= 1 && probe.catalog.descriptorCount <= 256;
}

function isInstalledCatalog(result) {
  return result?.ok === true && result.command === "connector catalog" &&
    isCatalogIdentity(result.catalog) && Array.isArray(result.catalog.descriptors) &&
    result.catalog.descriptors.length >= 1 && result.catalog.descriptors.length <= 256;
}

function isAdmittedDescription(result) {
  return result?.ok === true && result.command === "connector describe" &&
    isCatalogIdentity(result.catalog) && result?.descriptor?.id === "connector.template-to-cut@1" &&
    result.descriptor?.invocation?.admission === "admitted" &&
    JSON.stringify(result.descriptor?.invocation?.jobControls) === JSON.stringify(["cancel", "events", "get", "list", "retry"]);
}

function expectInstalledWorkbench(label, cwd) {
  const probe = installedWorkbenchProbeSource();
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", probe], { cwd, encoding: "utf8" });
    const parsed = JSON.parse(stdout.trim());
    record(
      label,
      parsed.ok === true && parsed.hasConnectionsDoc === true && parsed.hasPortableBridgeCommand === true && parsed.leaksBridgePath === false,
      JSON.stringify(parsed)
    );
  } catch (error) {
    record(label, false, `installed server probe failed: ${String(error.message).split("\n")[0]}`);
  }
}

function expectStoppedMcpBridge(label, command, cwd) {
  try {
    const stdout = runInstalledExecutable(command, [], {
      cwd,
      encoding: "utf8",
      input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      env: { ...process.env, SHELLX_MOTION_ACCESS_ROOT: join(cwd, "missing-motion-state") }
    });
    const parsed = JSON.parse(stdout.trim());
    const message = parsed?.error?.message;
    record(label, message === "ShellX Motion is not running. Start Motion, then retry this tool call.", String(message));
  } catch (error) {
    record(label, false, `installed bridge probe failed: ${String(error.message).split("\n")[0]}`);
  }
}

/** Pack every workspace package; pnpm applies publishConfig and rewrites workspace:* here. */
function packAll() {
  const tarballs = new Map();
  for (const entry of readdirSync(join(ROOT, "packages")).sort()) {
    const dir = join(ROOT, "packages", entry);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const { name } = JSON.parse(readFileSync(manifestPath, "utf8"));
    const output = runPnpm(["pack", "--pack-destination", TARBALLS], { cwd: dir });
    tarballs.set(name, output.split("\n").filter(Boolean).pop());
  }
  return tarballs;
}

/**
 * packed-files: assert the complete file manifest of every tarball that was just packed.
 *
 * This reads the real archives — not a `--dry-run` prediction — so what is asserted is exactly
 * the bytes a user would download. The expectation is derived from the source tree by
 * `scripts/packed-files-gate.mjs`: every shipping module's emitted trio, the hand-maintained
 * shipped directories, and nothing else. Both directions matter: an unexpected file means
 * nonshipping implementation (or junk) is shipping, a missing file means the tarball is short an
 * emit and will fail at import time.
 *
 * @param {Map<string, string>} tarballs package name -> tarball filename inside TARBALLS
 */
function checkPackedFiles(tarballs) {
  const problems = [];
  let total = 0;

  for (const pkg of discoverPackages()) {
    const tarball = tarballs.get(pkg.name);
    if (!tarball) {
      problems.push(`${pkg.name}: was never packed`);
      continue;
    }
    // `pnpm pack` prints an absolute path; `resolve` passes that through and still handles a
    // bare filename should a future pnpm version print one.
    const listing = run("tar", ["-tzf", resolve(TARBALLS, tarball)])
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
      .map((entry) => entry.replace(/^\.?\/?package\//, ""));
    total += listing.length;

    const { expected, optional, problems: expectationProblems } = expectedPackedFiles(pkg);
    problems.push(...expectationProblems);
    problems.push(...comparePackedFiles(pkg.name, expected, listing, optional));
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`    ${problem}`);
  }
  record(
    "packed-files",
    problems.length === 0,
    problems.length === 0
      ? `${tarballs.size} tarballs, ${total} files, every manifest exactly as expected`
      : `${problems.length} manifest problem(s), listed above`
  );
}

function installedPackageDir(appRoot, packageName) {
  return join(appRoot, "node_modules", ...packageName.split("/"));
}

/**
 * Assert that every installed export map points at the expected built files, and that no
 * source-only or unused-internal surface leaked into the packed manifest.
 */
function checkPackedRuntimeExportMaps(label, appRoot, contract) {
  const manifests = new Map();
  const problems = [];

  for (const entry of contract.runtime) {
    const packageDir = installedPackageDir(appRoot, entry.packageName);
    let manifest = manifests.get(entry.packageName);
    if (!manifest) {
      try {
        manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
        manifests.set(entry.packageName, manifest);
      } catch (error) {
        problems.push(`${entry.packageName}: installed manifest is unreadable (${String(error.message).split("\n")[0]})`);
        continue;
      }
    }

    const packed = manifest.exports?.[entry.subpath];
    if (!packed || typeof packed !== "object" || Array.isArray(packed)) {
      problems.push(`${entry.specifier}: packed exports entry is missing or not a conditional built map.`);
      continue;
    }
    for (const [condition, expected] of Object.entries(entry.targets)) {
      const actual = packed[condition];
      if (actual !== expected) {
        problems.push(`${entry.specifier}: ${condition} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`);
        continue;
      }
      if (!existsSync(join(packageDir, actual.replace(/^\.\//, "")))) {
        problems.push(`${entry.specifier}: packed ${condition} target is absent: ${actual}.`);
      }
    }
  }

  for (const entry of contract.privateEntries) {
    const packageDir = installedPackageDir(appRoot, entry.packageName);
    let manifest = manifests.get(entry.packageName);
    if (!manifest) {
      try {
        manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
        manifests.set(entry.packageName, manifest);
      } catch (error) {
        problems.push(`${entry.packageName}: installed manifest is unreadable (${String(error.message).split("\n")[0]})`);
        continue;
      }
    }
    if (Object.hasOwn(manifest.exports ?? {}, entry.subpath)) {
      problems.push(`${entry.specifier}: source-only or unused internal export leaked into the packed manifest.`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`    ${problem}`);
  }
  record(
    label,
    problems.length === 0,
    problems.length === 0
      ? `${contract.runtime.length} production export(s) map to built JS/types; ${contract.privateEntries.length} source-only or unused internal export(s) remain private`
      : `${problems.length} packed runtime export-map problem(s), listed above`
  );
}

/**
 * Generate a hermetic consumer probe: resolution must stay under the installed app's own
 * node_modules before the module namespace is loaded. This rules out a workspace/source import
 * accidentally making the check pass.
 */
function packedRuntimeImportProbeSource(specifiers) {
  return [
    'import { join, sep } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    `const specifiers = ${JSON.stringify(specifiers)};`,
    'const installedRoot = pathToFileURL(`${join(process.cwd(), "node_modules")}${sep}`).href;',
    'const imported = [];',
    'for (const specifier of specifiers) {',
    '  const resolved = import.meta.resolve(specifier);',
    '  if (!resolved.startsWith(installedRoot)) {',
    '    throw new Error(`${specifier} resolved outside the packed consumer: ${resolved}`);',
    '  }',
    '  const namespace = await import(specifier);',
    '  imported.push({ specifier, resolved, exportCount: Object.keys(namespace).length });',
    '}',
    'console.log(JSON.stringify({ ok: true, imported }));'
  ].join("\n");
}

function expectPackedRuntimeImports(label, appRoot, contract) {
  const specifiers = contract.runtime.map((entry) => entry.specifier);
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", packedRuntimeImportProbeSource(specifiers)],
      { cwd: appRoot, encoding: "utf8" }
    );
    const parsed = JSON.parse(stdout.trim());
    const imports = parsed?.imported;
    record(
      label,
      parsed?.ok === true && Array.isArray(imports) && imports.length === specifiers.length,
      parsed?.ok === true
        ? `${imports.length} production export(s) resolved and imported from packed node_modules`
        : `unexpected import probe result: ${stdout.trim().slice(0, 300)}`
    );
  } catch (error) {
    record(label, false, `packed runtime import probe failed: ${String(error.message).split("\n")[0]}`);
  }
}

function main() {
  if (!process.argv.includes("--skip-build")) {
    run("node", [join(ROOT, "scripts", "build.mjs")], { cwd: ROOT, stdio: "inherit" });
  }

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { mode: 0o700 });
  mkdirSync(TARBALLS, { mode: 0o700 });
  mkdirSync(NPM_APP, { mode: 0o700 });
  mkdirSync(PNPM_APP, { mode: 0o700 });

  const tarballs = packAll();
  const fileSpecs = Object.fromEntries([...tarballs].map(([name, file]) => [name, `file:${file}`]));
  // The runtime probe below imports every production package from the consumer-app root. Declare
  // each directly so pnpm's strict node_modules layout proves the same contract as npm instead of
  // relying on npm's incidental transitive hoisting. Overrides still pin all transitive edges to
  // this exact sibling tarball set.
  const dependencies = { ...fileSpecs };

  // `overrides` (npm) / `pnpm.overrides` pin every transitive @shellx-motion/* to the sibling
  // tarball; without them the package managers would look for 0.1.0 on the registry.
  writeFileSync(
    join(NPM_APP, "package.json"),
    `${JSON.stringify({ name: "motion-verify-npm", version: "0.0.0", private: true, type: "module", dependencies, overrides: fileSpecs }, null, 2)}\n`
  );
  writeFileSync(
    join(PNPM_APP, "package.json"),
    `${JSON.stringify({ name: "motion-verify-pnpm", version: "0.0.0", private: true, type: "module", dependencies, pnpm: { overrides: fileSpecs } }, null, 2)}\n`
  );

  runNpm(["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: NPM_APP, stdio: "inherit" });
  runPnpm(["install", "--ignore-workspace", "--no-frozen-lockfile"], { cwd: PNPM_APP, stdio: "inherit" });

  cpSync(FIXTURE, join(NPM_APP, "lower-third"), { recursive: true });
  cpSync(FIXTURE, join(PNPM_APP, "lower-third"), { recursive: true });

  console.log("\nchecks:");

  // packed-files: the tarballs contain exactly the files they should, and nothing else.
  checkPackedFiles(tarballs);

  const runtimeExportContract = collectPackedRuntimeExportContract();

  // packed-manifest: what shipped is the built shape, with no workspace: specifiers left.
  const core = JSON.parse(readFileSync(join(NPM_APP, "node_modules", "@shellx-motion", "core", "package.json"), "utf8"));
  const cli = JSON.parse(readFileSync(join(NPM_APP, "node_modules", "@shellx-motion", "cli", "package.json"), "utf8"));
  const debugServer = JSON.parse(readFileSync(join(NPM_APP, "node_modules", "@shellx-motion", "debug-server", "package.json"), "utf8"));
  const coreExport = core.exports?.["."];
  const leftovers = [cli, debugServer].flatMap((manifest) => Object.entries(manifest.dependencies ?? {}).filter(([, spec]) => String(spec).startsWith("workspace:")));
  record(
    "packed-manifest",
    typeof coreExport === "object" && coreExport.default?.startsWith("./dist/") && leftovers.length === 0,
    leftovers.length > 0
      ? `packed CLI still carries workspace: specifiers: ${JSON.stringify(leftovers)}`
      : `@shellx-motion/core exports "." -> ${JSON.stringify(coreExport)}`
  );
  checkPackedRuntimeExportMaps("packed-runtime-export-maps", NPM_APP, runtimeExportContract);
  expectPackedRuntimeImports("packed-runtime-imports-npm", NPM_APP, runtimeExportContract);
  expectPackedRuntimeImports("packed-runtime-imports-pnpm", PNPM_APP, runtimeExportContract);

  // built-entry: the built JavaScript and its cross-package imports actually run.
  expectValidate(
    "built-entry",
    process.execPath,
    [join(NPM_APP, "node_modules", "@shellx-motion", "cli", "dist", "main.js"), "validate", "lower-third"],
    NPM_APP
  );

  expectValidate("npm-bin", join(NPM_APP, "node_modules", ".bin", "shellx-motion"), ["validate", "lower-third"], NPM_APP);
  expectValidate("pnpm-bin", join(PNPM_APP, "node_modules", ".bin", "shellx-motion"), ["validate", "lower-third"], PNPM_APP);
  expectJsonPlan(
    "installed-version-npm",
    join(NPM_APP, "node_modules", ".bin", "shellx-motion"),
    ["--version"],
    NPM_APP,
    (result) =>
      result?.ok === true &&
      result.command === "version" &&
      result.name === "@shellx-motion/cli" &&
      result.version === cli.version
  );
  expectJsonPlan(
    "installed-version-pnpm",
    join(PNPM_APP, "node_modules", ".bin", "shellx-motion"),
    ["--version"],
    PNPM_APP,
    (result) =>
      result?.ok === true &&
      result.command === "version" &&
      result.name === "@shellx-motion/cli" &&
      result.version === cli.version
  );
  for (const [shape, appRoot] of [["npm", NPM_APP], ["pnpm", PNPM_APP]]) {
    const bin = join(appRoot, "node_modules", ".bin", "shellx-motion");
    expectJsonPlan(`installed-runtime-probe-${shape}`, bin, ["runtime-probe"], appRoot, isUnmanagedInstalledProbe);
    expectJsonPlan(`installed-catalog-${shape}`, bin, ["connector", "catalog"], appRoot, isInstalledCatalog);
    expectJsonPlan(`installed-describe-${shape}`, bin, ["connector", "describe", "connector.template-to-cut@1"], appRoot, isAdmittedDescription);
  }
  expectJsonPlan(
    "installed-doctor-npm",
    join(NPM_APP, "node_modules", ".bin", "shellx-motion"),
    ["doctor", "--json"],
    NPM_APP,
    (result) =>
      result?.ok === true &&
      result.command === "doctor" &&
      Array.isArray(result.checks) &&
      result.requirements &&
      result.gpu
  );
  expectJsonPlan(
    "installed-doctor-pnpm",
    join(PNPM_APP, "node_modules", ".bin", "shellx-motion"),
    ["doctor", "--json"],
    PNPM_APP,
    (result) =>
      result?.ok === true &&
      result.command === "doctor" &&
      Array.isArray(result.checks) &&
      result.requirements &&
      result.gpu
  );
  expectJsonPlan(
    "workbench-bin-npm",
    join(NPM_APP, "node_modules", ".bin", "shellx-motion-workbench"),
    ["--dry-run"],
    NPM_APP,
    (plan) => plan?.ok === true && plan.persistentAccess === true && plan.openWorkbench === true && plan.grantedTier === "write_local"
  );
  expectJsonPlan(
    "workbench-bin-pnpm",
    join(PNPM_APP, "node_modules", ".bin", "shellx-motion-workbench"),
    ["--dry-run"],
    PNPM_APP,
    (plan) => plan?.ok === true && plan.persistentAccess === true && plan.openWorkbench === true && plan.grantedTier === "write_local"
  );
  expectInstalledWorkbench("installed-ui", NPM_APP);
  expectStoppedMcpBridge("mcp-bridge", join(NPM_APP, "node_modules", ".bin", "shellx-motion-mcp"), NPM_APP);

  const failed = results.filter((entry) => !entry.ok);
  if (failed.length === 0) {
    console.log("\nverify-install: PASS — packed, installed, and run from built JavaScript.");
    return;
  }

  console.error(`\nverify-install: FAIL — ${failed.map((entry) => entry.name).join(", ")}`);
  if (failed.some((entry) => entry.name === "npm-bin") && !failed.some((entry) => entry.name === "built-entry")) {
    console.error(
      [
        "",
        "  The built artifact itself is sound (built-entry passed); the failure is the entry",
        "  guard in the bin modules:",
        "",
        "    packages/cli/src/main.ts          basename(fileURLToPath(import.meta.url)) === basename(process.argv[1] ?? '')",
        "    packages/debug-server/src/cli.ts  same expression",
        "",
        "  npm exposes a bin as a symlink, so process.argv[1] stays .../node_modules/.bin/<name>",
        "  while import.meta.url is realpath-resolved to .../dist/main.js. The basenames differ,",
        "  the guard misses, and the CLI exits 0 having done nothing. pnpm writes a shell shim",
        "  with the real path, which is why pnpm-bin passes and npm-bin does not.",
        "",
        "  Fix (one line per file, in src — owned by the CLI/debug-server authors):",
        "    if (import.meta.filename === realpathSync(process.argv[1] ?? '')) {",
        ""
      ].join("\n")
    );
  }
  process.exit(1);
}

main();
