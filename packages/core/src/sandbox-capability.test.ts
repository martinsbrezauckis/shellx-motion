import { describe, expect, it } from "vitest";
import {
  createLocalMotionSandboxCapabilityReceipt,
  probeLocalMotionSandboxCapability,
  type LocalMotionSandboxProbeServices,
} from "./sandbox-capability";

describe("optional local sandbox capability evidence", () => {
  it("proves a fixed Linux network-denied read-only no-op without applying it to workers", async () => {
    const calls: Array<{ path: string; args: string[] }> = [];
    const services: LocalMotionSandboxProbeServices = {
      platform: "linux",
      locateExecutable: async () => ({ path: "/usr/bin/bwrap", sha256: "a".repeat(64) }),
      runExecutable: async (path, args) => {
        calls.push({ path, args });
        return { exitCode: 0, stdout: args.includes("--version") ? "bubblewrap 1.0.0\n" : "", stderr: "" };
      },
      now: () => "2026-07-13T20:00:00.000Z",
    };

    const report = await probeLocalMotionSandboxCapability(services);

    expect(report).toMatchObject({
      schema: "shellx-motion/sandbox-capability@1",
      platform: "linux",
      provider: "linux-bubblewrap",
      status: "available",
      required: false,
      appliedToWorkers: false,
      policy: { network: "denied", filesystem: "read-only-host-probe", process: "new-session" },
      executable: { path: "/usr/bin/bwrap", sha256: "a".repeat(64), versionStatus: "reported", version: "bubblewrap 1.0.0" },
      probe: { kind: "executed", exitCode: 0, outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      createdAt: "2026-07-13T20:00:00.000Z",
    });
    expect(calls[1]).toEqual({
      path: "/usr/bin/bwrap",
      args: [
        "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--unshare-net",
        "--new-session", "--die-with-parent", "--", "/bin/true",
      ],
    });
    expect(createLocalMotionSandboxCapabilityReceipt(report)).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "resources.sandbox.probe",
      status: "passed",
      lane: "resources",
      warnings: [],
      output: report,
    });
  });

  it("receipts a failed installed-provider probe as optional warning evidence", async () => {
    const report = await probeLocalMotionSandboxCapability({
      platform: "linux",
      locateExecutable: async () => ({ path: "/usr/bin/bwrap", sha256: "b".repeat(64) }),
      runExecutable: async (_path, args) => args.includes("--version")
        ? { exitCode: 0, stdout: "bubblewrap 1.0.0", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "namespace unavailable" },
      now: () => "2026-07-13T20:01:00.000Z",
    });

    expect(report).toMatchObject({
      status: "unavailable",
      provider: "linux-bubblewrap",
      reasonCode: "probe_failed",
      executable: { versionStatus: "reported", version: "bubblewrap 1.0.0" },
      probe: { kind: "executed", exitCode: 1, outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(createLocalMotionSandboxCapabilityReceipt(report)).toMatchObject({
      status: "warning",
      warnings: ["Optional linux-bubblewrap sandbox capability is unavailable (probe_failed)."],
    });
  });

  it("proves macOS sandbox-exec without treating its absent version flag as failure", async () => {
    const calls: string[][] = [];
    const report = await probeLocalMotionSandboxCapability({
      platform: "darwin",
      locateExecutable: async () => ({ path: "/usr/bin/sandbox-exec", sha256: "c".repeat(64) }),
      runExecutable: async (_path, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-07-13T20:01:30.000Z",
    });

    expect(calls).toEqual([["-p", "(version 1) (allow default) (deny network*)", "/usr/bin/true"]]);
    expect(report).toMatchObject({
      provider: "macos-sandbox-exec",
      status: "available",
      executable: {
        path: "/usr/bin/sandbox-exec",
        sha256: "c".repeat(64),
        versionStatus: "not-supported",
      },
      probe: { kind: "executed", exitCode: 0 },
    });
    expect(report.executable).not.toHaveProperty("version");
  });

  it("reports absent, unimplemented, and unsupported providers without executing anything", async () => {
    let executions = 0;
    const common = {
      locateExecutable: async () => null,
      runExecutable: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-07-13T20:02:00.000Z",
    } satisfies LocalMotionSandboxProbeServices;

    await expect(probeLocalMotionSandboxCapability({ ...common, platform: "darwin" })).resolves.toMatchObject({
      provider: "macos-sandbox-exec", status: "unavailable", reasonCode: "binary_not_found", probe: { kind: "not-found" },
    });
    await expect(probeLocalMotionSandboxCapability({ ...common, platform: "win32" })).resolves.toMatchObject({
      provider: "windows-appcontainer", status: "unavailable", reasonCode: "provider_not_implemented", probe: { kind: "not-implemented" },
    });
    await expect(probeLocalMotionSandboxCapability({ ...common, platform: "freebsd" })).resolves.toMatchObject({
      provider: "unsupported", status: "unavailable", reasonCode: "unsupported_platform", probe: { kind: "unsupported-platform" },
    });
    expect(executions).toBe(0);
  });
});
