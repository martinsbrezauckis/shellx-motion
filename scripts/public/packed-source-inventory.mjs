/** Closed, portable inventory for source files copied or packed outside TypeScript emit. */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const inventory = JSON.parse(readFileSync(new URL("./packed-source-inventory.json", import.meta.url), "utf8"));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIRECTORY_ROOTS = {
  "@shellx-motion/core": ["assets"],
  "@shellx-motion/debug-server": ["bin", "workbench"]
};
const FILE_ROOTS = {
  "@shellx-motion/renderer-browser": ["bin/enforced-untrusted-browser-launcher.mjs"],
  "@shellx-motion/renderer-ffmpeg": ["bin/enforced-untrusted-ffmpeg-launcher.mjs"]
};
// npm can include these root metadata files independently of manifest.files.
const PACKER_METADATA = /^(?:readme|licen[sc]e|copying|changelog|history)(?:\..*)?$/i;

function validPath(path) {
  return typeof path === "string" && path.length > 0 && !path.includes("\\") &&
    !path.includes("\0") && !path.startsWith("/") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Validate every component without following links; compare the full leaf set in both directions. */
export function inspectClosedFiles(base, roots, approved) {
  const problems = [];
  try {
    if (!lstatSync(base).isDirectory() || realpathSync(base) !== resolve(base)) {
      return ["source base is not a physical directory"];
    }
  } catch { return ["source base is not a physical directory"]; }
  const allowed = new Set();
  for (const path of approved) {
    if (!validPath(path) || !roots.some((root) => path === root || path.startsWith(`${root}/`))) {
      problems.push(`inventory has an invalid or out-of-class path: ${String(path)}`);
    } else if (allowed.has(path)) {
      problems.push(`inventory has a duplicate path: ${path}`);
    } else allowed.add(path);
  }
  if (problems.length) return problems;

  const seen = new Set();
  const visit = (path, directory) => {
    let facts;
    try { facts = lstatSync(join(base, path)); }
    catch { problems.push(`missing source path: ${path}`); return; }
    if (facts.isSymbolicLink() || !(directory ? facts.isDirectory() : facts.isFile())) {
      problems.push(`source path is not a regular ${directory ? "directory" : "file"}: ${path}`);
      return;
    }
    if (!directory) { seen.add(path); return; }
    for (const entry of readdirSync(join(base, path)).sort()) {
      const child = `${path}/${entry}`;
      let childFacts;
      try { childFacts = lstatSync(join(base, child)); }
      catch { problems.push(`source path vanished: ${child}`); continue; }
      if (childFacts.isDirectory()) visit(child, true);
      else if (childFacts.isFile()) seen.add(child);
      else problems.push(`source path is not a regular file or directory: ${child}`);
    }
  };
  for (const root of roots) {
    if (!validPath(root)) { problems.push(`invalid source root: ${String(root)}`); continue; }
    // A file-class root may have ancestors that are links even when its leaf is regular.
    const parts = root.split("/");
    let safe = true;
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      try {
        if (!lstatSync(join(base, ancestor)).isDirectory()) {
          problems.push(`source ancestor is not a regular directory: ${ancestor}`); safe = false; break;
        }
      } catch { problems.push(`missing source ancestor: ${ancestor}`); safe = false; break; }
    }
    if (safe) visit(root, !approved.includes(root));
  }
  for (const path of seen) if (!allowed.has(path)) problems.push(`unlisted source file: ${path}`);
  for (const path of allowed) if (!seen.has(path)) problems.push(`missing approved source file: ${path}`);
  return problems;
}

/** Copy only approved regular files after checking the complete source tree. */
export function copyClosedFiles(base, destination, roots, approved) {
  const problems = inspectClosedFiles(base, roots, approved);
  if (problems.length) throw new Error(`closed source copy failed:\n${problems.join("\n")}`);
  for (const path of approved) {
    const output = join(destination, path);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(base, path), output);
  }
}

export function sourceInventory(pkg, { includeDocs = pkg.name === "@shellx-motion/debug-server" } = {}) {
  const entries = inventory.packages[pkg.name] ?? [];
  const directoryRoots = DIRECTORY_ROOTS[pkg.name] ?? [];
  const fileRoots = FILE_ROOTS[pkg.name] ?? [];
  const roots = [...directoryRoots, ...fileRoots];
  const manifestEntries = pkg.manifest.files;
  const declared = new Set(["dist", ...roots]);
  const problems = [];
  if (!Array.isArray(manifestEntries) || !manifestEntries.length) {
    problems.push(`${pkg.name}: manifest declares no files allowlist`);
  } else {
    for (const entry of manifestEntries) {
      if (!validPath(entry) || !declared.has(entry)) problems.push(`${pkg.name}: undeclared manifest files entry: ${String(entry)}`);
    }
    for (const entry of declared) if (!manifestEntries.includes(entry)) problems.push(`${pkg.name}: missing manifest files entry: ${entry}`);
    if (new Set(manifestEntries).size !== manifestEntries.length) problems.push(`${pkg.name}: duplicate manifest files entry`);
  }
  problems.push(...inspectClosedFiles(pkg.dir, roots, entries).map((p) => `${pkg.name}: ${p}`));
  const metadata = inventory.packageMetadata[pkg.name] ?? [];
  const metadataProblems = inspectClosedFiles(pkg.dir, metadata, metadata);
  for (const path of metadata) {
    if (!validPath(path) || path.includes("/") || !PACKER_METADATA.test(path)) {
      metadataProblems.push(`invalid package metadata entry: ${String(path)}`);
    }
  }
  // The physical-base check must succeed before a root listing can follow its path.
  if (!metadataProblems.length) for (const name of readdirSync(pkg.dir)) {
    if (PACKER_METADATA.test(name) && !metadata.includes(name)) metadataProblems.push(`unlisted package metadata: ${name}`);
  }
  problems.push(...metadataProblems.map((p) => `${pkg.name}: ${p}`));
  const optionalMetadata = inventory.workspaceMetadata;
  problems.push(...inspectClosedFiles(ROOT, optionalMetadata, optionalMetadata).map((p) => `${pkg.name}: workspace ${p}`));
  if (includeDocs) problems.push(...inspectClosedFiles(ROOT, ["docs/public"], inventory.docsPublic.map((p) => `docs/public/${p}`)).map((p) => `${pkg.name}: ${p}`));
  return { entries, metadata, optionalMetadata, docs: inventory.docsPublic.map((p) => `docs/public/${p}`), problems };
}

export function assertSourceInventory(packages) {
  const problems = packages.flatMap((pkg) => sourceInventory(pkg).problems);
  if (problems.length) throw new Error(`packed source inventory failed:\n${problems.join("\n")}`);
}
