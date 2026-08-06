import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CliResult } from "../packages/cli/src/main";

/** The environment variable that names where a finished real-workflow demo is handed to a human. */
export const WINDOWS_DOWNLOADS_ENV = "SHELLX_MOTION_WINDOWS_DOWNLOADS";

/**
 * Where `copyToWindowsDownloads` puts a finished demo, read from the environment.
 *
 * THERE IS DELIBERATELY NO DEFAULT. A machine-specific mounted-drive path would disclose a local
 * development layout and fail on every host that does not share it,
 * and it was wrong on every machine that is not that one: on plain Linux or macOS the recursive
 * `mkdir` silently created a `/mnt/c/...` tree and dropped the demo somewhere nobody would look.
 *
 * A portable default was considered and rejected. `~/Downloads` guesses at a human's habits and
 * writes outside the repository, which contradicts this project's single-location rule (see
 * `.gitignore`: everything produced lives inside the repo, untracked); a repo-relative default
 * makes the copy a duplicate of the render output sitting two directories away, which is not what
 * the step is for. "Where do you want to watch this?" has no correct default, so it is asked.
 *
 * @param env Environment to read; injectable so the failure path is testable without mutating the
 *            process. Defaults to `process.env`.
 * @returns The destination directory, exactly as configured. Relative values are refused rather
 *          than resolved: a demo landing somewhere different depending on which directory the
 *          script was invoked from is the same class of surprise this finding is about.
 * @throws If the variable is unset, empty, or not an absolute path.
 */
export function resolveWindowsDownloadsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[WINDOWS_DOWNLOADS_ENV]?.trim();
  if (!configured) {
    throw new Error(
      `${WINDOWS_DOWNLOADS_ENV} is not set. Real-workflow scripts copy the finished demo to a folder a ` +
      `human actually opens, and there is no portable default for that. Set it to an absolute path, ` +
      `e.g. ${WINDOWS_DOWNLOADS_ENV}=/mnt/c/Users/<you>/Downloads/shellx-motion-real-workflows under WSL.`
    );
  }
  if (!isAbsolute(configured)) {
    throw new Error(`${WINDOWS_DOWNLOADS_ENV} must be an absolute path; got ${configured}.`);
  }
  return configured;
}

export type JsonRecord = Record<string, unknown>;

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJsonObjectFile(path: string, label: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return readRecord(parsed, label);
}

export async function assertMp4Container(path: string, label: string): Promise<{ bytes: number }> {
  const file = await readFile(path);
  assert(file.length > 16, `${label}: MP4 output is too small`);
  assert.equal(file.subarray(4, 8).toString("ascii"), "ftyp", `${label}: output is not an MP4 container`);
  return { bytes: file.length };
}

/**
 * Copy a finished demo to the operator-supplied review folder.
 *
 * Resolution happens per call rather than once at module load, because three real-workflow scripts
 * and `template-product-pack-proof.ts` import this module for its JSON and quality helpers and
 * never copy anything. A module-scope resolve would make an unset `SHELLX_MOTION_WINDOWS_DOWNLOADS`
 * fail their imports over a step they do not run.
 */
export async function copyToWindowsDownloads(sourcePath: string, fileName: string): Promise<{ path: string; bytes: number }> {
  const root = resolveWindowsDownloadsRoot();
  await mkdir(root, { recursive: true });
  const targetPath = join(root, fileName);
  await copyFile(sourcePath, targetPath);
  const copied = await stat(targetPath);
  assert(copied.size > 0, `copied Windows Downloads media is empty: ${targetPath}`);
  return { path: targetPath, bytes: copied.size };
}

export function assertNoCriticalQualityWarnings(warnings: unknown, label: string): void {
  const values = Array.isArray(warnings) ? warnings.map(String) : [];
  const critical = values.filter((warning) =>
    /Rendered video is .*product review|blank|visually empty|static/i.test(warning)
  );
  assert.equal(critical.length, 0, `${label} has critical quality warnings: ${critical.join("; ")}`);
}

export async function runQualityGate(input: {
  runCli: (argv: string[], options?: { scratchRoot?: string }) => Promise<CliResult>;
  mediaPath: string;
  packageDir: string;
  scratchRoot: string;
  atMs: number;
  width: number;
  height: number;
  label: string;
}): Promise<CliResult> {
  const quality = await input.runCli([
    "quality-check",
    input.mediaPath,
    "--at-ms",
    String(input.atMs),
    "--expect-width",
    String(input.width),
    "--expect-height",
    String(input.height),
    "--min-bright-pixels",
    "500",
    "--min-edge-pixels",
    "500",
    "--min-non-transparent-pixels",
    "1000",
    "--preview-package",
    input.packageDir,
    "--preview-lane",
    "browser",
    "--max-changed-pixels",
    String(input.width * input.height),
    "--max-mean-diff",
    "6",
    "--min-psnr-db",
    "30"
  ], { scratchRoot: input.scratchRoot });
  assert(quality.ok, `${input.label} quality-check failed: ${JSON.stringify(quality, null, 2)}`);
  assert.equal(readObjectField(quality, "command", `${input.label}.command`), "quality-check");
  const media = readRecord(readObjectField(quality, "media", `${input.label}.media`), `${input.label}.media`);
  assert.equal(readObjectField(media, "width", `${input.label}.media.width`), input.width);
  assert.equal(readObjectField(media, "height", `${input.label}.media.height`), input.height);
  return quality;
}

export function readRecord(value: unknown, label: string): JsonRecord {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value as JsonRecord;
}

export function readArray(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `expected ${label} array`);
  return value;
}

export function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}

export function readNumber(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `expected ${label} finite number, got ${typeof value}`);
  return value;
}

export function readObjectField(value: unknown, key: string, label: string): unknown {
  return Reflect.get(readRecord(value, label), key);
}

export function findArtifact(artifacts: unknown, role: string): JsonRecord {
  const artifact = readArray(artifacts, "artifacts")
    .map((candidate, index) => readRecord(candidate, `artifacts[${index}]`))
    .find((candidate) => candidate.role === role);
  assert(artifact, `missing artifact role: ${role}`);
  return artifact;
}
