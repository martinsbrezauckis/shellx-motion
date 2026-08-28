/**
 * Internal, Linux-only launch planning for parsers that consume an untrusted Motion package.
 *
 * This is intentionally not exported from the renderer barrel or accepted by an agent-facing
 * request.  A future trusted renderer host must create this plan inside an already-admitted job,
 * use the job-owned staging directory for every parser output, then validate/hash and atomically
 * publish that staged file itself.  Mounting a requested final-output parent into this namespace
 * would give an untrusted parser write access to unrelated user files, so it is never supported.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDataOnlyForUntrustedExecution,
  requireEnforcedLinuxBubblewrap,
  UntrustedMotionExecutionRefusal,
  type EnforcedLinuxBubblewrapServices,
  type LocalMotionJobContext,
  type MotionDocument
} from "@shellx-motion/core";
import type { FfmpegCommand } from "./index.js";
import {
  startStreamingFfmpegProcessWithTrustedLaunch,
  type StreamingFfmpegProcessFactory
} from "./streaming-process.js";

const LAUNCHER_FILE = "enforced-untrusted-ffmpeg-launcher.mjs";
const LAUNCHER_ENV = "SHELLX_MOTION_ENFORCED_FFMPEG_CONFIG";
// Keep the inherited runtime surface to shared-library locations plus the exact alternatives
// directory required to resolve this host's measured libblas symlink. The selected FFmpeg and
// FFprobe directories are added separately below after their identities are pinned. Do not bind
// broad host configuration (/etc), application trees (/opt), or administrative binaries.
const READ_ONLY_RUNTIME_ROOTS = ["/lib", "/lib64", "/usr/lib", "/usr/lib64", "/etc/alternatives"] as const;
const FORBIDDEN_STAGING_ROOTS = ["/dev", "/proc", "/sys"] as const;
const MAX_INPUT_ROOTS = 24;
const MAX_CONFIG_BYTES = 16_384;
const MAX_PARSER_ARGV = 1_025;
const MAX_PARSER_ARGV_BYTES = 65_536;

/** A trusted host supplies these facts only after its package and job ownership checks. */
export interface EnforcedUntrustedParserLaunchInput {
  motion: Pick<MotionDocument, "layers">;
  packageRoot: string;
  inputRoots: readonly string[];
  /** One already-created directory owned by the active governor job. No final output parent is allowed here. */
  stagingRoot: string;
  /** Canonical tool locations selected by the trusted host, never by package data. */
  ffmpegExecutable: string;
  ffprobeExecutable: string;
}

export interface EnforcedUntrustedParserLaunchServices extends EnforcedLinuxBubblewrapServices {}

export interface EnforcedUntrustedParserLaunchPlan {
  /** Canonical Node executable identified at the trusted host plan/launch boundary, never from caller data. */
  executablePath: string;
  /** Fixed repository-owned launcher passed as Node's first script argument. */
  launcherPath: string;
  /** Child-only JSON configuration consumed and deleted before Bubblewrap --clearenv. */
  env: Record<string, string>;
  /** Canonical tool identities accepted as the first shim argument. */
  allowedTools: readonly string[];
}

/** Facts a trusted host can use only while it holds this exact governor admission. */
export interface EnforcedUntrustedParserAdmittedInput extends Omit<EnforcedUntrustedParserLaunchInput, "stagingRoot"> {
  job: Pick<LocalMotionJobContext, "scratchRoot" | "signal">;
}

/**
 * Prepare the one internal parser-isolation contract. This does not start Bubblewrap and does
 * not itself constitute runtime evidence; an adopter must report evidence only after a successful
 * launch through the existing Core runtime-sandbox authority is extended for this exact scope.
 */
