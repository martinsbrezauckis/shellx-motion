import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
type RequiredCommandPlan = { id: string; command: string[]; platforms: string[] };
let requiredCommandsPromise: Promise<RequiredCommandPlan[]> | null = null;

/** Build complete representative receipts from the verifier's own current required-command plan. */
export async function writePlatformReceipt(
  root: string,
  hostId: string,
  options: { dryRun?: boolean; status?: string; failedCommandId?: string; platform?: string; suffix?: string; exactToolchain?: boolean; bundledCodecs?: boolean; workspaceIdentityInvalid?: boolean; workspaceCommit?: string; workspaceLockfileSha256?: string } = {}
): Promise<string> {
  const path = join(root, `${hostId}${options.suffix ? `-${options.suffix}` : ""}.platform.json`);
  const hostPlatform = options.platform ?? (hostId === "macos" ? "darwin" : hostId === "windows" ? "win32" : "linux");
  const commands = (await requiredCommands()).map(({ id, command, platforms }) => {
    const platformInapplicable = platforms.length > 0 && !platforms.includes(hostPlatform);
    const status = id === options.failedCommandId ? "failed" : platformInapplicable ? "skipped" : "passed";
    return {
      id, command, required: true, status, durationMs: status === "skipped" ? 0 : 1,
      ...(status === "passed" ? { exitCode: 0, signal: null } : {}),
      ...(status === "failed" ? { exitCode: 1, signal: null } : {}),
      ...(platformInapplicable ? { skipKind: "platform-inapplicable", skipReason: `Command applies only to host platform(s): ${platforms.join(", ")}.` } : {})
    };
  });
  const skippedByKind = commands.reduce<Record<string, number>>((counts, command) => {
    const kind = "skipKind" in command && typeof command.skipKind === "string" ? command.skipKind : "unspecified";
    if (command.status === "skipped") counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }, {});
  const receipt = {
    schema: "shellx-motion/platform-verification@1",
    status: options.status ?? (options.failedCommandId ? "failed" : "passed"),
    dryRun: options.dryRun ?? false,
    host: { id: hostId, hostname: `${hostId}.example.test`, platform: hostPlatform, arch: "x64", release: "test", node: process.version },
    toolchain: options.exactToolchain ? exactToolchain(options) : { status: "missing", exact: false, bundledCodecs: false },
    hostMatrix: {
      required: ["linux", "windows", "macos"], current: hostId, currentRequired: true,
      satisfied: [hostId], missing: ["linux", "windows", "macos"].filter((id) => id !== hostId),
      complete: false, status: "partial"
    },
    repoRoot: resolve("../.."),
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:01:00.000Z",
    commandSummary: {
      total: commands.length,
      passed: commands.filter((command) => command.status === "passed").length,
      failed: commands.filter((command) => command.status === "failed").length,
      skipped: commands.filter((command) => command.status === "skipped").length,
      skippedByKind
    },
    commands
  };
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return path;
}

function requiredCommands(): Promise<RequiredCommandPlan[]> {
  requiredCommandsPromise ??= (async () => {
    const { stdout } = await execFile(process.execPath, [resolve("../../scripts/platform-verify.mjs"), "--dry-run", "--json"], {
      cwd: resolve("../.."), maxBuffer: 32 * 1024 * 1024
    });
    const plan = JSON.parse(stdout) as { commands?: Array<{ id?: unknown; command?: unknown; required?: unknown; platforms?: unknown }> };
    const commands = (plan.commands ?? [])
      .filter((command) => command.required === true && typeof command.id === "string" && command.id.length > 0)
      .map((command) => ({
        id: command.id as string,
        command: Array.isArray(command.command) ? command.command.filter((entry): entry is string => typeof entry === "string") : [],
        platforms: Array.isArray(command.platforms) ? command.platforms.filter((entry): entry is string => typeof entry === "string") : []
      }));
    if (commands.length === 0) throw new Error("platform-verify planned no required commands; the host-receipt fixture would be meaningless.");
    return commands;
  })();
  return requiredCommandsPromise;
}

function exactToolchain(options: { bundledCodecs?: boolean; workspaceIdentityInvalid?: boolean; workspaceCommit?: string; workspaceLockfileSha256?: string }) {
  return {
    status: "passed", exact: true, bundledCodecs: options.bundledCodecs === true,
    workspace: options.workspaceIdentityInvalid
      ? { status: "passed", exact: true, commit: null, trackedDirty: false, lockfileSha256: null }
      : { status: "passed", exact: true, commit: options.workspaceCommit ?? "d".repeat(40), trackedDirty: false, lockfileSha256: options.workspaceLockfileSha256 ?? "e".repeat(64) },
    node: { sha256: "a".repeat(64) }, ffmpeg: { sha256: "b".repeat(64) }, ffprobe: { sha256: "c".repeat(64) },
    encoders: { capabilities: { h264: true, vp9: true, prores: true, hevc: true, av1: true } }
  };
}
