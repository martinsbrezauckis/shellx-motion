import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOwnedUnixProcessGroup } from "@shellx-motion/core";
import {
  gpuFinalBrowserArgs,
  gpuFinalPosixSpawnOptions,
  launchPrecontainedGpuBrowser,
  parseGpuDevToolsActivePort,
  terminateContainedBrowser
} from "./gpu-final-browser-launch";

describe("pre-contained GPU final browser launcher", () => {
  it("uses an isolated loopback profile and rejects malformed DevTools endpoints", () => {
    expect(gpuFinalBrowserArgs("/safe/gpu-profile", "linux")).toEqual(expect.arrayContaining([
      "--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=/safe/gpu-profile"
    ]));
    expect(gpuFinalPosixSpawnOptions("/safe")).toEqual({ cwd: "/safe", detached: true, stdio: "ignore", windowsHide: true });
    expect(parseGpuDevToolsActivePort("9222\n/devtools/browser/abc-123\n")).toBe("ws://127.0.0.1:9222/devtools/browser/abc-123");
    expect(parseGpuDevToolsActivePort("9222\nws://external.invalid\n")).toBeNull();
  });

  it("refuses missing admitted bounds before creating a profile or spawning Chrome", async () => {
    const spawnProcess = vi.fn();
    await expect(launchPrecontainedGpuBrowser("/trusted/chrome", { scratchRoot: "", maxProcessTreeRssBytes: 0 }, { spawnProcess: spawnProcess as never }))
      .rejects.toThrow("admitted process-tree memory limit");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("keeps the Windows Job helper alive through Chrome, then lets its normal exit release the Job", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "motion-gpu-final-launch-"));
    const order: string[] = [];
    const child = fakeChild(order);
    const plan = {
      executable: "powershell.exe" as const,
      args: ["-File", "trusted-launcher.ps1"],
      requestPath: join(scratchRoot, "request.json"), statusPath: join(scratchRoot, "status.json"), helperPath: "trusted-launcher.ps1", helperSha256: "a".repeat(64), maxJobMemoryBytes: 512 * 1024 * 1024, maxActiveProcesses: 4096
    };
    const browser = { close: vi.fn(async () => { order.push("browser-close"); child.exit(); }) };
    const launched = await launchPrecontainedGpuBrowser("C:\\trusted\\chrome.exe", { scratchRoot, maxProcessTreeRssBytes: 512 * 1024 * 1024 }, {
      platform: "win32",
      createWindowsPlan: vi.fn(async () => { order.push("plan"); return plan; }),
      spawnProcess: vi.fn(() => { order.push("spawn"); return child; }) as never,
      waitForWindowsStatus: vi.fn(async () => { order.push("status"); return { schema: "shellx-motion/windows-job-status@1" as const, status: "enforced" as const, mode: "windows-job-object" as const, childPid: 4_242, maxJobMemoryBytes: 512 * 1024 * 1024, maxActiveProcesses: 4096 }; }),
      waitForDevTools: vi.fn(async () => { order.push("devtools"); return "ws://127.0.0.1:9222/devtools/browser/test"; }),
      connectOverCDP: vi.fn(async () => { order.push("connect"); return browser as never; }),
      cleanupWindowsPlan: vi.fn(async () => { order.push("plan-cleanup"); })
    });
    expect(order).toEqual(["plan", "spawn", "status", "devtools", "connect"]);
    expect(launched.browserProcess).toMatchObject({ pid: 4_242, launcher: "precontained-direct-chromium", containment: { mode: "windows-job-object", status: "enforced", maxProcessTreeRssBytes: 512 * 1024 * 1024 } });
    await launched.close();
    expect(order).toEqual(["plan", "spawn", "status", "devtools", "connect", "browser-close", "exit", "plan-cleanup"]);
    expect(child.kill).not.toHaveBeenCalled();
    expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("gpu-final-chromium-"))).toEqual([]);
  });

  it("pins the native Windows helper to wait for Chrome before closing its kill-on-close Job", async () => {
    const helper = await readFile(new URL("../../core/assets/windows-job-object-launcher.ps1", import.meta.url), "utf8");
    const status = helper.indexOf("WriteStatus(statusPath, process.dwProcessId");
    const wait = helper.indexOf("WaitForSingleObject(process.hProcess, INFINITE)");
    const closeJob = helper.indexOf("if (job != IntPtr.Zero) CloseHandle(job)");
    expect(helper).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(status).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(status);
    expect(closeJob).toBeGreaterThan(wait);
  });

  it("kills the negative POSIX process group after an aborted pre-CDP launch and cleans its profile", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "motion-gpu-final-abort-"));
    const controller = new AbortController();
    const order: string[] = [];
    const child = fakeChild(order, 4_242);
    const killProcessGroup = fakeProcessGroupKiller(child, order);
    await expect(launchPrecontainedGpuBrowser("/trusted/chrome", {
      scratchRoot, maxProcessTreeRssBytes: 512 * 1024 * 1024, signal: controller.signal
    }, {
      platform: "linux",
      spawnProcess: vi.fn(() => { order.push("spawn"); return child; }) as never,
      waitForDevTools: vi.fn(async () => { controller.abort(new Error("operator cancelled")); throw controller.signal.reason; }),
      killProcessGroup
    })).rejects.toThrow("operator cancelled");
    expect(killProcessGroup).toHaveBeenCalledWith(-4_242, "SIGTERM");
    expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("gpu-final-chromium-"))).toEqual([]);
  });

  it("cleans a failed CDP attach through the exact negative POSIX group", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "motion-gpu-final-connect-"));
    const child = fakeChild([], 4_242);
    const killProcessGroup = fakeProcessGroupKiller(child, []);
    await expect(launchPrecontainedGpuBrowser("/trusted/chrome", { scratchRoot, maxProcessTreeRssBytes: 512 * 1024 * 1024 }, {
      platform: "linux", spawnProcess: vi.fn(() => child) as never,
      waitForDevTools: async () => "ws://127.0.0.1:9222/devtools/browser/test",
      connectOverCDP: async () => { throw new Error("CDP attach failed"); }, killProcessGroup
    })).rejects.toThrow("CDP attach failed");
    expect(killProcessGroup).toHaveBeenCalledWith(-4_242, "SIGTERM");
    expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("gpu-final-chromium-"))).toEqual([]);
  });

  it("refuses sentinel POSIX PIDs without targeting any process group", async () => {
    const child = fakeChild([], 1);
    const killProcessGroup = vi.fn();
    await expect(terminateContainedBrowser(child as never, {
      pid: 1, launcher: "precontained-direct-chromium",
      containment: { rootPid: 1, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 512 * 1024 * 1024 }
    }, "linux", killProcessGroup)).rejects.toThrow("unsafe process-group termination target");
    expect(killProcessGroup).not.toHaveBeenCalled();
  });

  it("keeps forced group escalation after the browser leader has already exited", async () => {
    const child = fakeChild([], 4_242);
    let groupAlive = true;
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return;
      }
      if (signal === "SIGKILL") groupAlive = false;
    });
    const ownedGroup = createOwnedUnixProcessGroup(child.pid, (pid, signal) => { killProcessGroup(pid, signal); });
    child.exit();

    await expect(terminateContainedBrowser(child as never, {
      pid: 4_242, launcher: "precontained-direct-chromium",
      containment: { rootPid: 4_242, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 512 * 1024 * 1024 }
    }, "linux", killProcessGroup, ownedGroup)).resolves.toBeUndefined();

    expect(killProcessGroup).toHaveBeenCalledWith(-4_242, "SIGKILL");
  }, 45_000);
});

function fakeChild(order: string[], pid = 8_081) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    exit: () => { order.push("exit"); child.exitCode = 0; child.emit("exit"); },
    kill: vi.fn(() => { order.push("kill"); child.exit(); return true; })
  });
  return child;
}

function fakeProcessGroupKiller(child: ReturnType<typeof fakeChild>, order: string[]) {
  return vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
    if (signal === 0) {
      if (child.exitCode !== null || child.signalCode !== null) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return;
    }
    order.push(`pgid:${pid}`);
    child.exit();
  });
}