export async function prepareEnforcedUntrustedParserLaunch(
  input: EnforcedUntrustedParserLaunchInput,
  services: EnforcedUntrustedParserLaunchServices = {}
): Promise<EnforcedUntrustedParserLaunchPlan> {
  assertDataOnlyForUntrustedExecution(input.motion);
  if (input.inputRoots.length > MAX_INPUT_ROOTS) {
    throw refusal("sandbox_unavailable", `Enforced parser execution accepts at most ${MAX_INPUT_ROOTS} read-only input roots.`);
  }
  const capability = await requireEnforcedLinuxBubblewrap(services);
  const packageRoot = await canonicalDirectory(input.packageRoot, "Motion package root");
  const inputRoots = await canonicalDistinctDirectories(input.inputRoots, "parser input root");
  const stagingRoot = await canonicalPrivateStagingDirectory(input.stagingRoot);
  const node = await canonicalExecutable(process.execPath, "Node executable");
  const launcher = await canonicalExecutable(launcherPath(), "FFmpeg Bubblewrap launcher");
  const ffmpeg = await canonicalExecutable(input.ffmpegExecutable, "FFmpeg executable");
  const ffprobe = await canonicalExecutable(input.ffprobeExecutable, "FFprobe executable");
  const readOnlyRoots = uniquePaths([
    ...READ_ONLY_RUNTIME_ROOTS,
    packageRoot,
    ...inputRoots,
    dirname(ffmpeg.path),
    dirname(ffprobe.path)
  ]);

  for (const root of [packageRoot, ...inputRoots]) {
    if (overlapsAny(root, READ_ONLY_RUNTIME_ROOTS)) {
      throw refusal("sandbox_unavailable", "Package and parser input roots must not overlap fixed runtime mounts.", { root });
    }
    if (overlapsAny(root, [dirname(ffmpeg.path), dirname(ffprobe.path)])) {
      throw refusal("sandbox_unavailable", "Package and parser input roots must not overlap the pinned FFmpeg/FFprobe tool roots.", { root });
    }
  }
  if (overlapsAny(stagingRoot, readOnlyRoots)) {
    throw refusal(
      "sandbox_unavailable",
      "The job-owned parser staging root must be disjoint from every read-only package, input, runtime, and tool root.",
      { stagingRoot }
    );
  }
  if (unsafeStagingRoot(stagingRoot)) {
    throw refusal("sandbox_unavailable", "The job-owned parser staging root must not replace a namespace pseudo-filesystem or the private /tmp mount.", { stagingRoot });
  }

  const config = JSON.stringify({
    nodeExecutable: node.path,
    nodeSha256: node.sha256,
    launcherExecutable: launcher.path,
    launcherSha256: launcher.sha256,
    bubblewrapExecutable: capability.executable.path,
    bubblewrapSha256: capability.executable.sha256,
    ffmpegExecutable: ffmpeg.path,
    ffmpegSha256: ffmpeg.sha256,
    ffprobeExecutable: ffprobe.path,
    ffprobeSha256: ffprobe.sha256,
    packageRoot,
    inputRoots,
    stagingRoot
  });
  if (Buffer.byteLength(config, "utf8") > MAX_CONFIG_BYTES) {
    throw refusal("sandbox_unavailable", "Enforced parser launch configuration exceeds its fixed bound.");
  }
  return {
    executablePath: node.path,
    launcherPath: launcher.path,
    // The host intentionally gives the Node-launched shim no inherited HOME, PATH, token, or proxy variables.
    env: { [LAUNCHER_ENV]: config },
    allowedTools: [ffmpeg.path, ffprobe.path]
  };
}

/** Convert a validated FFmpeg/FFprobe command into fixed Node-plus-shim argv without shell interpretation. */
export async function isolatedParserCommand(
  plan: EnforcedUntrustedParserLaunchPlan,
  command: FfmpegCommand
): Promise<{ executable: string; args: string[]; env: Record<string, string> }> {
  if (command.shell !== false) throw refusal("sandbox_unavailable", "Enforced parser execution requires shell:false.");
  if (command.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw refusal("sandbox_unavailable", "Enforced parser argv contains an invalid argument.");
  }
  const executable = await canonicalExecutable(command.executable, "parser executable");
  if (!plan.allowedTools.includes(executable.path)) {
    throw refusal("sandbox_unavailable", "Enforced parser execution refuses an executable outside its pinned FFmpeg/FFprobe identities.", {
      executable: executable.path
    });
  }
  const parserArgv = [executable.path, ...command.args];
  if (parserArgv.length > MAX_PARSER_ARGV || Buffer.byteLength(parserArgv.join("\u0000"), "utf8") > MAX_PARSER_ARGV_BYTES) {
    throw refusal("sandbox_unavailable", "Enforced parser argv exceeds its fixed bound.");
  }
  return { executable: plan.executablePath, args: [plan.launcherPath, ...parserArgv], env: { ...plan.env } };
}

