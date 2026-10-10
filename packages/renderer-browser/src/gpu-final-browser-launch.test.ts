import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

  it("asks Chromium to close over CDP before disconnecting and avoids a group signal after orderly exit", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "motion-gpu-final-orderly-close-"));
    try {
      const order: string[] = [];
      const child = fakeChild(order, 4_242);
      const killProcessGroup = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) {
          if (child.exitCode !== null || child.signalCode !== null) throw Object.assign(new Error("gone"), { code: "ESRCH" });
          return;
        }
        order.push(`pgid:${pid}:${signal}`);
        child.exit();
      });
      const cdp = { send: vi.fn(async (method: string) => {
        order.push(`cdp:${method}`);
        setTimeout(() => child.exit(), 25);
      }) };
      const browser = {
        newBrowserCDPSession: vi.fn(async () => cdp),
        close: vi.fn(async () => { order.push("transport-close"); })
      };
      const launched = await launchPrecontainedGpuBrowser("/trusted/chrome", { scratchRoot, maxProcessTreeRssBytes: 512 * 1024 * 1024 }, {
        platform: "linux",
        spawnProcess: vi.fn(() => { order.push("spawn"); return child; }) as never,
        waitForDevTools: vi.fn(async () => { order.push("devtools"); return "ws://127.0.0.1:9222/devtools/browser/test"; }),
        connectOverCDP: vi.fn(async () => { order.push("connect"); return browser as never; }),
        killProcessGroup
      });

      await launched.close();

      expect(order).toEqual(["spawn", "devtools", "connect", "cdp:Browser.close", "transport-close", "exit"]);
      expect(killProcessGroup).not.toHaveBeenCalledWith(-4_242, "SIGTERM");
      expect(killProcessGroup).not.toHaveBeenCalledWith(-4_242, "SIGKILL");
      expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("gpu-final-chromium-"))).toEqual([]);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it("bounds hanging CDP and transport closes before using the retained exact group fallback", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "motion-gpu-final-hanging-close-"));
    try {
      const child = fakeChild([], 4_242);
      const killProcessGroup = fakeProcessGroupKiller(child, []);
      const browser = {
        newBrowserCDPSession: vi.fn(async () => ({ send: vi.fn(() => new Promise<never>(() => undefined)) })),
        close: vi.fn(() => new Promise<never>(() => undefined))
      };
      const launched = await launchPrecontainedGpuBrowser("/trusted/chrome", { scratchRoot, maxProcessTreeRssBytes: 512 * 1024 * 1024 }, {
        platform: "linux", spawnProcess: vi.fn(() => child) as never,
        waitForDevTools: async () => "ws://127.0.0.1:9222/devtools/browser/test",
        connectOverCDP: async () => browser as never, killProcessGroup
      });

      await expect(launched.close()).rejects.toThrow("Playwright transport close exceeded its bounded shutdown deadline");

      expect(browser.newBrowserCDPSession).toHaveBeenCalledOnce();
      expect(browser.close).toHaveBeenCalledOnce();
      expect(killProcessGroup).toHaveBeenCalledWith(-4_242, "SIGTERM");
      expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("gpu-final-chromium-"))).toEqual([]);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it("treats a rejected CDP Browser.close request as inconclusive until the retained group is gone", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "motion-gpu-final-rejected-close-"));
    try {
      const child = fakeChild([], 4_242);
      const killProcessGroup = fakeProcessGroupKiller(child, []);
      const browser = {
        newBrowserCDPSession: vi.fn(async () => ({ send: vi.fn(async () => { throw new Error("target closed"); }) })),
        close: vi.fn(async () => undefined)
      };
      const launched = await launchPrecontainedGpuBrowser("/trusted/chrome", { scratchRoot, maxProcessTreeRssBytes: 512 * 1024 * 1024 }, {
        platform: "linux", spawnProcess: vi.fn(() => child) as never,
        waitForDevTools: async () => "ws://127.0.0.1:9222/devtools/browser/test",
        connectOverCDP: async () => browser as never, killProcessGroup
      });

      await launched.close();

      expect(browser.close).toHaveBeenCalledOnce();
      expect(killProcessGroup).toHaveBeenCalledWith(-4_242, "SIGTERM");
      expect((await readdir(scratchRoot)).filter((entry) => entry.startsWith("gpu-final-chromium-"))).toEqual([]);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it("retains the profile and reports both attach and cleanup failures when the exact group survives", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "motion-gpu-final-survivor-"));
    try {
      const child = fakeChild([], 4_242);
      const attachFailure = new Error("CDP attach failed");
      const killProcessGroup = vi.fn((_: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0 || signal === "SIGTERM" || signal === "SIGKILL") return;
      });
      let caught: unknown;
      try {
        await launchPrecontainedGpuBrowser("/trusted/chrome", { scratchRoot, maxProcessTreeRssBytes: 512 * 1024 * 1024 }, {
          platform: "linux", spawnProcess: vi.fn(() => child) as never,
          waitForDevTools: async () => "ws://127.0.0.1:9222/devtools/browser/test",
          connectOverCDP: async () => { throw attachFailure; }, killProcessGroup
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual([attachFailure, expect.any(Error)]);
      expect(killProcessGroup).toHaveBeenCalledWith(-4_242, "SIGTERM");
      expect(killProcessGroup).toHaveBeenCalledWith(-4_242, "SIGKILL");
      expect((await readdir(scratchRoot)).some((entry) => entry.startsWith("gpu-final-chromium-"))).toBe(true);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it("refuses a Windows contained browser that survives its final bounded kill", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4_242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true)
    });

    await expect(terminateContainedBrowser(child as never, {
      pid: 4_242, launcher: "precontained-direct-chromium",
      containment: { rootPid: 4_242, mode: "windows-job-object", status: "enforced", killTree: true, memoryLimit: "job-commit", maxProcessTreeRssBytes: 512 * 1024 * 1024, maxActiveProcesses: 4_096, launcher: { kind: "powershell-csharp", sha256: "a".repeat(64) } }
    }, "win32")).rejects.toThrow("could not confirm contained Windows browser cleanup");

    expect(child.kill).toHaveBeenNthCalledWith(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
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
