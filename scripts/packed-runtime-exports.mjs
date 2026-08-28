/**
 * scripts/packed-runtime-exports.mjs — derive the export surface an installed workspace needs.
 *
 * A source manifest intentionally exposes TypeScript entry points to make workspace testing work
 * without a build. `publishConfig.exports` is different: it must expose only the built entries a
 * packed consumer can legitimately reach. Public entries (`.` and non-internal subpaths) are
 * package API by declaration. Internal entries are package implementation details, so an installed
 * subpath exists only while a shipping workspace module imports that *exact* specifier or the
 * package explicitly declares it as a trusted external-host entry under
 * `shellxMotion.hostInternalExports`.
 *
 * This derives the distinction from the shared source convention and TypeScript AST import walker;
 * it is deliberately not a list of presently-known internal paths. In particular, a source module
 * can itself be shipping while its only consumer remains under `unadopted/`, which must not make
 * the source entry exportable from a tarball.
 *
 * CALLERS: `scripts/verify-install.mjs`, focused package-export tests.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { discoverPackages } from "./packed-files-gate.mjs";
import { collectModuleSpecifiers, isNonShippingSource } from "./source-modules.mjs";

function listTypeScriptSources(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listTypeScriptSources(path));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * Collect bare package specifiers imported by shipping workspace source modules.
 *
 * Test-support and `unadopted/**` consumers are deliberately excluded. They may import a source
 * export during source tests, but no installed runtime may depend on it.
 *
 * @param {Array<{name: string, dir: string, manifest: any}>} [packages]
 * @returns {Set<string>}
 */
export function collectShippingWorkspaceImportSpecifiers(packages = discoverPackages()) {
  const specifiers = new Set();
  for (const pkg of packages) {
    for (const sourcePath of listTypeScriptSources(join(pkg.dir, "src"))) {
      if (isNonShippingSource(relative(pkg.dir, sourcePath))) continue;
      const sourceFile = ts.createSourceFile(
        sourcePath,
        readFileSync(sourcePath, "utf8"),
        ts.ScriptTarget.Latest,
        false,
        sourcePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      for (const literal of collectModuleSpecifiers(sourceFile)) {
        if (!literal.text.startsWith(".")) specifiers.add(literal.text);
      }
    }
  }
  return specifiers;
}

function builtTargetsForSourceExport(sourceTarget) {
  if (!sourceTarget.startsWith("./src/") || !/\.tsx?$/.test(sourceTarget)) {
    throw new Error(`packed runtime exports: source export must target ./src/*.ts, received ${JSON.stringify(sourceTarget)}.`);
  }
  const stem = sourceTarget.slice("./src/".length).replace(/\.tsx?$/, "");
  return {
    default: `./dist/${stem}.js`,
    types: `./dist/${stem}.d.ts`
  };
}

function isInternalSubpath(subpath) {
  return subpath.startsWith("./internal/");
}

function hostInternalExports(pkg, exportsField) {
  const metadata = pkg.manifest.shellxMotion;
  if (metadata === undefined) return new Set();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(`packed runtime exports: ${pkg.name} shellxMotion metadata must be an object.`);
  const declared = metadata.hostInternalExports;
  if (declared === undefined) return new Set();
  if (!Array.isArray(declared) || declared.some((entry) => typeof entry !== "string") || new Set(declared).size !== declared.length) throw new Error(`packed runtime exports: ${pkg.name} shellxMotion.hostInternalExports must be a unique string array.`);
  for (const subpath of declared) {
    if (!isInternalSubpath(subpath) || !Object.hasOwn(exportsField, subpath)) throw new Error(`packed runtime exports: ${pkg.name} host internal export ${JSON.stringify(subpath)} must identify a declared ./internal/ subpath.`);
    const sourceTarget = exportsField[subpath];
    if (typeof sourceTarget !== "string") throw new Error(`packed runtime exports: ${pkg.name} host internal export ${subpath} must resolve to a string source target.`);
    if (isNonShippingSource(sourceTarget)) throw new Error(`packed runtime exports: ${pkg.name} host internal export ${subpath} resolves to nonshipping source ${sourceTarget}.`);
  }
  return new Set(declared);
}

/**
 * Build the installed-export contract from source manifests and actual shipping consumers.
 *
 * A source target marked nonshipping must have no shipping workspace consumer. The package root
 * and named public subpaths are runtime by declaration. An internal subpath becomes runtime only
 * when at least one shipping workspace module imports its exact package specifier.
 *
 * @param {Array<{name: string, dir: string, manifest: any}>} [packages]
 * @returns {{runtime: Array<{packageName: string, subpath: string, specifier: string, sourceTarget: string, targets: {default: string, types: string}}>, privateEntries: Array<{packageName: string, subpath: string, specifier: string, sourceTarget: string, targets: {default: string, types: string}}>}}
 */
export function collectPackedRuntimeExportContract(packages = discoverPackages()) {
  const runtime = [];
  const privateEntries = [];
  const shippingImports = collectShippingWorkspaceImportSpecifiers(packages);

  for (const pkg of packages) {
    const exportsField = pkg.manifest.exports;
    if (!exportsField) continue;
    if (typeof exportsField !== "object" || Array.isArray(exportsField)) {
      throw new Error(`packed runtime exports: ${pkg.name} exports must be an object to verify packed runtime exports.`);
    }

    const declaredHostEntries = hostInternalExports(pkg, exportsField);
    for (const [subpath, sourceTarget] of Object.entries(exportsField)) {
      if (typeof sourceTarget !== "string") {
        throw new Error(`packed runtime exports: ${pkg.name} export ${subpath} must be a string source target.`);
      }
      const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, "")}`;
      const sourceIsNonShipping = isNonShippingSource(sourceTarget);
      if (sourceIsNonShipping && shippingImports.has(specifier)) {
        throw new Error(`packed runtime exports: shipping workspace import ${specifier} resolves to nonshipping source export ${sourceTarget}.`);
      }
      const entry = {
        packageName: pkg.name,
        subpath,
        specifier,
        sourceTarget,
        targets: builtTargetsForSourceExport(sourceTarget)
      };
      if (
        !sourceIsNonShipping &&
        (!isInternalSubpath(subpath) || shippingImports.has(specifier) || declaredHostEntries.has(subpath))
      ) {
        runtime.push(entry);
      } else {
        privateEntries.push(entry);
      }
    }
  }

  return { runtime, privateEntries };
}
