#!/usr/bin/env node
/**
 * Fail when a tracked source file imports a path that git does not track.
 *
 * Working-tree builds can resolve modules absent from a selected Git revision. Compare imports
 * and target files within the same revision so a clean checkout has a complete dependency graph.
 * Every relative import in a tracked file must resolve to another tracked file.
 *
 * Dependencies: git (for the tracked-file set), typescript (parser), scripts/public/source-modules.mjs.
 * No network, no build, no install — safe in a pre-commit hook.
 *
 * Usage: node scripts/public/tracked-import-gate.mjs [revision]     (default: HEAD)
 * Exit 0 when every relative import in the revision resolves inside that same revision; exit 1 with
 * the offending pairs. Uncommitted work is deliberately invisible to it — that is the point.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectModuleSpecifiers } from "./source-modules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const REVISION = process.argv[2] ?? "HEAD";
const FILESYSTEM_EXCLUDED_DIRECTORIES = new Set([".git", ".scratch", "coverage", "dist", "node_modules"]);

function hasRepositorySnapshot() {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return resolve(topLevel) === ROOT;
  } catch {
    return false;
  }
}

/**
 * A downloaded source archive deliberately has no .git directory. In that environment there is no
 * revision to compare against, but the archive must still be able to prove that its own relative
 * imports resolve. Ignore only generated dependency/build/evidence directories so an install or a
 * prior test run cannot make a missing published module appear present.
 */
function filesystemFiles() {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && FILESYSTEM_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative(ROOT, absolute).replaceAll("\\", "/"));
    }
  }
  visit(ROOT);
  return new Set(files);
}

/**
 * Every file in `REVISION`, as repo-relative path -> blob sha.
 *
 * Both the path set and file contents come from the selected revision. Mixing revision paths with
 * working-tree contents would report unrelated uncommitted work as a revision failure.
 */
function revisionBlobs() {
  const output = execFileSync("git", ["ls-tree", "-r", "-z", REVISION], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const blobs = new Map();
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    // "<mode> <type> <sha>\t<path>"
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [, type, sha] = entry.slice(0, tab).split(/\s+/);
    if (type === "blob") blobs.set(entry.slice(tab + 1), sha);
  }
  return blobs;
}

/**
 * Contents of many blobs in one `git cat-file --batch` call.
 *
 * One subprocess rather than one per file: this repo has ~600 tracked sources and a pre-commit hook
 * has to stay fast enough that nobody is tempted to skip it.
 */
function readBlobs(shas) {
  if (shas.length === 0) return new Map();
  const stdout = execFileSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
    // Must be a Buffer, not a string: `encoding: "buffer"` selects the OUTPUT encoding, and node
    // would otherwise try to decode a string `input` with it and throw ERR_UNKNOWN_ENCODING.
    input: Buffer.from(`${shas.join("\n")}\n`, "utf8"),
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
  const contents = new Map();
  let offset = 0;
  while (offset < stdout.length) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline === -1) break;
    // "<sha> <type> <size>"
    const [sha, , sizeText] = stdout.toString("utf8", offset, newline).split(" ");
    const size = Number(sizeText);
    if (!Number.isFinite(size)) break;
    const start = newline + 1;
    contents.set(sha, stdout.toString("utf8", start, start + size));
    offset = start + size + 1; // trailing newline after each record
  }
  return contents;
}

/**
 * Resolve a relative specifier to a repo-relative path INSIDE the revision, covering the spellings
 * this tree uses: extensionless, the NodeNext `.js` spelling that means `.ts`, and a directory
 * meaning its `index.ts`.
 *
 * Resolution uses the revision's own path set, never the filesystem. Returns the resolved path when the
 * revision contains one, otherwise the most likely intended path so the report can name it.
 */
function resolveInRevision(fromPath, specifier, paths) {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [];
  const jsMatch = /\.(js|jsx|mjs|cjs)$/.exec(base);
  if (jsMatch) candidates.push(base.slice(0, -jsMatch[0].length) + (jsMatch[1] === "jsx" ? ".tsx" : ".ts"));
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  candidates.push(base);
  const resolved = candidates.find((candidate) => paths.has(candidate));
  return { resolved: resolved ?? null, expected: candidates[0] };
}

const repositorySnapshot = hasRepositorySnapshot();
if (!repositorySnapshot && REVISION !== "HEAD") {
  console.error(`Cannot inspect revision ${REVISION} because this source archive has no Git metadata.`);
  process.exit(1);
}
const blobs = repositorySnapshot ? revisionBlobs() : null;
const paths = repositorySnapshot ? new Set(blobs.keys()) : filesystemFiles();
const sources = [...paths].filter((path) => /\.tsx?$/.test(path) && !path.startsWith("node_modules/"));
const contents = repositorySnapshot ? readBlobs([...new Set(sources.map((path) => blobs.get(path)))]) : null;
const snapshotLabel = repositorySnapshot ? REVISION : "published filesystem snapshot";

const violations = [];
for (const path of sources) {
  const text = repositorySnapshot
    ? contents.get(blobs.get(path))
    : readFileSync(join(ROOT, ...path.split("/")), "utf8");
  if (text === undefined) continue;
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ESNext,
    false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  for (const literal of collectModuleSpecifiers(sourceFile)) {
    if (!literal.text.startsWith(".")) continue;
    const { resolved, expected } = resolveInRevision(path, literal.text, paths);
    if (resolved) continue;
    violations.push({ importer: path, specifier: literal.text, target: expected });
  }
}

if (violations.length > 0) {
  console.error(`In ${snapshotLabel}, files importing paths that snapshot does not contain (${violations.length}):`);
  for (const violation of violations) {
    console.error(`  ${violation.importer}`);
    console.error(`    imports "${violation.specifier}" -> ${violation.target} (absent from ${snapshotLabel})`);
  }
  console.error("");
  if (repositorySnapshot) {
    console.error(`A clean checkout of ${REVISION} does not compile. Your working tree probably does, which`);
    console.error("is why tsc and the test suites pass — they read the tree, not the commit.");
    console.error("");
    console.error("Usual cause: `git commit -- <paths>` committed the working-tree state of a shared file");
    console.error("while the sibling module it now imports belongs to a change that is not committed yet.");
    console.error("Fix by committing the missing file (ask its owner if it is not yours), or by reverting");
    console.error("the import from the tracked file. Do not resolve this with `git reset`/`checkout` in a");
    console.error("shared tree — that destroys the other author's uncommitted work.");
  } else {
    console.error("The published source archive is incomplete: add the missing module or remove its import,");
    console.error("then regenerate the archive from the canonical public-export workflow.");
  }
  process.exit(1);
}

console.log(`tracked-import: OK — ${snapshotLabel}: ${sources.length} source file(s), every relative import resolves inside the same snapshot.`);
