import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  governorRun: vi.fn(),
  acquire: vi.fn(),
  probe: vi.fn()
}));

vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...(await importOriginal()),
  defaultLocalMotionJobGovernor: { run: seams.governorRun },
  localMotionJobPolicyFromEnvironment: () => ({ maxProcessTreeRssBytes: 8 * 1024 * 1024 * 1024 }),
  OutputDirectoryReservation: { acquire: seams.acquire }
}));
vi.mock("@shellx-motion/renderer-browser", async (importOriginal) => ({
  ...(await importOriginal()),
  runGpuActiveHardwareProbe: seams.probe
}));

import { runGovernedDebugGpuHardwareProbe } from "./gpu-hardware-probe-governance.js";

const roots: string[] = [];

afterEach(async () => {
  seams.governorRun.mockReset();
  seams.acquire.mockReset();
  seams.probe.mockReset();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("Debug GPU hardware probe governance", () => {
  it("uses the shared POSIX containment evidence mapper while retaining the exact browser PID and private scratch authority", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-gpu-governance-"));
    roots.push(scratchRoot);
    const watchProcess = vi.fn();
    const reportProcessContainment = vi.fn();
    const authority = { path: "", assertCurrent: vi.fn(async () => undefined) };

    seams.governorRun.mockImplementation(async (_request, run) => ({
      value: await run({ scratchRoot, signal: new AbortController().signal, watchProcess, reportProcessContainment })
    }));
    seams.acquire.mockImplementation(async (path: string) => {
      authority.path = path;
      await mkdir(path);
      return authority;
    });
    seams.probe.mockImplementation(async (options: { onBrowserProcess?: (browser: unknown) => void }) => {
      options.onBrowserProcess?.({
        pid: 4_242,
        launcher: "precontained-direct-chromium",
        containment: {
          rootPid: 4_242,
          mode: "unix-process-group",
          status: "enforced",
          killTree: true,
          memoryLimit: "rss-monitor",
          maxProcessTreeRssBytes: 8 * 1024 * 1024 * 1024
        }
      });
      return { ok: true, proof: {}, frame: { width: 4, height: 4, sha256: "a".repeat(64) } };
    });

    await expect(runGovernedDebugGpuHardwareProbe(scratchRoot)).resolves.toMatchObject({ ok: true });

    expect(watchProcess).toHaveBeenCalledExactlyOnceWith(4_242);
    expect(reportProcessContainment).toHaveBeenCalledExactlyOnceWith({
      schema: "shellx-motion/process-containment@1",
      mode: "unix-process-group",
      status: "enforced",
      killTree: true,
      memoryLimit: "rss-monitor"
    });
    expect(seams.probe).toHaveBeenCalledWith(expect.objectContaining({
      scratchRoot: authority.path,
      scratchAuthority: authority,
      maxProcessTreeRssBytes: 8 * 1024 * 1024 * 1024
    }));
  });

  it("refuses forged Windows containment before registering or reporting the browser", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-gpu-governance-"));
    roots.push(scratchRoot);
    const watchProcess = vi.fn();
    const reportProcessContainment = vi.fn();
    const authority = { path: "", assertCurrent: vi.fn(async () => undefined) };

    seams.governorRun.mockImplementation(async (_request, run) => ({
      value: await run({ scratchRoot, signal: new AbortController().signal, watchProcess, reportProcessContainment })
    }));
    seams.acquire.mockImplementation(async (path: string) => {
      authority.path = path;
      await mkdir(path);
      return authority;
    });
    seams.probe.mockImplementation(async (options: { onBrowserProcess?: (browser: unknown) => void }) => {
      options.onBrowserProcess?.({
        pid: 4_242,
        launcher: "precontained-direct-chromium",
        containment: {
          rootPid: 4_242,
          mode: "windows-job-object",
          status: "enforced",
          killTree: true,
          memoryLimit: "job-commit",
          maxProcessTreeRssBytes: 8 * 1024 * 1024 * 1024
        }
      });
      return { ok: true, proof: {}, frame: { width: 4, height: 4, sha256: "a".repeat(64) } };
    });

    await expect(runGovernedDebugGpuHardwareProbe(scratchRoot)).resolves.toMatchObject({
      ok: false,
      failure: { code: "gpu_browser_launch_failed" }
    });
    expect(watchProcess).not.toHaveBeenCalled();
    expect(reportProcessContainment).not.toHaveBeenCalled();
  });
});
