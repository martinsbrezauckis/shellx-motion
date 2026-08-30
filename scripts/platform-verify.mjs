#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { arch, hostname, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";
import { validatePlatformVerificationReceipt } from "./platform-verification-schema.mjs";

// Command requirement vocabulary (all optional, all declarative):
//   requiresEnv       - host environment variables that must be set, else skip (or fail when required).
//   requiresEncoders  - FFmpeg encoder capability ids from the toolchain inventory that must be advertised.
//                       Absent capability skips with skipKind "capability-absent" instead of silently
//                       passing or hard-failing a host that never claimed the codec.
//   tier              - "core" (default, always planned) or "extended" (planned only with --include-extended).
const COMMANDS = [
  { id: "install", command: ["pnpm", "install", "--frozen-lockfile"], required: true, category: "setup" },
  { id: "typecheck", command: ["pnpm", "typecheck"], required: true, category: "core" },
  { id: "test", command: ["pnpm", "test"], required: true, category: "core" },
  { id: "debug:coverage", command: ["pnpm", "run", "debug:coverage"], required: true, category: "agent" },
  // The current receipt-store reader retains a descriptor-relative directory chain through
  // Linux /proc/self/fd. The prompt smoke ends by reading that store back, so other hosts must
  // record applicability rather than turning a missing portable openat primitive into a false
  // receipt_not_found failure.
  { id: "agent:smoke", command: ["pnpm", "run", "agent:smoke"], required: true, category: "agent", platforms: ["linux"] },
  { id: "agent-unavailable:smoke", command: ["pnpm", "run", "agent-unavailable:smoke"], required: true, category: "agent" },
  { id: "debug-server:smoke", command: ["pnpm", "run", "debug-server:smoke"], required: true, category: "agent" },
  { id: "debug-server-prompt:smoke", command: ["pnpm", "run", "debug-server-prompt:smoke"], required: true, category: "agent", platforms: ["linux"] },
  { id: "validate:fixtures", command: ["pnpm", "run", "validate:fixtures"], required: true, category: "package" },
  { id: "package-archive:smoke", command: ["pnpm", "run", "package-archive:smoke"], required: true, category: "package" },
  // These gates exercise descriptor-pinned closed-tree publication/receipt discovery, which is
  // intentionally Linux-only in v0.2.x.
  { id: "canvas-package-preview:smoke", command: ["pnpm", "run", "canvas-package-preview:smoke"], required: true, category: "package", platforms: ["linux"] },
  { id: "evidence-surfaces:smoke", command: ["pnpm", "run", "evidence-surfaces:smoke"], required: true, category: "agent", platforms: ["linux"] },
  { id: "sandbox:probe", command: ["pnpm", "run", "sandbox:probe"], required: true, category: "resources" },
  { id: "tracking:smoke", command: ["pnpm", "run", "tracking:smoke"], required: true, category: "analysis" },
  { id: "render:smoke", command: ["pnpm", "run", "render:smoke"], required: true, category: "render" },
  { id: "render-mp4:smoke", command: ["pnpm", "run", "render-mp4:smoke"], required: true, category: "render" },
  { id: "ffmpeg-acceleration:smoke", command: ["pnpm", "run", "ffmpeg-acceleration:smoke"], required: true, category: "render" },
  { id: "render-webm:smoke", command: ["pnpm", "run", "render-webm:smoke"], required: true, category: "render" },
  // Modern-codec claims are gated by the host's own FFmpeg encoder inventory, not by platform name.
  { id: "render-hevc:smoke", command: ["pnpm", "run", "render-hevc:smoke"], required: true, category: "render", requiresEncoders: ["hevc"] },
  { id: "render-av1:smoke", command: ["pnpm", "run", "render-av1:smoke"], required: true, category: "render", requiresEncoders: ["av1"] },
  { id: "render-audio:smoke", command: ["pnpm", "run", "render-audio:smoke"], required: true, category: "render" },
  { id: "render-caption:smoke", command: ["pnpm", "run", "render-caption:smoke"], required: true, category: "render" },
  { id: "render-alpha:smoke", command: ["pnpm", "run", "render-alpha:smoke"], required: true, category: "render" },
  { id: "render-gif:smoke", command: ["pnpm", "run", "render-gif:smoke"], required: true, category: "render" },
  { id: "render-jpeg:smoke", command: ["pnpm", "run", "render-jpeg:smoke"], required: true, category: "render" },
  { id: "browser:capture-smoke", command: ["pnpm", "run", "browser:capture-smoke"], required: true, category: "browser" },
  { id: "workbench:ui-smoke", command: ["pnpm", "run", "workbench:ui-smoke"], required: true, category: "browser" },
  { id: "source-storyboard:smoke", command: ["pnpm", "run", "source-storyboard:smoke"], required: true, category: "browser", platforms: ["linux"] },
  { id: "render-job-lifecycle:smoke", command: ["pnpm", "run", "render-job-lifecycle:smoke"], required: true, category: "render", platforms: ["linux"] },
  { id: "render-batch:smoke", command: ["pnpm", "run", "render-batch:smoke"], required: true, category: "render" },
  // Comprehensive promoted-template product proof (~5 minutes). Extended tier so per-host iteration stays
  // fast; final candidate verification opts in with --include-extended and runs it once per candidate.
  { id: "template-pack:proof", command: ["pnpm", "run", "template-pack:proof"], required: true, category: "template", tier: "extended", platforms: ["linux"] },
  { id: "connector:smoke", command: ["pnpm", "run", "connector:smoke"], required: true, category: "connector", platforms: ["linux"] },
  // P2A's exact-tree publication is Linux-only. Other declared hosts must record a verifiable
  // applicability skip rather than silently omitting this real Browser-to-FFmpeg acceptance gate.
  { id: "connector:template-cut-render-smoke", command: ["pnpm", "run", "connector:template-cut-render-smoke"], required: true, category: "connector", platforms: ["linux"] },
  { id: "connector:canvas-bridge-smoke", command: ["pnpm", "run", "connector:canvas-bridge-smoke"], required: false, category: "connector", requiresEnv: ["SHELLX_CANVAS_ROOT"] },
  { id: "connector:canvas-bridge-mp4-smoke", command: ["pnpm", "run", "connector:canvas-bridge-mp4-smoke"], required: false, category: "connector", requiresEnv: ["SHELLX_CANVAS_ROOT"] },
  { id: "connector:canvas-mp4-smoke", command: ["pnpm", "run", "connector:canvas-mp4-smoke"], required: true, category: "connector", platforms: ["linux"] },
  { id: "connector:script-cut-smoke", command: ["pnpm", "run", "connector:script-cut-smoke"], required: true, category: "connector", platforms: ["linux"] },
  { id: "connector:canvas-cut-smoke", command: ["pnpm", "run", "connector:canvas-cut-smoke"], required: false, category: "connector", requiresEnv: ["SHELLX_CANVAS_ROOT"], platforms: ["linux"] }
];

const DEFAULT_REQUIRED_HOSTS = ["linux", "windows", "macos"];
const DEFAULT_COMMAND_TIER = "core";
// Declared encoder requirements, keyed by command id. The aggregate verifier uses this so a receipt
// cannot self-declare "capability-absent" for a command that never had an encoder requirement.
const ENCODER_GATED_COMMANDS = new Map(
  COMMANDS
    .filter((command) => Array.isArray(command.requiresEncoders) && command.requiresEncoders.length > 0)
    .map((command) => [command.id, command.requiresEncoders])
);
const PLATFORM_GATED_COMMANDS = new Map(
  COMMANDS
    .filter((command) => Array.isArray(command.platforms) && command.platforms.length > 0)
    .map((command) => [command.id, command.platforms])
);
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const WINDOWS_EXECUTABLE_SUFFIXES = /\.(?:exe|com|cmd|bat)$/i;
const CANONICAL_HOST_PLATFORMS = {
  linux: "linux",
  windows: "win32",
  macos: "darwin"
};

const args = process.argv.slice(2);
const options = parseArgs(args);
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoScratchRoot = options.run ? await preparePrivateRepoScratch(repoRoot) : null;
const commandOutputRoot = options.run && options.json
  ? join(repoScratchRoot, "platform-verification", "command-output")
  : null;
