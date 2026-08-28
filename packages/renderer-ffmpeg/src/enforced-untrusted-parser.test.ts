import { chmod, mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { UntrustedMotionExecutionRefusal } from "@shellx-motion/core";
import {
  createEnforcedUntrustedParserProcessFactory,
  isolatedParserCommand,
  prepareEnforcedUntrustedParserLaunch
} from "./enforced-untrusted-parser.js";

const temporaryRoots: string[] = [];
const rendererPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  }));
});

describe("enforced untrusted FFmpeg parser launch planning", () => {
  // The planner and its real proof are Linux/Bubblewrap-only. Windows has neither POSIX ownership
  // and execute bits nor the mount namespace this mock plan is designed to inspect.
  it.skipIf(process.platform === "win32")(
    "pins Node plus the fixed shim and gives an untrusted parser only a private staging root",
    async () => {
    const fixture = await createFixture();
    const plan = await prepareEnforcedUntrustedParserLaunch(fixture.input, availableLinuxBubblewrap());

    expect(plan.executablePath).toBe(await realpath(process.execPath));
    expect(plan.launcherPath).toBe(join(rendererPackageRoot, "bin", "enforced-untrusted-ffmpeg-launcher.mjs"));
    const config = JSON.parse(plan.env.SHELLX_MOTION_ENFORCED_FFMPEG_CONFIG ?? "{}");
    expect(Object.keys(plan.env)).toEqual(["SHELLX_MOTION_ENFORCED_FFMPEG_CONFIG"]);
    expect(config).toMatchObject({
      nodeExecutable: plan.executablePath,
      launcherExecutable: plan.launcherPath,
      packageRoot: fixture.packageRoot,
      inputRoots: [fixture.inputRoot],
      stagingRoot: fixture.stagingRoot,
      ffmpegExecutable: fixture.ffmpeg,
      ffprobeExecutable: fixture.ffprobe
    });
    expect(config.nodeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(config.launcherSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(config).not.toHaveProperty("outputPath");
    expect(config).not.toHaveProperty("outputRoot");
    expect(JSON.stringify(config)).not.toContain(fixture.requestedOutputParent);
    const launcherSource = await readFile(plan.launcherPath, "utf8");
    const parserSource = await readFile(join(rendererPackageRoot, "src", "enforced-untrusted-parser.ts"), "utf8");
    const launcherFacts = await stat(plan.launcherPath);
    expect(launcherSource).toMatch(/^#!\/usr\/bin\/env node\n/);
    expect(launcherSource).toContain('"--unshare-all"');
    expect(launcherSource).toContain('"--tmpfs", "/"');
    expect(launcherSource).toContain('"--tmpfs", "/tmp"');
    expect(launcherSource).toContain('args.push("--bind", stagingRoot, stagingRoot)');
    expect(launcherSource.match(/args\.push\("--bind",/g)).toHaveLength(1);
    expect(launcherSource).toContain("delete process.env[CONFIG_ENV]");
    expect(launcherSource).toContain('regularFile(process.execPath, "Node executable")');
    expect(launcherSource).toContain("config.nodeExecutable");
    expect(launcherSource).toContain("config.nodeSha256");
    expect(launcherSource).toContain("const MAX_PARSER_ARGV = 1_025;");
    expect(launcherSource).toContain("const MAX_PARSER_ARGV_BYTES = 65_536;");
    expect(launcherSource).toContain('"--clearenv"');
    expect(launcherSource).not.toContain('"--share-net"');
    expect(launcherSource).toContain('"--setenv", "HOME", "/tmp"');
    expect(launcherSource).not.toContain("process.env.HOME");
    expect(launcherSource).toContain("shell: false");
    expect(launcherSource).not.toContain("eval(");
    expect(launcherSource).not.toContain("finalOutput");
    expect(launcherSource).not.toContain("requestedOutputParent");
    const rootsMatch = /const RUNTIME_ROOTS = (\[[^\n]+\]);/.exec(launcherSource);
    expect(rootsMatch?.[1]).toBeDefined();
    expect(JSON.parse(rootsMatch?.[1] ?? "[]")).toEqual(["/lib", "/lib64", "/usr/lib", "/usr/lib64", "/etc/alternatives"]);
    const plannerRootsMatch = /const READ_ONLY_RUNTIME_ROOTS = (\[[^\n]+\]) as const;/.exec(parserSource);
    expect(plannerRootsMatch?.[1]).toBeDefined();
    expect(JSON.parse(plannerRootsMatch?.[1] ?? "[]")).toEqual(["/lib", "/lib64", "/usr/lib", "/usr/lib64", "/etc/alternatives"]);
    expect(launcherSource).toContain('"/etc/alternatives"');
    expect(launcherSource).not.toContain('"/etc"');
    expect(launcherSource).not.toContain('"/opt"');
    expect(launcherSource).not.toContain('"/sbin"');
    expect(launcherSource.indexOf('args.push("--tmpfs", "/tmp")')).toBeLessThan(
      launcherSource.indexOf("for (const root of [...toolRoots, packageRoot, ...inputRoots])")
    );
    expect(launcherFacts.mode & 0o111).not.toBe(0);

    await expect(isolatedParserCommand(plan, {
      executable: fixture.ffprobe,
      args: ["-v", "error", join(fixture.stagingRoot, "candidate.mp4")],
      shell: false
    })).resolves.toEqual({
      executable: plan.executablePath,
      args: [plan.launcherPath, fixture.ffprobe, "-v", "error", join(fixture.stagingRoot, "candidate.mp4")],
      env: plan.env
    });
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects active content, symlinked roots, overlap, and unpinned parser executables before launch",
    async () => {
    const fixture = await createFixture();
    await expect(prepareEnforcedUntrustedParserLaunch({
      ...fixture.input,
      motion: { layers: [{ id: "script", type: "web" }] } as any
    }, availableLinuxBubblewrap())).rejects.toMatchObject({
      name: UntrustedMotionExecutionRefusal.name,
      code: "active_content_refused"
    });

    const link = join(fixture.root, "linked-input");
    await symlink(fixture.inputRoot, link);
    await expect(prepareEnforcedUntrustedParserLaunch({
      ...fixture.input,
      inputRoots: [link]
    }, availableLinuxBubblewrap())).rejects.toMatchObject({ code: "sandbox_unavailable" });

    await expect(prepareEnforcedUntrustedParserLaunch({
      ...fixture.input,
      stagingRoot: fixture.inputRoot
    }, availableLinuxBubblewrap())).rejects.toMatchObject({ code: "sandbox_unavailable" });

    const plan = await prepareEnforcedUntrustedParserLaunch(fixture.input, availableLinuxBubblewrap());
    await expect(isolatedParserCommand(plan, {
      executable: fixture.untrustedTool,
      args: ["-version"],
      shell: false
    })).rejects.toMatchObject({ code: "sandbox_unavailable" });
    }
  );

  it.skipIf(process.platform === "win32")(
    "accepts the exact parser argv bounds and refuses overflow before launch",
    async () => {
    const fixture = await createFixture();
    const plan = await prepareEnforcedUntrustedParserLaunch(fixture.input, availableLinuxBubblewrap());
    const maxCount = await isolatedParserCommand(plan, {
      executable: fixture.ffmpeg,
      args: Array.from({ length: 1_024 }, () => "-x"),
      shell: false
    });
    expect(maxCount.args.slice(1)).toHaveLength(1_025);
    await expect(isolatedParserCommand(plan, {
      executable: fixture.ffmpeg,
      args: Array.from({ length: 1_025 }, () => "-x"),
      shell: false
    })).rejects.toMatchObject({ code: "sandbox_unavailable" });

    const exactByteArgument = "x".repeat(65_536 - Buffer.byteLength(`${fixture.ffmpeg}\0`, "utf8"));
    await expect(isolatedParserCommand(plan, {
      executable: fixture.ffmpeg,
      args: [exactByteArgument],
      shell: false
    })).resolves.toMatchObject({ args: [plan.launcherPath, fixture.ffmpeg, exactByteArgument] });
    await expect(isolatedParserCommand(plan, {
      executable: fixture.ffmpeg,
      args: [`${exactByteArgument}x`],
      shell: false
    })).rejects.toMatchObject({ code: "sandbox_unavailable" });
    }
  );

  it.skipIf(process.platform === "win32")(
    "binds the factory to one already-admitted job signal and never gives agent surfaces a switch",
    async () => {
    const fixture = await createFixture();
    const admission = new AbortController();
    const factory = await createEnforcedUntrustedParserProcessFactory({
      motion: fixture.input.motion,
      packageRoot: fixture.packageRoot,
      inputRoots: [fixture.inputRoot],
      ffmpegExecutable: fixture.ffmpeg,
      ffprobeExecutable: fixture.ffprobe,
      job: { scratchRoot: fixture.stagingRoot, signal: admission.signal }
    }, availableLinuxBubblewrap());
    await expect(factory({
      command: { executable: fixture.ffmpeg, args: ["-version"], shell: false },
      signal: new AbortController().signal,
      watchProcess: () => undefined,
      reportProcessContainment: () => undefined
    })).rejects.toMatchObject({ code: "sandbox_unavailable" });

    const publicIndex = await readFile(join(rendererPackageRoot, "src", "index.ts"), "utf8");
    const cli = await readFile(join(rendererPackageRoot, "..", "cli", "src", "main.ts"), "utf8");
    const debug = await readFile(join(rendererPackageRoot, "..", "debug-api", "src", "index.ts"), "utf8");
    expect(publicIndex).not.toContain("createEnforcedUntrustedParserProcessFactory");
    expect(cli).not.toContain("enforced-untrusted-ffmpeg-launcher");
    expect(debug).not.toContain("enforced-untrusted-ffmpeg-launcher");
    }
  );

  it("ships the fixed shim through the renderer package manifest", async () => {
    const manifest = JSON.parse(await readFile(join(rendererPackageRoot, "package.json"), "utf8"));
    expect(manifest.files).toContain("bin/enforced-untrusted-ffmpeg-launcher.mjs");
    const launcher = await stat(join(rendererPackageRoot, "bin", "enforced-untrusted-ffmpeg-launcher.mjs"));
    expect(launcher.isFile()).toBe(true);
    if (process.platform !== "win32") expect(launcher.mode & 0o111).not.toBe(0);
  });

  it("classifies the opt-in host proof as non-shipping test support", async () => {
    // The shared build/pack predicate is JavaScript-only; this test intentionally executes it
    // rather than duplicating its convention in TypeScript.
    // @ts-expect-error The repository-owned .mjs helper has no package-local declaration file.
    const sourceModules = await import("../../../scripts/source-modules.mjs");
    expect(sourceModules.isNonShippingSource("src/test-support/enforced-untrusted-parser.real-proof.ts")).toBe(true);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "shellx-motion-untrusted-parser-"));
  temporaryRoots.push(root);
  const packageRoot = join(root, "package");
  const inputRoot = join(root, "input");
  const stagingRoot = join(root, "staging");
  const toolsRoot = join(root, "tools");
  const requestedOutputParent = join(root, "requested-output-parent");
  await Promise.all([
    mkdir(packageRoot),
    mkdir(inputRoot),
    mkdir(stagingRoot, { mode: 0o700 }),
    mkdir(toolsRoot),
    mkdir(requestedOutputParent)
  ]);
  const ffmpeg = join(toolsRoot, "ffmpeg");
  const ffprobe = join(toolsRoot, "ffprobe");
  const untrustedTool = join(toolsRoot, "foreign-parser");
  await Promise.all([ffmpeg, ffprobe, untrustedTool].map(async (path) => {
    await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(path, 0o755);
  }));
  return {
    root,
    packageRoot,
    inputRoot,
    stagingRoot,
    requestedOutputParent,
    ffmpeg,
    ffprobe,
    untrustedTool,
    input: {
      motion: { layers: [{ id: "title", type: "text" }] } as any,
      packageRoot,
      inputRoots: [inputRoot],
      stagingRoot,
      ffmpegExecutable: ffmpeg,
      ffprobeExecutable: ffprobe
    }
  };
}

function availableLinuxBubblewrap() {
  return {
    probe: async () => ({
      schema: "shellx-motion/sandbox-capability@1" as const,
      platform: "linux" as const,
      provider: "linux-bubblewrap" as const,
      status: "available" as const,
      required: false,
      appliedToWorkers: false,
      policy: { network: "denied" as const, filesystem: "read-only-host-probe" as const, process: "new-session" as const },
      executable: { path: "/usr/bin/bwrap", sha256: "a".repeat(64), versionStatus: "reported" as const },
      probe: { kind: "executed" as const, exitCode: 0, outputSha256: "b".repeat(64) },
      createdAt: "2026-08-09T10:00:00.000Z"
    } as const)
  };
}
