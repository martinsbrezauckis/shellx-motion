import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hashFile } from "@shellx-motion/core";

const execFileAsync = promisify(execFile);
const SOURCE_ID_RX = /^[a-f0-9]{40}$/;
const SHA256_RX = /^[a-f0-9]{64}$/;
export const GPU_QUALIFICATION_SOURCE_BUNDLE_NAME = "source.bundle" as const;

export interface GpuQualificationSourceIdentity {
  readonly gitCommit: string;
  readonly gitTree: string;
  readonly version: string;
  readonly gitDirty: false;
}

/** Immutable private Git bundle generated from the clean candidate HEAD before a GPU session opens. */
export interface GpuQualificationSourceBundle {
  readonly path: typeof GPU_QUALIFICATION_SOURCE_BUNDLE_NAME;
  readonly mediaType: "application/vnd.git.bundle";
  readonly bytes: number;
  readonly sha256: string;
  readonly gitCommit: string;
  readonly gitTree: string;
  readonly version: string;
}

/** Minimal retained-root contract: Core controls the concrete native identity and authority. */
export interface GpuQualificationSourceBundleRoot {
  readonly path: string;
  assertCurrent(): Promise<void>;
}

/** Collects the release source identity and rejects dirty/ambiguous source before a native proof starts. */
export async function collectGpuQualificationSourceIdentity(sourceDir: string): Promise<GpuQualificationSourceIdentity> {
  const root = resolve(sourceDir);
  const [commit, tree, status, packageText] = await Promise.all([
    git(root, ["rev-parse", "HEAD^{commit}"]), git(root, ["rev-parse", "HEAD^{tree}"]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), readFile(join(root, "package.json"), "utf8")
  ]);
  if (!SOURCE_ID_RX.test(commit) || !SOURCE_ID_RX.test(tree)) throw new Error("GPU qualification source identity must contain full commit and tree hashes.");
  if (status.trim()) throw new Error("GPU qualification requires a clean source tree before and after the native render.");
  let version: unknown;
  try { version = JSON.parse(packageText).version; } catch { throw new Error("GPU qualification source package.json is not valid JSON."); }
  if (typeof version !== "string" || !version.trim()) throw new Error("GPU qualification source package.json must contain a version.");
  return Object.freeze({ gitCommit: commit, gitTree: tree, version: version.trim(), gitDirty: false as const });
}

/** Validates source-bound evidence supplied to the immutable raw-bundle writer. */
export function assertSameCleanSource(before: GpuQualificationSourceIdentity, after: GpuQualificationSourceIdentity): void {
  for (const source of [before, after]) {
    if (!SOURCE_ID_RX.test(source.gitCommit) || !SOURCE_ID_RX.test(source.gitTree) || !source.version.trim() || source.gitDirty !== false) {
      throw new Error("GPU qualification source snapshots must contain a clean full commit/tree/version identity.");
    }
  }
  if (before.gitCommit !== after.gitCommit || before.gitTree !== after.gitTree || before.version !== after.version) throw new Error("GPU qualification source changed during the native render.");
}

/** Creates the exact `source.bundle` from a clean HEAD before the GPU session starts. */
export async function createGpuQualificationSourceBundle(
  sourceDir: string,
  expectedSource: GpuQualificationSourceIdentity,
  outputRoot: GpuQualificationSourceBundleRoot
): Promise<GpuQualificationSourceBundle> {
  assertSameCleanSource(expectedSource, await collectGpuQualificationSourceIdentity(sourceDir));
  await outputRoot.assertCurrent();
  const path = join(outputRoot.path, GPU_QUALIFICATION_SOURCE_BUNDLE_NAME);
  await assertAbsentRegularPath(path);
  await git(resolve(sourceDir), ["bundle", "create", path, "HEAD"]);
  const actualSource = await collectGpuQualificationSourceIdentity(sourceDir);
  assertSameCleanSource(expectedSource, actualSource);
  return await readGpuQualificationSourceBundle(actualSource, outputRoot);
}

/** Re-reads the private bundle after rendering and rejects any source/bundle substitution. */
export async function readGpuQualificationSourceBundle(
  source: GpuQualificationSourceIdentity,
  outputRoot: GpuQualificationSourceBundleRoot
): Promise<GpuQualificationSourceBundle> {
  assertSameCleanSource(source, source);
  await outputRoot.assertCurrent();
  const path = join(outputRoot.path, GPU_QUALIFICATION_SOURCE_BUNDLE_NAME);
  const facts = await lstat(path);
  if (!facts.isFile() || facts.isSymbolicLink() || facts.size < 1) throw new Error("GPU qualification source.bundle must be a nonempty regular file.");
  return Object.freeze({
    path: GPU_QUALIFICATION_SOURCE_BUNDLE_NAME,
    mediaType: "application/vnd.git.bundle" as const,
    bytes: facts.size,
    sha256: await hashFile(path),
    gitCommit: source.gitCommit,
    gitTree: source.gitTree,
    version: source.version
  });
}

/** Ensures the post-render source bundle remains byte-identical to the pre-render bundle. */
export function assertSameGpuQualificationSourceBundle(before: GpuQualificationSourceBundle, after: GpuQualificationSourceBundle): void {
  for (const bundle of [before, after]) {
    if (bundle.path !== GPU_QUALIFICATION_SOURCE_BUNDLE_NAME || bundle.mediaType !== "application/vnd.git.bundle" || !Number.isSafeInteger(bundle.bytes) || bundle.bytes < 1 || !SHA256_RX.test(bundle.sha256) || !SOURCE_ID_RX.test(bundle.gitCommit) || !SOURCE_ID_RX.test(bundle.gitTree) || !bundle.version.trim()) {
      throw new Error("GPU qualification source.bundle facts are incomplete.");
    }
  }
  if (before.bytes !== after.bytes || before.sha256 !== after.sha256 || before.gitCommit !== after.gitCommit || before.gitTree !== after.gitTree || before.version !== after.version) throw new Error("GPU qualification source.bundle changed during the native render.");
}

async function assertAbsentRegularPath(path: string): Promise<void> {
  await lstat(path).then(() => { throw new Error("GPU qualification source.bundle already exists in the private output root."); }, (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function git(sourceDir: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", sourceDir, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