if (commandOutputRoot) await assertPrivateRepoScratchPath(repoRoot, commandOutputRoot);
const startedAt = new Date().toISOString();
const receipt = options.verifyReceipts.length > 0
  ? verifyPlatformReceipts(options, repoRoot, startedAt)
  : createPlatformReceipt(options, repoRoot, startedAt);

if (!isAggregateReceipt(receipt) && options.run) {
  runCommands(receipt, options);
} else if (!isAggregateReceipt(receipt)) {
  receipt.finishedAt = receipt.startedAt;
  receipt.commandSummary = summarizeCommandStatuses(receipt.commands);
}

const presentedReceipt = options.shareable ? shareablePlatformEvidence(receipt) : receipt;

if (options.out) {
  const outPath = resolve(options.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(presentedReceipt, null, 2)}\n`);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(presentedReceipt, null, 2)}\n`);
} else {
  printHumanSummary(receipt, options);
}

process.exitCode = receipt.status === "failed" ? 1 : 0;

function parseArgs(values) {
  const parsed = {
    run: false,
    json: false,
    shareable: false,
    out: null,
    only: null,
    verifyReceipts: [],
    requireHostConnectors: false,
    requireExactToolchain: false,
    requireBundledCodecs: false,
    requireModernCodecs: false,
    includeExtended: false,
    collectAll: false,
    commandTimeoutMs: parsePositiveInteger(
      process.env.SHELLX_MOTION_PLATFORM_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS,
      "SHELLX_MOTION_PLATFORM_COMMAND_TIMEOUT_MS"
    ),
    hostId: process.env.SHELLX_MOTION_HOST_ID || hostname(),
    requiredHosts: parseHostList(process.env.SHELLX_MOTION_REQUIRED_HOSTS || DEFAULT_REQUIRED_HOSTS.join(","))
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") {
      continue;
    } else if (value === "--run") {
      parsed.run = true;
    } else if (value === "--dry-run") {
      parsed.run = false;
    } else if (value === "--json") {
      parsed.json = true;
    } else if (value === "--shareable") {
      parsed.shareable = true;
    } else if (value === "--out") {
      parsed.out = requireValue(values, index, value);
      index += 1;
    } else if (value === "--only") {
      parsed.only = requireValue(values, index, value).split(",").map((entry) => entry.trim()).filter(Boolean);
      index += 1;
    } else if (value === "--verify-receipts") {
      const receiptPaths = [];
      while (index + 1 < values.length && !values[index + 1].startsWith("--")) {
        index += 1;
        receiptPaths.push(...values[index].split(",").map((entry) => entry.trim()).filter(Boolean));
      }
      if (receiptPaths.length === 0) throw new Error("--verify-receipts requires at least one receipt path.");
      parsed.verifyReceipts.push(...receiptPaths);
    } else if (value === "--require-host-connectors" || value === "--phase2-connectors") {
      parsed.requireHostConnectors = true;
    } else if (value === "--require-exact-toolchain") {
      parsed.requireExactToolchain = true;
    } else if (value === "--require-bundled-codecs") {
      parsed.requireExactToolchain = true;
      parsed.requireBundledCodecs = true;
    } else if (value === "--require-modern-codecs") {
      parsed.requireModernCodecs = true;
    } else if (value === "--include-extended") {
      parsed.includeExtended = true;
    } else if (value === "--collect-all" || value === "--no-fail-fast") {
      parsed.collectAll = true;
    } else if (value === "--host-id") {
      parsed.hostId = requireValue(values, index, value);
      index += 1;
    } else if (value === "--required-hosts") {
      parsed.requiredHosts = parseHostList(requireValue(values, index, value));
      index += 1;
    } else if (value === "--command-timeout-ms") {
      parsed.commandTimeoutMs = parsePositiveInteger(requireValue(values, index, value), DEFAULT_COMMAND_TIMEOUT_MS, value);
      index += 1;
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  if (parsed.shareable && !parsed.json && !parsed.out) {
    throw new Error("--shareable requires --json or --out so the redacted projection has an explicit destination.");
  }
  return parsed;
}

function createPlatformReceipt(options, repoRoot, startedAt) {
  const selectedCommands = selectCommands(options.only, options).map((command) => applyCommandRequirementMode(command, options));
  return {
    schema: "shellx-motion/platform-verification@1",
    status: options.run ? "running" : "planned",
    dryRun: !options.run,
    // false = --collect-all: every command runs so one verification pass reports every independent problem.
    failFast: !options.collectAll,
    includeExtended: options.includeExtended,
    modernCodecsRequired: options.requireModernCodecs,
    host: {
      id: options.hostId,
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      release: release(),
      node: process.version
    },
    toolchain: options.run ? inspectExactToolchain(repoRoot) : { status: "planned", exact: false, bundledCodecs: false },
    ...(options.requiredHosts.length > 0 ? { hostMatrix: buildHostMatrix(options.hostId, options.requiredHosts) } : {}),
    commandTimeoutMs: options.commandTimeoutMs,
    repoRoot,
    startedAt,
    commands: selectedCommands.map((command) => ({
      ...command,
      status: options.run ? "pending" : "planned"
    }))
  };
}

function inspectExactToolchain(repoRoot) {
  const node = inspectExecutable(process.execPath, ["--version"], "runtime");
  const pnpm = inspectExecutable("pnpm", ["--version"], "package-manager");
  // Codec identity is resolved the way MOTION resolves it, not the way PATH would. See
  // `resolveMotionCodecTools` for the defect this closes.
  const codecs = resolveMotionCodecTools(repoRoot);
  const ffmpeg = inspectExecutable(codecs.ffmpeg.executable, ["-hide_banner", "-version"], "codec", codecs.ffmpeg.source);
  const ffprobe = inspectExecutable(codecs.ffprobe.executable, ["-hide_banner", "-version"], "codec", codecs.ffprobe.source);
  // The encoder inventory MUST come from the same executable that was identified above, or the
  // hevc/av1 capability gate could consult a different binary than the one that encodes.
  const encoders = ffmpeg.ok ? inspectFfmpegEncoders(ffmpeg.resolvedPath) : failedEncoderInventory("FFmpeg binary is unavailable.");
  const workspace = inspectWorkspaceIdentity(repoRoot);
  const bundledCodecs = ffmpeg.ok && ffprobe.ok && ffmpeg.bundled === true && ffprobe.bundled === true;
  const exact = node.ok && pnpm.ok && ffmpeg.ok && ffprobe.ok && encoders.status === "passed" && workspace.exact;
  return {
    status: exact ? "passed" : "failed",
    exact,
    bundledCodecs,
    // How the codec executables were located, so a reader can tell a receipt that asked Motion from
    // one that fell back to PATH resolution because the workspace was not installed.
    codecResolution: codecs.resolution,
    ...(codecs.reason ? { codecResolutionReason: codecs.reason } : {}),
    workspace,
    node: redactExecutablePath(node),
    pnpm: redactExecutablePath(pnpm),
    ffmpeg: redactExecutablePath(ffmpeg),
    ffprobe: redactExecutablePath(ffprobe),
    encoders
  };
}

/**
 * Ask Motion where it will spawn ffmpeg/ffprobe from, instead of deciding independently.
 *
 * THE DEFECT THIS CLOSES (reproduced on the Windows rig,  in one session so it is not a
 * per-shell PATH difference): the only `ffmpeg.exe` on PATH reported version 8.1.2, `shellx-motion
 * doctor` reported N-125773 with source `shellx-family`, and this receipt recorded 8.1.2 with
 * source `path`. Motion's resolver is `SHELLX_MOTION_FFMPEG override -> shellx-family bundled ->
 * PATH`; preferring the bundled binary is correct and deliberate. What was wrong is that the
 * release evidence named a binary that produced none of the media in the same receipt — and
 * `--require-exact-toolchain` exists precisely to make a receipt reproducible.
 *
 * The resolver is TypeScript in the renderer package, so it is reached through
 * `scripts/motion-tool-resolution.ts` rather than reimplemented here. A second implementation of
 * the resolution order is the same drift that caused the defect.
 *
 * FALLBACK. `platform-verify.mjs` must keep working from a bare checkout with no `node_modules`
 * (the CLI suite copies this script into an empty git repo and runs it). When the resolver cannot
 * be reached, the previous env/PATH behaviour is used and `codecResolution` says `path-fallback`
 * with a reason, so the receipt never silently claims Motion-resolved identity it did not get.
 */
function resolveMotionCodecTools(repoRoot) {
  const resolverPath = resolve(repoRoot, "scripts/motion-tool-resolution.ts");
  const fallback = (reason) => ({
    resolution: "path-fallback",
    reason: safeHumanText(reason),
    ffmpeg: motionToolFallback("SHELLX_MOTION_FFMPEG", "ffmpeg"),
    ffprobe: motionToolFallback("SHELLX_MOTION_FFPROBE", "ffprobe")
  });
  if (!existsSync(resolverPath)) return fallback("scripts/motion-tool-resolution.ts is not present");
  // `node --import tsx <file>` keeps the spawned executable as Node itself and every argument a
  // plain path, so this never goes through a Windows `.cmd` shim or a quoted command line.
  const result = spawnSync(process.execPath, ["--import", "tsx", resolverPath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  if (result.status !== 0 || result.error) {
    return fallback(result.error?.message || firstSafeLine(result.stderr || "") || `resolver exited ${result.status}`);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const entry = parsed?.[tool];
      if (!entry || typeof entry.executable !== "string" || typeof entry.source !== "string") {
        throw new Error(`resolver did not report ${tool}`);
      }
    }
    return { resolution: "motion-resolver", ffmpeg: parsed.ffmpeg, ffprobe: parsed.ffprobe };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}

/** Env-or-PATH resolution in Motion's own vocabulary, for the no-workspace fallback path. */
function motionToolFallback(envName, command) {
  const override = process.env[envName]?.trim();
  const executable = locateTrustedCodecExecutable(override || command);
  return executable
    ? { executable, source: override ? "override" : "path" }
    : { executable: missingCodecExecutable(command), source: override ? "override" : "path", problem: "trusted executable not found" };
}

function locateTrustedCodecExecutable(command) {
  const value = String(command || "").trim();
  const candidates = [];
  if (isAbsolute(value)) candidates.push(value);
  else if (value && !value.includes("/") && !value.includes("\\")) {
    const fileName = platform() === "win32" ? `${value}.exe` : value;
    for (const rawEntry of String(process.env.PATH || "").split(delimiter)) {
      const entry = rawEntry.trim().replace(/^"|"$/gu, "");
      if (entry && isAbsolute(entry)) candidates.push(join(entry, fileName));
    }
  }
  for (const candidate of candidates) {
    try {
      const lexical = lstatSync(candidate);
      if (platform() === "win32" && lexical.isSymbolicLink()) continue;
      const canonical = realpathSync.native(candidate);
      const target = lstatSync(canonical);
      if (target.isFile() && (platform() === "win32" || (target.mode & 0o111) !== 0)) return canonical;
    } catch {
      // Continue through absolute candidates only.
    }
  }
  return null;
}

function missingCodecExecutable(command) {
  return platform() === "win32" ? `C:\\__shellx_motion_missing__\\${command}.exe` : `/__shellx_motion_missing__/${command}`;
}

/**
 * Strip the absolute path from an executable identity before it reaches the receipt.
 *
 * An absolute path names a user's home directory and install layout and is not shareable evidence;
 * the SHA-256, byte length, version and `source` are what actually identify the binary and let a
 * render be reproduced. Same rule the renderer's `resolveMotionToolLocation` docstring states for
 * render receipts, applied to the release evidence one layer up.
 */
function redactExecutablePath(identity) {
  const { resolvedPath: _resolvedPath, ...redacted } = identity;
  return redacted;
}

/**
 * Identify one executable: version, SHA-256, byte length, and how it was found.
 *
 * `motionSource` is the resolver's verdict for the codec tools (`override` / `shellx-family` /
 * `path`) and is recorded verbatim, so the receipt reports the same provenance a render receipt
 * does. Node and pnpm have no Motion resolver and default to `path`. The canonical path is returned
 * as `resolvedPath` for the caller to USE, and is stripped by `redactExecutablePath` before the
 * identity reaches the receipt.
 */
function inspectExecutable(command, versionArgs, role, motionSource = "path") {
  const located = locateExecutable(command);
  if (!located) return { status: "failed", ok: false, role, source: motionSource, reason: "executable not found" };
  try {
    const canonical = realpathSync.native(located);
    const facts = lstatSync(canonical);
    if (!facts.isFile() || facts.isSymbolicLink()) throw new Error("resolved executable is not a regular file");
    const probe = spawnPortableExecutable(located, versionArgs, 15_000, 4 * 1024 * 1024);
    if (probe.status !== 0 || probe.error) throw new Error(probe.error?.message || `version probe exited ${probe.status}`);
    const version = firstSafeLine(`${probe.stdout || ""}\n${probe.stderr || ""}`);
    if (!version) throw new Error("version probe returned no version line");
    const bundled = isShellxBundledTool(canonical);
    return {
      status: "passed",
      ok: true,
      role,
      source: motionSource,
      sha256: sha256File(canonical),
      byteLength: facts.size,
      version,
      // Whether the canonical file sits under a ShellX bundled-tools root. Distinct from `source`:
      // `source` is HOW the executable was found, `bundled` is WHERE it lives, and an explicit
      // override pointing at a bundled binary is still bundled evidence.
      bundled,
      // Consumed in-process (the encoder inventory must probe this exact file) and stripped from
      // the receipt by `redactExecutablePath`.
      resolvedPath: canonical
    };
  } catch (error) {
    return {
      status: "failed",
      ok: false,
      role,
      source: motionSource,
      reason: safeHumanText(error instanceof Error ? error.message : String(error))
    };
  }
}

function locateExecutable(command) {
  const value = String(command || "").trim();
  if (!value) return null;
  if (isAbsolute(value)) return existsSync(value) ? value : null;
  if (value.includes("/") || value.includes("\\")) return null;
  const finder = platform() === "win32"
    ? { executable: "where.exe", args: [value] }
    : { executable: "which", args: [value] };
  const result = spawnSync(finder.executable, finder.args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (result.status !== 0 || result.error) return null;
  const candidates = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (platform() === "win32") {
    return candidates.find((candidate) => WINDOWS_EXECUTABLE_SUFFIXES.test(candidate) && existsSync(candidate)) || null;
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function spawnPortableExecutable(path, args, timeout, maxBuffer) {
  if (platform() === "win32" && /\.(?:cmd|bat)$/i.test(path)) {
    const batchPath = String(path);
    const batchArgs = args.map((value) => String(value));
    const unsafeMetacharacter = /[\r\n"&|<>^%!()]/;
    if (unsafeMetacharacter.test(batchPath) || batchArgs.some((value) => unsafeMetacharacter.test(value))) {
      throw new Error("refusing to execute a Windows batch shim containing command-shell metacharacters");
    }
    if (batchArgs.some((value) => !/^[A-Za-z0-9._:/=+,-]+$/.test(value))) {
      throw new Error("refusing to execute a Windows batch shim with an unsupported argument");
    }
    const commandLine = `call "${batchPath}"${batchArgs.length > 0 ? ` ${batchArgs.join(" ")}` : ""}`;
    return spawnSync("cmd.exe", ["/d", "/s", "/c", commandLine], {
      encoding: "utf8",
      timeout,
      maxBuffer,
      windowsHide: true,
      windowsVerbatimArguments: true
    });
  }
  return spawnSync(path, args, { encoding: "utf8", timeout, maxBuffer, windowsHide: true });
}

function inspectFfmpegEncoders(ffmpegPath) {
  const result = spawnPortableExecutable(ffmpegPath, ["-hide_banner", "-encoders"], 30_000, 16 * 1024 * 1024);
  if (result.status !== 0 || result.error) return failedEncoderInventory(result.error?.message || `encoder probe exited ${result.status}`);
  const output = String(result.stdout || "") + String(result.stderr || "");
  const capabilities = {
    h264: /\blibx264\b/.test(output),
    vp9: /\blibvpx-vp9\b/.test(output),
    prores: /\bprores_ks\b/.test(output),
    hevc: /\blibx265\b/.test(output),
    av1: /\b(?:libaom-av1|libsvtav1|librav1e)\b/.test(output)
  };
  const required = ["h264", "vp9", "prores"];
  const missing = required.filter((id) => capabilities[id] !== true);
  return {
    status: missing.length === 0 ? "passed" : "failed",
    outputSha256: createHash("sha256").update(output).digest("hex"),
    required,
    missing,
    capabilities
  };
}

function failedEncoderInventory(reason) {
  return {
    status: "failed",
    required: ["h264", "vp9", "prores"],
    missing: ["h264", "vp9", "prores"],
    capabilities: { h264: false, vp9: false, prores: false, hevc: false, av1: false },
    reason: safeHumanText(reason)
  };
}

function inspectWorkspaceIdentity(repoRoot) {
  const commit = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  const dirty = spawnSync("git", ["-C", repoRoot, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  const lockfile = resolve(repoRoot, "pnpm-lock.yaml");
  const commitValue = commit.status === 0 ? String(commit.stdout || "").trim() : null;
  const trackedDirty = dirty.status === 0 ? String(dirty.stdout || "").trim().length > 0 : null;
  const lockfileSha256 = existsSync(lockfile) ? sha256File(lockfile) : null;
  const failures = [];
  if (!commitValue || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(commitValue)) failures.push("Git HEAD identity is unavailable or invalid.");
  if (trackedDirty === null) failures.push("Git tracked-worktree state is unavailable.");
  else if (trackedDirty) failures.push("Git tracked worktree is dirty.");
  if (!lockfileSha256) failures.push("pnpm-lock.yaml identity is unavailable.");
  return {
    status: failures.length === 0 ? "passed" : "failed",
    exact: failures.length === 0,
    commit: commitValue,
    trackedDirty,
    lockfileSha256,
    failures
  };
}

function isShellxBundledTool(path) {
  const candidates = [
    process.env.SHELLX_MOTION_BUNDLED_TOOLS_ROOT,
    process.env.SHELLX_MOTION_INSTALL_ROOT,
    process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "ShellX Motion"),
    process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "ShellX Cut"),
    process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "ShellX Canvas")
  ].filter(Boolean);
  if (candidates.some((root) => pathInside(root, path))) return true;
  return /ShellX (?:Motion|Cut|Canvas)\.app[/\\]Contents[/\\]Resources[/\\]/i.test(path)
    || /[/\\]ShellX (?:Motion|Cut|Canvas)[/\\]tools[/\\]ffmpeg[/\\]/i.test(path);
}

function pathInside(root, path) {
  let canonicalRoot;
  try { canonicalRoot = realpathSync.native(resolve(root)); }
  catch { return false; }
  const rel = relative(canonicalRoot, resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function firstSafeLine(value) {
  return String(value).split(/\r?\n/).map((line) => safeHumanText(line).trim()).find(Boolean)?.slice(0, 500) || "";
}

function summarizeExactToolchain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "missing", exact: false, bundledCodecs: false };
  const workspaceValue = value.workspace && typeof value.workspace === "object" && !Array.isArray(value.workspace) ? value.workspace : null;
  const workspaceCommit = typeof workspaceValue?.commit === "string" ? workspaceValue.commit : null;
  const workspaceTrackedDirty = typeof workspaceValue?.trackedDirty === "boolean" ? workspaceValue.trackedDirty : null;
  const workspaceLockfileSha256 = typeof workspaceValue?.lockfileSha256 === "string" ? workspaceValue.lockfileSha256 : null;
  const workspaceExact = workspaceValue?.status === "passed"
    && workspaceValue?.exact === true
    && workspaceTrackedDirty === false
    && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(workspaceCommit || "")
    && /^[a-f0-9]{64}$/i.test(workspaceLockfileSha256 || "");
  const workspace = {
    status: typeof workspaceValue?.status === "string" ? workspaceValue.status : "missing",
    exact: workspaceExact,
    commit: workspaceCommit,
    trackedDirty: workspaceTrackedDirty,
    lockfileSha256: workspaceLockfileSha256
  };
  return {
    status: typeof value.status === "string" ? value.status : "invalid",
    exact: value.exact === true && workspace.exact,
    bundledCodecs: value.bundledCodecs === true,
    workspace,
    nodeSha256: typeof value.node?.sha256 === "string" ? value.node.sha256 : null,
    ffmpegSha256: typeof value.ffmpeg?.sha256 === "string" ? value.ffmpeg.sha256 : null,
    ffprobeSha256: typeof value.ffprobe?.sha256 === "string" ? value.ffprobe.sha256 : null,
    encoderCapabilities: value.encoders?.capabilities && typeof value.encoders.capabilities === "object"
      ? value.encoders.capabilities
      : null
  };
}

function parseHostList(value) {
  if (!value || value.trim().toLowerCase() === "none") return [];
  return [...new Set(value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function buildHostMatrix(currentHostId, requiredHosts) {
  const currentRequired = requiredHosts.includes(currentHostId);
  const satisfied = currentRequired ? [currentHostId] : [];
  const missing = requiredHosts.filter((hostId) => hostId !== currentHostId);
  const complete = missing.length === 0 && currentRequired;
  return {
    required: requiredHosts,
    current: currentHostId,
    currentRequired,
    satisfied,
    missing,
    complete,
    status: complete ? "complete" : "partial"
  };
}

function verifyPlatformReceipts(options, repoRoot, startedAt) {
  const requiredCommandIds = requiredPlatformCommandIds(options);
  const receipts = options.verifyReceipts.map((path) => summarizePlatformReceipt(path, requiredCommandIds, options));
  const requiredHosts = options.requiredHosts;
  const duplicateHosts = findDuplicateHostIds(receipts);
  const duplicateHostSet = new Set(duplicateHosts);
  for (const receipt of receipts) {
    if (receipt.hostId && duplicateHostSet.has(receipt.hostId)) {
      receipt.failures.push(`duplicate receipt host id: ${receipt.hostId}`);
      receipt.ok = false;
    }
  }
  const identityMismatches = options.requireExactToolchain
    ? markWorkspaceIdentityMismatches(receipts, requiredHosts)
    : [];
  const satisfiedHosts = requiredHosts.filter((hostId) => receipts.some((receipt) => receipt.hostId === hostId && receipt.ok));
  const missingHosts = requiredHosts.filter((hostId) => !receipts.some((receipt) => receipt.hostId === hostId));
  const failedHosts = requiredHosts.filter((hostId) => !satisfiedHosts.includes(hostId));
  const invalidReceipts = receipts.filter((receipt) => !receipt.hostId || !receipt.schemaOk);
  const status = failedHosts.length === 0 && invalidReceipts.length === 0 && duplicateHosts.length === 0 ? "passed" : "failed";
  return {
    schema: "shellx-motion/platform-verification-aggregate@1",
    status,
    dryRun: false,
    repoRoot,
    startedAt,
    finishedAt: startedAt,
    requiredHosts,
    requiredCommands: requiredCommandIds,
    exactToolchainRequired: options.requireExactToolchain,
    bundledCodecsRequired: options.requireBundledCodecs,
    modernCodecsRequired: options.requireModernCodecs,
    extendedTierRequired: options.includeExtended,
    summary: {
      requiredHostCount: requiredHosts.length,
      satisfiedHostCount: satisfiedHosts.length,
      missingHosts,
      failedHosts,
      invalidReceiptCount: invalidReceipts.length,
      duplicateHostCount: duplicateHosts.length,
      duplicateHosts,
      workspaceIdentityMismatchCount: identityMismatches.length,
      workspaceIdentityMismatchHosts: identityMismatches,
      // Accepted-but-visible: a required codec gate that this host never claimed. Not a pass, not a failure.
      capabilitySkips: collectCapabilitySkips(receipts),
      platformInapplicableSkips: collectPlatformInapplicableSkips(receipts)
    },
    receipts
  };
}

function collectCapabilitySkips(receipts) {
  const skips = [];
  for (const receipt of receipts) {
    for (const entry of receipt.requiredCommands?.capabilitySkipped ?? []) {
      skips.push({ hostId: receipt.hostId ?? null, command: entry.id, missingEncoders: entry.missingEncoders });
    }
  }
  return skips;
}

function collectPlatformInapplicableSkips(receipts) {
  const skips = [];
  for (const receipt of receipts) {
    for (const entry of receipt.requiredCommands?.platformInapplicableSkipped ?? []) {
      skips.push({ hostId: receipt.hostId ?? null, command: entry.id, hostPlatform: entry.hostPlatform, platforms: entry.platforms });
    }
  }
  return skips;
}

function markWorkspaceIdentityMismatches(receipts, requiredHosts) {
  const ordered = [
    ...requiredHosts.map((hostId) => receipts.find((receipt) => receipt.hostId === hostId)).filter(Boolean),
    ...receipts.filter((receipt) => !requiredHosts.includes(receipt.hostId))
  ];
  const baseline = ordered.find((receipt) => receipt.toolchain?.workspace?.exact === true);
  if (!baseline) return [];
  const expectedCommit = baseline.toolchain.workspace.commit;
  const expectedLockfile = baseline.toolchain.workspace.lockfileSha256;
  const mismatches = [];
  for (const receipt of receipts) {
    const workspace = receipt.toolchain?.workspace;
    if (workspace?.exact !== true) continue;
    if (workspace.commit === expectedCommit && workspace.lockfileSha256 === expectedLockfile) continue;
    receipt.failures.push(`workspace identity mismatch: expected commit ${expectedCommit} and lockfile ${expectedLockfile}`);
    receipt.ok = false;
    if (receipt.hostId) mismatches.push(receipt.hostId);
  }
  return [...new Set(mismatches)].sort();
}

function findDuplicateHostIds(receipts) {
  const seen = new Set();
  const duplicates = new Set();
  for (const receipt of receipts) {
    if (!receipt.hostId) continue;
    if (seen.has(receipt.hostId)) {
      duplicates.add(receipt.hostId);
    } else {
      seen.add(receipt.hostId);
    }
  }
  return [...duplicates].sort();
}

function requiredPlatformCommandIds(options) {
  // Deliberately ignores --only: receipt verification always judges the full ladder for the active tier.
  return selectCommands(null, options)
    .filter((command) => command.required || (options.requireHostConnectors && isHostConnectorCommand(command)))
    .map((command) => command.id);
}

function applyCommandRequirementMode(command, options) {
  if (!options.requireHostConnectors || !isHostConnectorCommand(command)) return { ...command };
  return { ...command, required: true };
}

function isHostConnectorCommand(command) {
  return command.category === "connector" && Array.isArray(command.requiresEnv) && command.requiresEnv.length > 0;
}

function summarizePlatformReceipt(path, requiredCommandIds, options) {
  const resolvedPath = resolve(path);
  const failures = [];
  let record;
  let sourceSha256 = null;
  try {
    const source = readFileSync(resolvedPath, "utf8");
    sourceSha256 = createHash("sha256").update(source).digest("hex");
    record = JSON.parse(source);
  } catch (error) {
    return {
      path: resolvedPath,
      sourceSha256,
      hostId: null,
      schemaOk: false,
      status: "unreadable",
      dryRun: false,
      ok: false,
      failures: ["receipt could not be read or parsed as JSON"],
      requiredCommands: { total: requiredCommandIds.length, passed: 0, missing: requiredCommandIds, failed: [] }
    };
  }

  const schemaProblems = validatePlatformVerificationReceipt(record);
  const completionProblems = completedReceiptProblems(record);
  const schemaOk = schemaProblems.length === 0 && completionProblems.length === 0;
  const hostId = typeof record?.host?.id === "string" ? record.host.id : null;
  const hostPlatform = typeof record?.host?.platform === "string" ? record.host.platform : null;
  const expectedPlatform = hostId ? CANONICAL_HOST_PLATFORMS[hostId] ?? null : null;
  const status = typeof record?.status === "string" ? record.status : "unknown";
  const dryRun = record?.dryRun === true;
  if (!schemaOk) {
    const problem = schemaProblems[0] ?? completionProblems[0];
    failures.push(`receipt schema validation failed: ${problem.path || "/"} ${problem.message}`);
  }
  if (!hostId) failures.push("receipt host id is missing");
  if (expectedPlatform && hostPlatform !== expectedPlatform) {
    failures.push(`receipt host platform mismatch: ${hostId} requires ${expectedPlatform}, got ${hostPlatform ?? "missing"}`);
  }
  if (dryRun) failures.push("receipt is dry-run/planned evidence");
  if (status !== "passed") failures.push(`receipt status is ${status}`);
  const toolchain = summarizeExactToolchain(record?.toolchain);
  if (options.requireExactToolchain && !toolchain.exact) failures.push("exact toolchain evidence is missing or failed");
  if (options.requireBundledCodecs && !toolchain.bundledCodecs) failures.push("bundled FFmpeg/FFprobe evidence is missing or failed");

  const commands = Array.isArray(record?.commands) ? record.commands : [];
  const missingCommands = [];
  const failedCommands = [];
  const capabilitySkippedCommands = [];
  const platformInapplicableSkippedCommands = [];
  for (const id of requiredCommandIds) {
    const command = commands.find((entry) => entry && entry.id === id);
    if (!command) {
      missingCommands.push(id);
      failures.push(`required command missing: ${id}`);
      continue;
    }
    if (command.required !== true) {
      failedCommands.push(id);
      failures.push(`required command is not marked required: ${id}`);
      continue;
    }
    if (command.status === "passed") continue;
    const capabilitySkip = acceptCapabilitySkip(id, command, toolchain, options);
    if (capabilitySkip) {
      capabilitySkippedCommands.push(capabilitySkip);
      continue;
    }
    const platformInapplicableSkip = acceptPlatformInapplicableSkip(id, command, hostPlatform, expectedPlatform);
    if (platformInapplicableSkip) {
      platformInapplicableSkippedCommands.push(platformInapplicableSkip);
      continue;
    }
    failedCommands.push(id);
    // Never collapse "skipped" into "failed" wording: a review must see WHY the command produced no result.
    failures.push(command.status === "skipped"
      ? `required command skipped (${safeHumanText(command.skipKind || "unspecified")}): ${id}`
      : `required command failed: ${id}`);
  }

  return {
    path: resolvedPath,
    sourceSha256,
    hostId,
    hostPlatform,
    expectedPlatform,
    schemaOk,
    status,
    dryRun,
    toolchain,
    ok: failures.length === 0,
    failures,
    requiredCommands: {
      total: requiredCommandIds.length,
      passed: requiredCommandIds.length - missingCommands.length - failedCommands.length - capabilitySkippedCommands.length - platformInapplicableSkippedCommands.length,
      missing: missingCommands,
      failed: failedCommands,
      capabilitySkipped: capabilitySkippedCommands,
      platformInapplicableSkipped: platformInapplicableSkippedCommands
    }
  };
}

function completedReceiptProblems(record) {
  const problems = [];
  if (record?.status !== "passed" && record?.status !== "failed") {
    problems.push({ path: "/status", message: "must be a terminal passed or failed receipt" });
  }
  const commands = Array.isArray(record?.commands) ? record.commands : [];
  const seen = new Set();
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (!command || typeof command !== "object" || Array.isArray(command)) continue;
    if (typeof command.id === "string") {
      if (seen.has(command.id)) problems.push({ path: `/commands/${index}/id`, message: "must be unique" });
      seen.add(command.id);
      const declared = COMMANDS.find((entry) => entry.id === command.id);
      if (!declared) {
        problems.push({ path: `/commands/${index}/id`, message: "must name a command declared by this build" });
      } else if (!sameStringArray(command.command, declared.command)) {
        problems.push({ path: `/commands/${index}/command`, message: "must match this build's declared command" });
      }
    }
    if (!Number.isFinite(command.durationMs) || command.durationMs < 0) {
      problems.push({ path: `/commands/${index}/durationMs`, message: "must be a non-negative completed duration" });
    }
    if (command.status === "passed") {
      if (!Number.isInteger(command.exitCode) || command.exitCode !== 0) {
        problems.push({ path: `/commands/${index}/exitCode`, message: "must be zero for a passed command" });
      }
    } else if (command.status === "failed") {
      if (!Number.isInteger(command.exitCode) || command.exitCode === 0) {
        problems.push({ path: `/commands/${index}/exitCode`, message: "must be non-zero for a failed command" });
      }
    } else if (command.status === "skipped") {
      if (typeof command.skipKind !== "string" || !command.skipKind || typeof command.skipReason !== "string" || !command.skipReason) {
        problems.push({ path: `/commands/${index}`, message: "a skipped command must retain skipKind and skipReason" });
      }
    } else {
      problems.push({ path: `/commands/${index}/status`, message: "must be passed, failed, or skipped in a completed receipt" });
    }
  }
  const expected = summarizeCommandStatuses(commands);
  if (!sameCommandSummary(record?.commandSummary, expected)) {
    problems.push({ path: "/commandSummary", message: "must exactly reconcile the completed command list" });
  }
  return problems;
}

function sameStringArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCommandSummary(left, right) {
  return left && typeof left === "object" && !Array.isArray(left)
    && left.total === right.total && left.passed === right.passed && left.failed === right.failed && left.skipped === right.skipped
    && sameIntegerMap(left.skippedByKind, right.skippedByKind);
}

function sameIntegerMap(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left) || !right || typeof right !== "object" || Array.isArray(right)) return false;
  const leftEntries = Object.entries(left).sort(([a], [b]) => compareCodeUnits(a, b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => compareCodeUnits(a, b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Accept a required command that skipped because the host genuinely lacks the encoder.
 * The receipt's own claim is not trusted: the declared requirement must exist in this build's
 * command table AND the receipt's FFmpeg encoder inventory must actually report the encoder absent.
 * @returns {null|{id: string, missingEncoders: string[], reason: string}}
 */
function acceptCapabilitySkip(id, command, toolchain, options) {
  if (options.requireModernCodecs) return null;
  const declaredEncoders = ENCODER_GATED_COMMANDS.get(id);
  if (!declaredEncoders) return null;
  if (command.status !== "skipped" || command.skipKind !== "capability-absent") return null;
  const capabilities = toolchain?.encoderCapabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return null;
  const missingEncoders = declaredEncoders.filter((encoder) => capabilities[encoder] !== true);
  if (missingEncoders.length === 0) return null;
  return {
    id,
    missingEncoders,
    reason: typeof command.skipReason === "string" ? safeHumanText(command.skipReason).slice(0, 300) : ""
  };
}

/**
 * Accept an inapplicable required command only when this build declares its platform restriction
 * and the receipt host is a canonical, non-applicable host. A receipt cannot self-exempt a Linux
 * requirement by spelling the skip kind itself.
 */
function acceptPlatformInapplicableSkip(id, command, hostPlatform, expectedPlatform) {
  const platforms = PLATFORM_GATED_COMMANDS.get(id);
  if (!platforms) return null;
  if (command.status !== "skipped" || command.skipKind !== "platform-inapplicable") return null;
  if (!hostPlatform || !expectedPlatform || hostPlatform !== expectedPlatform || platforms.includes(hostPlatform)) return null;
  return {
    id,
    hostPlatform,
    platforms: [...platforms],
    reason: typeof command.skipReason === "string" ? safeHumanText(command.skipReason).slice(0, 300) : ""
  };
}

/**
 * Public-safe projection. It is intentionally a different schema and cannot be fed back into the
 * native qualification gate: paths, host-local identity, raw command text, and diagnostic tails
 * remain private operator evidence, while hashes and bounded outcome facts remain shareable.
 */
function shareablePlatformEvidence(receipt) {
  const sourceSha256 = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  return {
    schema: "shellx-motion/platform-verification-shareable@1",
    source: { schema: receipt.schema, sha256: sourceSha256 },
    status: receipt.status,
    evidence: isAggregateReceipt(receipt)
      ? shareableAggregateEvidence(receipt)
      : shareableHostEvidence(receipt),
  };
}

function shareableHostEvidence(receipt) {
  return {
    dryRun: receipt.dryRun === true,
    host: {
      id: logicalPlatformId(receipt.host?.platform),
      platform: receipt.host?.platform ?? "unknown",
      arch: receipt.host?.arch ?? "unknown",
      node: receipt.host?.node ?? "unknown",
    },
    toolchain: shareableToolchainEvidence(summarizeExactToolchain(receipt.toolchain)),
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    commandSummary: receipt.commandSummary,
    commands: (Array.isArray(receipt.commands) ? receipt.commands : []).map(shareableCommandEvidence),
  };
}

function shareableAggregateEvidence(receipt) {
  return {
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    exactToolchainRequired: receipt.exactToolchainRequired === true,
    bundledCodecsRequired: receipt.bundledCodecsRequired === true,
    modernCodecsRequired: receipt.modernCodecsRequired === true,
    extendedTierRequired: receipt.extendedTierRequired === true,
    summary: {
      requiredHostCount: receipt.summary?.requiredHostCount ?? 0,
      satisfiedHostCount: receipt.summary?.satisfiedHostCount ?? 0,
      missingHostCount: Array.isArray(receipt.summary?.missingHosts) ? receipt.summary.missingHosts.length : 0,
      failedHostCount: Array.isArray(receipt.summary?.failedHosts) ? receipt.summary.failedHosts.length : 0,
      invalidReceiptCount: receipt.summary?.invalidReceiptCount ?? 0,
      duplicateHostCount: receipt.summary?.duplicateHostCount ?? 0,
      workspaceIdentityMismatchCount: receipt.summary?.workspaceIdentityMismatchCount ?? 0,
      capabilitySkipCount: Array.isArray(receipt.summary?.capabilitySkips) ? receipt.summary.capabilitySkips.length : 0,
      platformInapplicableSkipCount: Array.isArray(receipt.summary?.platformInapplicableSkips) ? receipt.summary.platformInapplicableSkips.length : 0,
    },
    receipts: (Array.isArray(receipt.receipts) ? receipt.receipts : []).map((entry) => ({
      sourceSha256: entry.sourceSha256 ?? null,
      host: logicalPlatformId(entry.hostPlatform),
      status: entry.status,
      dryRun: entry.dryRun === true,
      schemaOk: entry.schemaOk === true,
      ok: entry.ok === true,
      failureCount: Array.isArray(entry.failures) ? entry.failures.length : 0,
      toolchain: shareableToolchainEvidence(entry.toolchain),
      requiredCommands: shareableRequiredCommandEvidence(entry.requiredCommands),
    })),
  };
}

function shareableRequiredCommandEvidence(value) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    total: Number.isInteger(record.total) ? record.total : 0,
    passed: Number.isInteger(record.passed) ? record.passed : 0,
    missing: stringArray(record.missing),
    failed: stringArray(record.failed),
    capabilitySkipped: (Array.isArray(record.capabilitySkipped) ? record.capabilitySkipped : []).map((entry) => ({
      id: typeof entry?.id === "string" ? entry.id : "unknown",
      missingEncoders: stringArray(entry?.missingEncoders),
    })),
    platformInapplicableSkipped: (Array.isArray(record.platformInapplicableSkipped) ? record.platformInapplicableSkipped : []).map((entry) => ({
      id: typeof entry?.id === "string" ? entry.id : "unknown",
      hostPlatform: typeof entry?.hostPlatform === "string" ? entry.hostPlatform : "unknown",
      platforms: stringArray(entry?.platforms),
    })),
  };
}

function shareableToolchainEvidence(value) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const workspace = record.workspace && typeof record.workspace === "object" && !Array.isArray(record.workspace)
    ? record.workspace
    : {};
  return {
    status: fixedEvidenceStatus(record.status),
    exact: record.exact === true,
    bundledCodecs: record.bundledCodecs === true,
    workspace: {
      status: fixedEvidenceStatus(workspace.status),
      exact: workspace.exact === true,
      commit: fixedHex(workspace.commit, [40, 64]),
      trackedDirty: typeof workspace.trackedDirty === "boolean" ? workspace.trackedDirty : null,
      lockfileSha256: fixedHex(workspace.lockfileSha256, [64]),
    },
    nodeSha256: fixedHex(record.nodeSha256, [64]),
    ffmpegSha256: fixedHex(record.ffmpegSha256, [64]),
    ffprobeSha256: fixedHex(record.ffprobeSha256, [64]),
    encoderCapabilities: fixedEncoderCapabilities(record.encoderCapabilities),
  };
}

function fixedEvidenceStatus(value) {
  return ["passed", "failed", "missing", "invalid", "planned", "partial"].includes(value) ? value : "invalid";
}

function fixedHex(value, lengths) {
  return typeof value === "string" && lengths.includes(value.length) && /^[a-f0-9]+$/i.test(value) ? value : null;
}

function fixedEncoderCapabilities(value) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(["h264", "vp9", "prores", "hevc", "av1"]
    .filter((key) => typeof record[key] === "boolean")
    .map((key) => [key, record[key]]));
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function shareableCommandEvidence(command) {
  return {
    id: command?.id ?? "unknown",
    required: command?.required === true,
    category: command?.category ?? "unknown",
    status: command?.status ?? "unknown",
    durationMs: Number.isFinite(command?.durationMs) ? command.durationMs : 0,
    ...(Number.isInteger(command?.exitCode) ? { exitCode: command.exitCode } : {}),
    ...(typeof command?.signal === "string" || command?.signal === null ? { signal: command.signal } : {}),
    ...(typeof command?.skipKind === "string" ? { skipKind: command.skipKind } : {}),
    ...(Array.isArray(command?.missingEncoders) ? { missingEncoders: command.missingEncoders } : {}),
  };
}

function logicalPlatformId(value) {
  if (value === "win32") return "windows";
  if (value === "darwin") return "macos";
  if (value === "linux") return "linux";
  return "other";
}

function isAggregateReceipt(receipt) {
  return receipt.schema === "shellx-motion/platform-verification-aggregate@1";
}

function requireValue(values, index, flag) {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function selectCommands(only, options) {
  // An explicit --only selection overrides the tier filter: naming a command is the opt-in.
  if (only) {
    const known = new Set(COMMANDS.map((command) => command.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Unknown platform verification command id: ${unknown.join(", ")}`);
    return COMMANDS.filter((command) => only.includes(command.id));
  }
  return COMMANDS.filter((command) => commandTier(command) === DEFAULT_COMMAND_TIER || options.includeExtended === true);
}

function commandTier(command) {
  return typeof command.tier === "string" && command.tier.trim() ? command.tier.trim() : DEFAULT_COMMAND_TIER;
}

function runCommands(receipt, options) {
  if (options.requireExactToolchain && receipt.toolchain?.exact !== true) {
    finalizeBlockedRun(receipt, "toolchain-gate-failed", "Exact local toolchain evidence did not pass before host commands.");
    return;
  }
  if (options.requireBundledCodecs && receipt.toolchain?.bundledCodecs !== true) {
    finalizeBlockedRun(receipt, "toolchain-gate-failed", "Configured FFmpeg/FFprobe are not verified ShellX-bundled codec binaries.");
    return;
  }
  let firstFailureId = null;
  for (const command of receipt.commands) {
    const gate = evaluateCommandGate(command, receipt, options);
    if (gate) {
      command.durationMs = 0;
      command.status = gate.status;
      command.skipKind = gate.skipKind;
      command.skipReason = gate.reason;
      if (gate.missingEncoders) command.missingEncoders = gate.missingEncoders;
      if (command.status === "failed") {
        firstFailureId ??= command.id;
        if (!options.collectAll) break;
      }
      continue;
    }

    const started = Date.now();
    command.status = "running";
    command.timeoutMs = options.commandTimeoutMs;
    const processCommand = platformProcessCommand(command.command);
    const outputFiles = options.json ? commandOutputFiles(receipt, command) : null;
    const result = outputFiles
      ? spawnCommandWithFileOutput(processCommand, receipt.repoRoot, options.commandTimeoutMs, outputFiles)
      : spawnSync(processCommand.executable, processCommand.args, {
        cwd: receipt.repoRoot,
        encoding: "utf8",
        timeout: options.commandTimeoutMs,
        stdio: "inherit"
      });
    const timedOut = result.error && result.error.code === "ETIMEDOUT";
    const spawnFailed = Boolean(result.error && !timedOut);
    command.exitCode = timedOut ? 124 : spawnFailed ? spawnErrorExitCode(result.error) : result.status ?? (result.signal ? 1 : 0);
    command.signal = result.signal ?? null;
    command.durationMs = Date.now() - started;
    command.status = command.exitCode === 0 ? "passed" : "failed";
    if (timedOut) {
      command.timedOut = true;
    }
    if (options.json) {
      command.stdoutTail = tail(readOptionalText(outputFiles.stdout));
      const timeoutMessage = timedOut
        ? `Platform verification command ${command.id} timed out after ${options.commandTimeoutMs}ms.`
        : "";
      const spawnErrorMessage = spawnFailed ? result.error.message : "";
      command.stderrTail = tail([readOptionalText(outputFiles.stderr), timeoutMessage, spawnErrorMessage].filter(Boolean).join("\n"));
    }
    if (command.status === "failed") {
      firstFailureId ??= command.id;
      if (!options.collectAll) break;
    }
  }
  for (const command of receipt.commands) {
    if (command.status !== "pending") continue;
    command.status = "skipped";
    // Distinct from "capability-absent": this command was never evaluated, so it is not evidence of health.
    command.skipKind = "blocked-by-earlier-failure";
    command.skipReason = firstFailureId
      ? `Not executed: fail-fast stopped the run after ${firstFailureId} failed. Re-run with --collect-all to evaluate every command.`
      : "Not executed: the run stopped before this command.";
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.commandSummary = summarizeCommandStatuses(receipt.commands);
  receipt.status = receipt.commands.some((command) => command.status === "failed") ? "failed" : "passed";
}

/**
 * Decide whether a command may run on this host before spawning it.
 * @returns {null|{status: "skipped"|"failed", skipKind: string, reason: string, missingEncoders?: string[]}}
 *          null means "run it"; otherwise the resolved terminal status with a recorded, visible reason.
 */
function evaluateCommandGate(command, receipt, options) {
  const platforms = Array.isArray(command.platforms) ? command.platforms : [];
  if (platforms.length > 0 && !platforms.includes(receipt.host.platform)) {
    return {
      status: "skipped",
      skipKind: "platform-inapplicable",
      reason: `Command applies only to host platform(s): ${platforms.join(", ")}; this receipt is ${receipt.host.platform}.`
    };
  }
  const missingEnv = missingRequiredEnv(command);
  if (missingEnv.length > 0) {
    return {
      status: command.required ? "failed" : "skipped",
      skipKind: "environment-absent",
      reason: `Missing required environment variables: ${missingEnv.join(", ")}.`
    };
  }
  const requiredEncoders = Array.isArray(command.requiresEncoders) ? command.requiresEncoders : [];
  if (requiredEncoders.length === 0) return null;
  const inventory = receipt.toolchain?.encoders;
  const capabilities = inventory?.capabilities && typeof inventory.capabilities === "object" && !Array.isArray(inventory.capabilities)
    ? inventory.capabilities
    : null;
  // An inventory that could not be taken is UNKNOWN, not "absent". Claiming a codec is unsupported
  // because FFmpeg is missing would let a broken host quietly skip a claimed capability.
  if (!capabilities || inventory.reason) {
    return {
      status: "failed",
      skipKind: "capability-unknown",
      reason: `FFmpeg encoder inventory unavailable, so ${requiredEncoders.join(", ")} support cannot be judged: ${safeHumanText(inventory?.reason || "no encoder inventory in this run")}`,
      missingEncoders: requiredEncoders
    };
  }
  const missingEncoders = requiredEncoders.filter((id) => capabilities[id] !== true);
  if (missingEncoders.length === 0) return null;
  if (options.requireModernCodecs) {
    return {
      status: "failed",
      skipKind: "capability-absent",
      reason: `--require-modern-codecs is set, but this host's FFmpeg does not advertise: ${missingEncoders.join(", ")}.`,
      missingEncoders
    };
  }
  return {
    status: "skipped",
    skipKind: "capability-absent",
    reason: `Host FFmpeg does not advertise encoder capability: ${missingEncoders.join(", ")}. This host never claimed the codec, so the gate is skipped rather than failed; use --require-modern-codecs to demand it.`,
    missingEncoders
  };
}

function finalizeBlockedRun(receipt, skipKind, failure) {
  for (const command of receipt.commands) {
    command.status = "skipped";
    command.skipKind = skipKind;
    command.skipReason = failure;
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.commandSummary = summarizeCommandStatuses(receipt.commands);
  receipt.status = "failed";
  receipt.failure = failure;
}

function summarizeCommandStatuses(commands) {
  const summary = { total: commands.length, passed: 0, failed: 0, skipped: 0, skippedByKind: {} };
  for (const command of commands) {
    if (command.status === "passed") summary.passed += 1;
    else if (command.status === "failed") summary.failed += 1;
    else if (command.status === "skipped") {
      summary.skipped += 1;
      const kind = typeof command.skipKind === "string" && command.skipKind ? command.skipKind : "unspecified";
      summary.skippedByKind[kind] = (summary.skippedByKind[kind] ?? 0) + 1;
    }
  }
  return summary;
}

function spawnErrorExitCode(error) {
  return error && error.code === "ENOENT" ? 127 : 1;
}

function commandOutputFiles(receipt, command) {
  const outputDir = join(commandOutputRoot ?? resolve(receipt.repoRoot, ".scratch", "platform-verification", "command-output"), safePathSegment(receipt.host.id));
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const baseName = safePathSegment(command.id);
  return {
    stdout: resolve(outputDir, `${baseName}.stdout.log`),
    stderr: resolve(outputDir, `${baseName}.stderr.log`)
  };
}

function safePathSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function spawnCommandWithFileOutput(processCommand, cwd, timeout, outputFiles) {
  const stdout = openSync(outputFiles.stdout, "w");
  const stderr = openSync(outputFiles.stderr, "w");
  try {
    return spawnSync(processCommand.executable, processCommand.args, {
      cwd,
      timeout,
      stdio: ["ignore", stdout, stderr]
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

function readOptionalText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

function platformProcessCommand(command) {
  if (platform() === "win32" && command[0] === "pnpm") {
    return { executable: "cmd.exe", args: ["/d", "/s", "/c", "pnpm", ...command.slice(1)] };
  }
  return { executable: command[0], args: command.slice(1) };
}

function missingRequiredEnv(command) {
  if (!Array.isArray(command.requiresEnv)) return [];
  return command.requiresEnv.filter((name) => !process.env[name]);
}

function tail(value) {
  const limit = 4000;
  return value.length > limit ? value.slice(value.length - limit) : value;
}

function printHumanSummary(receipt, options) {
  if (isAggregateReceipt(receipt)) {
    writeHumanLine(`ShellX Motion platform receipt verification: ${safeHumanText(receipt.status)}`);
    writeHumanLine(`Required hosts: ${safeHumanList(receipt.requiredHosts)}`);
    writeHumanLine(`Satisfied: ${receipt.summary.satisfiedHostCount}/${receipt.summary.requiredHostCount}; missing=${safeHumanList(receipt.summary.missingHosts)}; failed=${safeHumanList(receipt.summary.failedHosts)}`);
    for (const item of receipt.receipts) {
      const status = item.ok ? "passed" : "failed";
      writeHumanLine(`${status.padEnd(8)} ${safeHumanText(item.hostId ?? "unknown")}: ${safeHumanText(item.path)}`);
    }
    for (const skip of receipt.summary.capabilitySkips ?? []) {
      writeHumanLine(`skipped  ${safeHumanText(skip.hostId ?? "unknown")}: ${safeHumanText(skip.command)} [capability-absent: ${safeHumanList(skip.missingEncoders)}]`);
    }
    for (const skip of receipt.summary.platformInapplicableSkips ?? []) {
      writeHumanLine(`skipped  ${safeHumanText(skip.hostId ?? "unknown")}: ${safeHumanText(skip.command)} [platform-inapplicable: ${safeHumanText(skip.hostPlatform)} not in ${safeHumanList(skip.platforms)}]`);
    }
    if (options.out) writeHumanLine(`Receipt: ${safeHumanText(resolve(options.out))}`);
    return;
  }
  const mode = options.run ? "run" : "dry-run";
  writeHumanLine(`ShellX Motion platform verification ${mode}: ${safeHumanText(receipt.status)}`);
  writeHumanLine(`Host: ${safeHumanText(receipt.host.id)} (${safeHumanText(receipt.host.platform)}/${safeHumanText(receipt.host.arch)})`);
  writeHumanLine(`Toolchain: ${safeHumanText(receipt.toolchain?.status ?? "missing")}; exact=${receipt.toolchain?.exact === true}; bundled-codecs=${receipt.toolchain?.bundledCodecs === true}`);
  writeHumanLine(`Mode: ${receipt.failFast === false ? "collect-all" : "fail-fast"}; extended-tier=${receipt.includeExtended === true}; modern-codecs-required=${receipt.modernCodecsRequired === true}`);
  if (receipt.hostMatrix) {
    writeHumanLine(`Required hosts: ${safeHumanList(receipt.hostMatrix.required)}; current=${safeHumanText(receipt.hostMatrix.current)}; missing=${safeHumanList(receipt.hostMatrix.missing)}`);
  }
  if (receipt.commandSummary) {
    const kinds = Object.entries(receipt.commandSummary.skippedByKind)
      .map(([kind, count]) => `${kind}=${count}`);
    writeHumanLine(`Commands: total=${receipt.commandSummary.total}; passed=${receipt.commandSummary.passed}; failed=${receipt.commandSummary.failed}; skipped=${receipt.commandSummary.skipped} (${safeHumanList(kinds)})`);
  }
  for (const command of receipt.commands) {
    // The skip kind is printed inline so a reader can never confuse "host lacks the codec" with
    // "we never got here because something earlier broke".
    const detail = command.skipKind ? ` [${safeHumanText(command.skipKind)}: ${safeHumanText(command.skipReason ?? "")}]` : "";
    writeHumanLine(`${safeHumanText(command.status).padEnd(8)} ${safeHumanText(command.id)}: ${safeHumanList(command.command, " ")}${detail}`);
  }
  if (options.out) writeHumanLine(`Receipt: ${safeHumanText(resolve(options.out))}`);
}

function printHelp() {
  writeHumanBlock(`Usage: pnpm run platform:verify -- [options]

Options:
  --dry-run              Print the planned host verification receipt (default)
  --run                  Execute the verification commands sequentially
  --json                 Print machine-readable JSON
  --shareable            Emit a redacted, non-replayable shareable projection with --json/--out
  --out <path>           Write the receipt JSON to a file
  --host-id <id>         Override host id (default: SHELLX_MOTION_HOST_ID or hostname)
  --required-hosts <ids> Required host ids for matrix evidence (default: linux,windows,macos; use "none" to omit)
  --verify-receipts <paths...> Verify collected platform receipts for all required hosts
  --require-host-connectors Promote env-gated Cut/Design Studio connector checks to required commands
  --phase2-connectors      Alias for --require-host-connectors
  --require-exact-toolchain Require hashed Node/pnpm/FFmpeg/FFprobe and required encoder evidence
  --require-bundled-codecs Require exact toolchain plus configured ShellX-bundled FFmpeg/FFprobe
  --require-modern-codecs  Fail (instead of skip) when the host FFmpeg does not advertise hevc/av1
  --include-extended       Include extended-tier commands (template-pack:proof, ~5 minutes)
  --collect-all            Run every command even after a failure and report the complete result set
  --no-fail-fast           Alias for --collect-all
  --only <id,id>         Run or plan only selected command ids
  --command-timeout-ms <n> Per-command timeout in milliseconds (default: ${DEFAULT_COMMAND_TIMEOUT_MS})
  --help                 Show this help
`);
}

function writeHumanLine(value) {
  process.stdout.write(`${safeHumanText(value)}\n`);
}

function writeHumanBlock(value) {
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}

function safeHumanList(values, separator = ", ") {
  const safe = Array.isArray(values) ? values.map((value) => safeHumanText(value)).filter(Boolean) : [];
  return safe.length > 0 ? safe.join(separator) : "none";
}

function safeHumanText(value) {
  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?");
}
