import { spawn } from "node:child_process";
import { resolveWindowsSystemExecutable, type OwnedUnixProcessGroup } from "@shellx-motion/core";

export type AgentProcessTerminationMode = "windows-job-object" | "windows-taskkill-fallback" | "unix-process-group" | "direct-child";

/**
 * Terminate an agent and, where the launch contract established one, its process tree.
 * A negative pid targets a Unix process group, so invalid values must fall back to the child.
 */
export function terminateAgentProcessTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean },
  force: boolean,
  mode: AgentProcessTerminationMode,
  ownedUnixProcessGroup?: OwnedUnixProcessGroup
): void {
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  if (mode === "windows-taskkill-fallback" && child.pid) {
    try {
      const killer = spawn(resolveWindowsSystemExecutable("taskkill"), ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
      return;
    } catch {
      // Fall through to the direct child signal when taskkill itself cannot start.
    }
  } else if (mode === "unix-process-group") {
    // The launch path must capture this handle immediately after spawn. Never reconstruct group
    // authority from a bare numeric PID during cleanup, after the leader may already have exited.
    if (ownedUnixProcessGroup?.signal(signal)) return;
  }
  try { child.kill(signal); } catch { /* already exited */ }
}
