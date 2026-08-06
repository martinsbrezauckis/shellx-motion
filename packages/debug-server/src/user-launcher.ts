#!/usr/bin/env tsx
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runMotionDebugServerCli } from "./cli";

/**
 * Human entry point. Expert/debug-server defaults stay conservative; Start Motion
 * deliberately grants local package creation, persists the per-user access key,
 * publishes the live port for MCP bridges, and opens an authenticated Workbench.
 * Remote publishing remains unavailable.
 */
export function userLaunchArgs(argv: string[]): string[] {
  const args = [...argv];
  if (!args.includes("--tier") && !args.includes("--default-tier")) {
    args.push("--tier", "write_local", "--trusted-local-tier");
  }
  if (!args.includes("--persistent-access")) args.push("--persistent-access");
  if (!args.includes("--open-workbench")) args.push("--open-workbench");
  return args;
}

function isDirectEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return fileURLToPath(moduleUrl) === argv1;
  }
}

if (isDirectEntry(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await runMotionDebugServerCli(userLaunchArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      command: "start-motion",
      error: {
        code: "start_motion_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    })}\n`);
    process.exitCode = 1;
  }
}
