import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLocalMotionJobGovernor } from "@shellx-motion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAgentRuntime, type AgentAdapter } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function stubAgentJobGovernor(scratchRoot: string): void {
  vi.spyOn(defaultLocalMotionJobGovernor, "run").mockImplementation((async (_request: unknown, operation: (context: {
    jobId: string;
    signal: AbortSignal;
    scratchRoot: string;
    watchProcess: (pid: number) => void;
    reportProcessContainment: (evidence: unknown) => void;
    reportSandbox: (evidence: unknown) => void;
  }) => Promise<unknown>) => ({
    value: await operation({
      jobId: "agent-runtime-windows-test",
      signal: new AbortController().signal,
      scratchRoot,
      watchProcess: () => undefined,
      reportProcessContainment: () => undefined,
      reportSandbox: () => undefined,
    }),
    evidence: {},
  })) as never);
}

const fakeAdapter: AgentAdapter = {
  id: "fake",
  label: "Fake Agent",
  transport: "local-cli",
  billing: "cli-subscription",
  promptContextMode: "prompt-only",
  probeCommand: () => ({ executable: "fake-agent", args: ["--version"], shell: false }),
  promptCommand: (input) => ({ executable: "fake-agent", args: ["run", "--json"], cwd: input.cwd, stdin: input.prompt, shell: false })
};