/**
 * Bind the fixed launcher to one existing governor admission. Its staging root is always the
 * job's scratch root, and the returned factory refuses a different AbortSignal so it cannot be
 * carried to another admission. The owning adapter remains responsible for staging validation and
 * atomic publication; this factory neither knows nor mounts a final-output path.
 */
export async function createEnforcedUntrustedParserProcessFactory(
  input: EnforcedUntrustedParserAdmittedInput,
  services: EnforcedUntrustedParserLaunchServices = {}
): Promise<StreamingFfmpegProcessFactory> {
  const plan = await prepareEnforcedUntrustedParserLaunch({
    motion: input.motion,
    packageRoot: input.packageRoot,
    inputRoots: input.inputRoots,
    stagingRoot: input.job.scratchRoot,
    ffmpegExecutable: input.ffmpegExecutable,
    ffprobeExecutable: input.ffprobeExecutable
  }, services);
  return async (processInput) => {
    if (processInput.signal !== input.job.signal) {
      throw refusal("sandbox_unavailable", "Enforced parser runner may be used only by the governor admission that created it.");
    }
    return await startStreamingFfmpegProcessWithTrustedLaunch(processInput, await isolatedParserCommand(plan, processInput.command));
  };
}

function launcherPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", LAUNCHER_FILE);
}

async function canonicalDistinctDirectories(values: readonly string[], label: string): Promise<string[]> {
  return uniquePaths(await Promise.all(values.map((value) => canonicalDirectory(value, label))));
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw refusal("sandbox_unavailable", `Enforced parser execution requires an absolute ${label}.`, { path });
  let direct;
  try { direct = await lstat(path); } catch { throw refusal("sandbox_unavailable", `Enforced parser execution requires an available ${label}.`, { path }); }
  if (direct.isSymbolicLink()) throw refusal("sandbox_unavailable", `Enforced parser execution refuses a symlinked ${label}.`, { path });
  const canonical = await realpath(path);
  const facts = await lstat(canonical);
  if (!facts.isDirectory() || facts.isSymbolicLink()) {
    throw refusal("sandbox_unavailable", `Enforced parser execution requires a canonical ${label}.`, { path });
  }
  return canonical;
}

async function canonicalPrivateStagingDirectory(path: string): Promise<string> {
  const canonical = await canonicalDirectory(path, "job-owned staging root");
  const facts = await stat(canonical);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((uid !== undefined && facts.uid !== uid) || (facts.mode & 0o022) !== 0) {
    throw refusal(
      "sandbox_unavailable",
      "Enforced parser execution requires a current-user-owned staging root without group or world write access.",
      { stagingRoot: canonical }
    );
  }
  return canonical;
}

async function canonicalExecutable(path: string, label: string): Promise<{ path: string; sha256: string }> {
  if (!isAbsolute(path)) throw refusal("sandbox_unavailable", `Enforced parser execution requires an absolute ${label}.`, { path });
  let direct;
  try { direct = await lstat(path); } catch { throw refusal("sandbox_unavailable", `Enforced parser execution requires an available ${label}.`, { path }); }
  if (direct.isSymbolicLink()) throw refusal("sandbox_unavailable", `Enforced parser execution refuses a symlinked ${label}.`, { path });
  const canonical = await realpath(path);
  const facts = await lstat(canonical);
  if (!facts.isFile() || facts.isSymbolicLink() || (facts.mode & 0o111) === 0) {
    throw refusal("sandbox_unavailable", `Enforced parser execution requires an executable ${label}.`, { path });
  }
  // This attests the trusted host's file identity while it plans and launches. It cannot defend
  // against a compromised host or a same-privilege replacement after that boundary.
  return { path: canonical, sha256: createHash("sha256").update(await readFile(canonical)).digest("hex") };
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function overlapsAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => pathsOverlap(path, root));
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function unsafeStagingRoot(path: string): boolean {
  return path === "/" || path === "/tmp" || FORBIDDEN_STAGING_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

function refusal(
  code: "sandbox_unavailable",
  message: string,
  detail?: Record<string, unknown>
): UntrustedMotionExecutionRefusal {
  return new UntrustedMotionExecutionRefusal(code, message, detail);
}
