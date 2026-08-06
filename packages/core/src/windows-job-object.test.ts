import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupWindowsJobObjectLaunchPlan,
  createWindowsJobObjectLaunchPlan,
  waitForWindowsJobObjectStatus,
  windowsJobObjectContainmentEvidence,
} from "./windows-job-object";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("shared Windows Job Object launch planning", () => {
  it("stages a bounded shell-free request and records the trusted helper identity", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "shellx-motion-windows-job-plan-"));
    tempDirs.push(scratchRoot);
    const args = ["-i", "frame path with spaces/%06d.png", "", "quote\"and\\tail\\"];
    const plan = await createWindowsJobObjectLaunchPlan({
      executable: process.execPath,
      args,
      workingDirectory: process.cwd(),
      scratchRoot,
      maxJobMemoryBytes: 512 * 1024 * 1024,
      maxActiveProcesses: 32,
    });

    expect(plan.executable).toBe("powershell.exe");
    expect(plan.args).toEqual([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", plan.helperPath, "-RequestPath", plan.requestPath,
    ]);
    expect(plan.helperSha256).toMatch(/^[a-f0-9]{64}$/);
    const request = JSON.parse(await readFile(plan.requestPath, "utf8"));
    expect(request).toMatchObject({
      schema: "shellx-motion/windows-job-request@1",
      executable: await import("node:fs/promises").then(({ realpath }) => realpath(process.execPath)),
      arguments: args,
      statusPath: plan.statusPath,
      maxJobMemoryBytes: 512 * 1024 * 1024,
      maxActiveProcesses: 32,
    });
    expect(JSON.stringify(request)).not.toContain("powershell.exe -Command");
    await cleanupWindowsJobObjectLaunchPlan(plan);
  });

  it("accepts only status bound to the requested native limits", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "shellx-motion-windows-job-status-"));
    tempDirs.push(scratchRoot);
    const plan = await createWindowsJobObjectLaunchPlan({
      executable: process.execPath,
      args: ["--version"],
      workingDirectory: process.cwd(),
      scratchRoot,
      maxJobMemoryBytes: 768 * 1024 * 1024,
      maxActiveProcesses: 16,
    });
    await writeFile(plan.statusPath, JSON.stringify({
      schema: "shellx-motion/windows-job-status@1",
      status: "enforced",
      mode: "windows-job-object",
      childPid: 42,
      maxJobMemoryBytes: plan.maxJobMemoryBytes,
      maxActiveProcesses: plan.maxActiveProcesses,
    }), "utf8");

    const status = await waitForWindowsJobObjectStatus(plan, { timeoutMs: 100 });
    expect(status).toMatchObject({ status: "enforced", childPid: 42 });
    expect(windowsJobObjectContainmentEvidence(plan, status)).toEqual({
      schema: "shellx-motion/process-containment@1",
      mode: "windows-job-object",
      status: "enforced",
      killTree: true,
      memoryLimit: "job-commit",
      maxJobMemoryBytes: plan.maxJobMemoryBytes,
      maxActiveProcesses: plan.maxActiveProcesses,
      launcher: { kind: "powershell-csharp", sha256: plan.helperSha256 },
    });
  });

  it("rejects argument, process, and memory budgets before writing a request", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "shellx-motion-windows-job-bounds-"));
    tempDirs.push(scratchRoot);
    await expect(createWindowsJobObjectLaunchPlan({
      executable: process.execPath,
      args: ["x".repeat(24_001)],
      workingDirectory: process.cwd(),
      scratchRoot,
      maxJobMemoryBytes: 512 * 1024 * 1024,
    })).rejects.toThrow("character budget");
    await expect(createWindowsJobObjectLaunchPlan({
      executable: process.execPath,
      args: [],
      workingDirectory: process.cwd(),
      scratchRoot,
      maxJobMemoryBytes: 1,
    })).rejects.toThrow("memory limit");
    await expect(createWindowsJobObjectLaunchPlan({
      executable: process.execPath,
      args: [],
      workingDirectory: process.cwd(),
      scratchRoot,
      maxJobMemoryBytes: 512 * 1024 * 1024,
      maxActiveProcesses: 4_097,
    })).rejects.toThrow("active-process limit");
  });

  it("distinguishes a missing trusted helper from other launch-planning failures", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "shellx-motion-windows-job-errors-"));
    tempDirs.push(scratchRoot);
    await expect(createWindowsJobObjectLaunchPlan({
      executable: join(scratchRoot, "missing-child.exe"),
      args: [],
      workingDirectory: process.cwd(),
      scratchRoot,
      maxJobMemoryBytes: 512 * 1024 * 1024,
      helperPath: join(scratchRoot, "missing-helper.ps1"),
    })).rejects.toMatchObject({ reasonCode: "native_helper_missing" });
    await expect(createWindowsJobObjectLaunchPlan({
      executable: join(scratchRoot, "missing-child.exe"),
      args: [],
      workingDirectory: process.cwd(),
      scratchRoot,
      maxJobMemoryBytes: 512 * 1024 * 1024,
    })).rejects.toMatchObject({ reasonCode: "native_setup_failed" });
  });

  it.skipIf(process.platform !== "win32")("preserves empty, spaced, quoted, and trailing-slash child arguments through the native launcher", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "shellx-motion-windows-job-argv-"));
    tempDirs.push(scratchRoot);
    const outputPath = join(scratchRoot, "argv.json");
    const forwarded = ["", "space value", "quote\"value", "trailing\\"];
    const childCode = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))";
    const plan = await createWindowsJobObjectLaunchPlan({
      executable: process.execPath,
      args: ["-e", childCode, outputPath, ...forwarded],
      workingDirectory: process.cwd(),
      scratchRoot,
      maxJobMemoryBytes: 512 * 1024 * 1024,
      maxActiveProcesses: 8,
    });

    await execFileAsync(plan.executable, plan.args, { windowsHide: true });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(forwarded);
    expect(await waitForWindowsJobObjectStatus(plan, { timeoutMs: 100 })).toMatchObject({ status: "enforced" });
    await cleanupWindowsJobObjectLaunchPlan(plan);
  });
});