describe("Windows provider command identity", () => {
  it.skipIf(process.platform !== "win32")("keeps the canonical PATH executable when Windows Job Object planning falls back", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-agent-fallback-path-"));
    tempDirs.push(outDir);
    const trustedDir = join(outDir, "trusted");
    const untrustedCwd = join(outDir, "package");
    await mkdir(trustedDir);
    await mkdir(untrustedCwd);
    const trustedExecutable = join(trustedDir, "fallback-agent.exe");
    const shadowExecutable = join(untrustedCwd, "fallback-agent.exe");
    await copyFile(process.execPath, trustedExecutable);
    await copyFile(process.execPath, shadowExecutable);
    stubAgentJobGovernor(outDir);
    const previousHelper = process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER;
    const previousRequireNative = process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
    process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER = join(outDir, "missing-helper.ps1");
    delete process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
    const pathAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "fallback-path",
      probeCommand: () => ({
        executable: "fallback-agent",
        args: ["-e", "process.stdout.write(process.execPath)"],
        cwd: untrustedCwd,
        env: { PATH: `${trustedDir};${process.env.PATH ?? process.env.Path ?? ""}` },
        shell: false,
      }),
      promptCommand: () => ({ executable: "fallback-agent", args: [], shell: false }),
    };
    try {
      const [health] = await buildAgentRuntime({ adapters: [pathAdapter] }).health();
      expect(health).toMatchObject({ agentId: "fallback-path", available: true, status: "ready" });
      expect(health.version?.toLowerCase()).toBe(trustedExecutable.toLowerCase());
      expect(health.version?.toLowerCase()).not.toBe(shadowExecutable.toLowerCase());
    } finally {
      if (previousHelper === undefined) delete process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER;
      else process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER = previousHelper;
      if (previousRequireNative === undefined) delete process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
      else process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT = previousRequireNative;
    }
  }, 45_000);

  it.skipIf(process.platform !== "win32")("keeps the canonical PATH executable when Windows Job Object setup reports unavailable", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-agent-fallback-status-"));
    tempDirs.push(outDir);
    const trustedDir = join(outDir, "trusted");
    const untrustedCwd = join(outDir, "package");
    await mkdir(trustedDir);
    await mkdir(untrustedCwd);
    const trustedExecutable = join(trustedDir, "status-agent.exe");
    const shadowExecutable = join(untrustedCwd, "status-agent.exe");
    await copyFile(process.execPath, trustedExecutable);
    await copyFile(process.execPath, shadowExecutable);
    stubAgentJobGovernor(outDir);
    const unavailableHelper = join(outDir, "status-unavailable.ps1");
    await writeFile(unavailableHelper, [
      "param([Parameter(Mandatory=$true)][string]$RequestPath)",
      "$request = Get-Content -Raw -LiteralPath $RequestPath | ConvertFrom-Json",
      "$status = [ordered]@{ schema = 'shellx-motion/windows-job-status@1'; status = 'unavailable'; mode = 'windows-job-object'; reasonCode = 'native_setup_failed' } | ConvertTo-Json -Compress",
      "[System.IO.File]::WriteAllText([string]$request.statusPath, $status, [System.Text.UTF8Encoding]::new($false))",
      "exit 1",
    ].join("\r\n"), "utf8");
    const previousHelper = process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER;
    const previousRequireNative = process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
    process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER = unavailableHelper;
    delete process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
    const pathAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "fallback-status",
      probeCommand: () => ({
        executable: "status-agent",
        args: ["-e", "process.stdout.write(process.execPath)"],
        cwd: untrustedCwd,
        env: { PATH: `${trustedDir};${process.env.PATH ?? process.env.Path ?? ""}` },
        shell: false,
      }),
      promptCommand: () => ({ executable: "status-agent", args: [], shell: false }),
    };
    try {
      const [health] = await buildAgentRuntime({ adapters: [pathAdapter] }).health();
      expect(health).toMatchObject({ agentId: "fallback-status", available: true, status: "ready" });
      expect(health.version?.toLowerCase()).toBe(trustedExecutable.toLowerCase());
      expect(health.version?.toLowerCase()).not.toBe(shadowExecutable.toLowerCase());
    } finally {
      if (previousHelper === undefined) delete process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER;
      else process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER = previousHelper;
      if (previousRequireNative === undefined) delete process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
      else process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT = previousRequireNative;
    }
  }, 45_000);

  it.skipIf(process.platform !== "win32")("launches a canonical Windows provider command shim through the fixed system host", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-agent-fallback-cmd-"));
    tempDirs.push(outDir);
    const trustedDir = join(outDir, "trusted");
    const untrustedCwd = join(outDir, "package");
    await mkdir(trustedDir);
    await mkdir(untrustedCwd);
    await writeFile(join(trustedDir, "shim-agent.cmd"), "@echo trusted-command\r\n", "utf8");
    await writeFile(join(untrustedCwd, "shim-agent.cmd"), "@echo shadow-command\r\n", "utf8");
    stubAgentJobGovernor(outDir);
    const previousHelper = process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER;
    const previousRequireNative = process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
    process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER = join(outDir, "missing-helper.ps1");
    delete process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
    const pathAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "fallback-shim",
      probeCommand: () => ({
        executable: "shim-agent",
        args: [],
        cwd: untrustedCwd,
        env: { PATH: `${trustedDir};${process.env.PATH ?? process.env.Path ?? ""}` },
        shell: false,
      }),
      promptCommand: () => ({ executable: "shim-agent", args: [], shell: false }),
    };
    try {
      const [health] = await buildAgentRuntime({ adapters: [pathAdapter] }).health();
      expect(health).toMatchObject({
        agentId: "fallback-shim",
        available: true,
        status: "ready",
        version: "trusted-command",
      });
    } finally {
      if (previousHelper === undefined) delete process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER;
      else process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER = previousHelper;
      if (previousRequireNative === undefined) delete process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
      else process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT = previousRequireNative;
    }
  }, 45_000);

  it.skipIf(process.platform !== "win32")("keeps the canonical provider shim and arguments inside enforced Job Object execution", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-agent-native-cmd-"));
    tempDirs.push(outDir);
    const trustedDir = join(outDir, "trusted");
    const untrustedCwd = join(outDir, "package");
    await mkdir(trustedDir);
    await mkdir(untrustedCwd);
    const trustedShim = join(trustedDir, "native-shim-agent.cmd");
    const shadowShim = join(untrustedCwd, "shadow-provider.cmd");
    await writeFile(trustedShim, "@echo trusted-native-command\r\n", "utf8");
    await writeFile(shadowShim, "@echo shadow-command\r\n", "utf8");
    stubAgentJobGovernor(outDir);
    const previousHelper = process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER;
    const previousRequireNative = process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
    delete process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER;
    process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT = "1";
    const pathAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "native-shim",
      probeCommand: () => ({
        executable: "native-shim-agent",
        args: [],
        cwd: untrustedCwd,
        env: {
          PATH: `${trustedDir};${process.env.PATH ?? process.env.Path ?? ""}`,
          SHELLX_MOTION_PROVIDER_PATH: shadowShim,
          SHELLX_MOTION_PROVIDER_ARGS: "[]",
        },
        shell: false,
      }),
      promptCommand: () => ({ executable: "native-shim-agent", args: [], shell: false }),
    };
    try {
      const [health] = await buildAgentRuntime({ adapters: [pathAdapter] }).health();
      expect(health).toMatchObject({
        agentId: "native-shim",
        available: true,
        status: "ready",
        version: "trusted-native-command",
      });
    } finally {
      if (previousHelper === undefined) delete process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER;
      else process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER = previousHelper;
      if (previousRequireNative === undefined) delete process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
      else process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT = previousRequireNative;
    }
  }, 45_000);
});
