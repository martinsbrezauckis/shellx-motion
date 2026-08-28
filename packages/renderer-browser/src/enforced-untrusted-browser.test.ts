import { chmod, mkdtemp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error This shared JavaScript source-classifier intentionally has no declaration file.
import { isNonShippingSource } from "../../../scripts/source-modules.mjs";
import { loadMotionPackage, UntrustedMotionExecutionRefusal } from "@shellx-motion/core";
import {
  assertEnforcedUntrustedBrowserDefaultLaunch,
  prepareEnforcedUntrustedBrowserLaunch,
  promoteEnforcedUntrustedBrowserLaunchEvidence,
} from "./enforced-untrusted-browser";
import {
  createMotionBrowserRenderSession,
  ENFORCED_UNTRUSTED_BROWSER_EXECUTION,
  type BrowserRenderSessionOptions
} from "./index";

const temporaryRoots: string[] = [];
const rendererPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  }));
});

describe("enforced untrusted browser launch planning", () => {
  it("publishes the host-only renderer option and its exact policy token", () => {
    const trustedHostConfiguration: BrowserRenderSessionOptions = {
      untrustedExecution: ENFORCED_UNTRUSTED_BROWSER_EXECUTION,
    };
    expect(trustedHostConfiguration.untrustedExecution).toBe("enforced");
  });

  it.skipIf(process.platform === "win32")(
    "uses a fixed launcher and two-key pinned environment for data-only packages",
    async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "shellx-motion-untrusted-browser-"));
    temporaryRoots.push(root);
    const packageRoot = join(root, "package");
    const browser = join(root, "chromium");
    await mkdir(packageRoot);
    await writeFile(browser, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(browser, 0o755);

    const plan = await prepareEnforcedUntrustedBrowserLaunch({
      motion: { layers: [{ id: "title", type: "text" }] } as any,
      packageRoot,
      browserExecutable: browser,
      chromiumArgs: ["--disable-gpu"],
      networkAccessRequested: false,
    }, {
      probe: async () => ({
        schema: "shellx-motion/sandbox-capability@1",
        platform: "linux",
        provider: "linux-bubblewrap",
        status: "available",
        required: false,
        appliedToWorkers: false,
        policy: { network: "denied", filesystem: "read-only-host-probe", process: "new-session" },
        executable: { path: "/usr/bin/bwrap", sha256: "a".repeat(64), versionStatus: "reported" },
        probe: { kind: "executed", exitCode: 0, outputSha256: "b".repeat(64) },
        createdAt: "2026-08-08T20:00:00.000Z",
      }),
    });

    const launcherPath = join(rendererPackageRoot, "bin", "enforced-untrusted-browser-launcher.mjs");
    const interpreterPath = await realpath(process.execPath);
    expect(plan.executablePath).toBe(launcherPath);
    expect(plan.args).toEqual(["--disable-gpu"]);
    expect(Object.keys(plan.env)).toEqual(["PATH", "SHELLX_MOTION_ENFORCED_BROWSER_CONFIG"]);
    expect(plan.env.PATH).toBe(dirname(interpreterPath));
    expect(plan.env).not.toHaveProperty("NODE_OPTIONS");
    expect(plan.env).not.toHaveProperty("LD_PRELOAD");
    const launcherSource = await readFile(launcherPath, "utf8");
    const launcherFacts = await stat(launcherPath);
    expect(launcherSource).toMatch(/^#!\/usr\/bin\/env node\n/);
    expect(launcherSource).toContain("const browserArgs = process.argv.slice(2)");
    expect(launcherSource).toContain('"--tmpfs", "/"');
    expect(launcherSource).toContain('"--tmpfs", "/tmp"');
    expect(launcherSource).toContain('args.push("--bind", profile, profile)');
    expect(launcherSource.match(/args\.push\("--bind",/g)).toHaveLength(1);
    expect(launcherSource).toContain("delete process.env.SHELLX_MOTION_ENFORCED_BROWSER_CONFIG");
    expect(launcherSource).toContain("const interpreter = regularFile(process.execPath, \"Node interpreter\")");
    expect(launcherSource).toContain('"--clearenv"');
    expect(launcherSource).toContain("shell: false");
    expect(launcherSource).not.toContain("eval(");
    expect(launcherFacts.mode & 0o111).not.toBe(0);
    const config = JSON.parse(plan.env.SHELLX_MOTION_ENFORCED_BROWSER_CONFIG ?? "{}");
    expect(config).toMatchObject({
      launcherExecutable: launcherPath,
      interpreterExecutable: interpreterPath,
      packageRoot,
      browserExecutable: browser,
    });
    expect(config.interpreterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.evidence).toMatchObject({
      provider: "linux-bubblewrap",
      status: "requested",
      launcher: { path: launcherPath, sha256: config.launcherSha256 },
      interpreter: { path: interpreterPath, sha256: config.interpreterSha256 },
      policy: { network: "denied", packageFilesystem: "read-only", writableFilesystem: "isolated-tmpfs-root-and-browser-profile" },
    });
    expect(promoteEnforcedUntrustedBrowserLaunchEvidence(plan.evidence)).toMatchObject({
      provider: "linux-bubblewrap",
      status: "enforced",
      launcher: { path: launcherPath, sha256: config.launcherSha256 },
      interpreter: { path: interpreterPath, sha256: config.interpreterSha256 },
    });
    }
  );

  it("refuses an injected browser launcher before it can forge enforced evidence", () => {
    let refusal: unknown;
    try {
      assertEnforcedUntrustedBrowserDefaultLaunch(async () => undefined);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      name: UntrustedMotionExecutionRefusal.name,
      code: "untrusted_browser_launcher_override_refused",
    });
    expect(() => assertEnforcedUntrustedBrowserDefaultLaunch(undefined)).not.toThrow();
  });

  it("uses the promoted session evidence for both governed and streaming receipts", async () => {
    const [rendererSource, launchSource] = await Promise.all([
      readFile(join(rendererPackageRoot, "src", "index.ts"), "utf8"),
      readFile(join(rendererPackageRoot, "src", "browser-owned-session-launch.ts"), "utf8")
    ]);
    expect(rendererSource).toContain("launchOwnedBrowserSession({");
    expect(launchSource).toContain("assertEnforcedUntrustedBrowserDefaultLaunch(input.launchBrowser)");
    expect(launchSource).toContain("...(input.enforcedUntrustedExecution ? { chromiumSandbox: true } : {})");
    expect(launchSource).toContain("env: untrustedLaunch?.env ?? childEnvironment()");
    expect(launchSource).toContain("? promoteEnforcedUntrustedBrowserLaunchEvidence(untrustedLaunch.evidence)");
    expect(rendererSource).toContain("reportSandbox(sessionSandboxEvidence)");
    expect(rendererSource).toContain("job.reportSandbox?.(sessionSandboxEvidence)");
  });

  it("leaves the normal injected launch option shape unchanged", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    let capturedOptions: Record<string, unknown> | undefined;
    const session = await createMotionBrowserRenderSession(pkg, {
      launchBrowser: async (options) => {
        capturedOptions = { ...options };
        return {
          version: () => "static-test-browser",
          close: async () => undefined,
        } as any;
      }
    });
    try {
      expect(capturedOptions).toMatchObject({ executablePath: expect.any(String), headless: true });
      expect(capturedOptions).not.toHaveProperty("chromiumSandbox");
    } finally {
      await session.close();
    }
  });

  it("ships the executable shim through the renderer package manifest", async () => {
    const manifest = JSON.parse(await readFile(join(rendererPackageRoot, "package.json"), "utf8"));
    expect(manifest.files).toContain("bin/enforced-untrusted-browser-launcher.mjs");
    const launcher = await stat(join(rendererPackageRoot, "bin", "enforced-untrusted-browser-launcher.mjs"));
    expect(launcher.isFile()).toBe(true);
    if (process.platform !== "win32") expect(launcher.mode & 0o111).not.toBe(0);
  });

  it("keeps the real Bubblewrap + Chromium proof opt-in and outside shipping discovery", async () => {
    const proofPath = join(rendererPackageRoot, "src", "test-support", "enforced-untrusted-browser.real-proof.ts");
    const configPath = join(rendererPackageRoot, "vitest.real-proof.config.ts");
    const [proof, config] = await Promise.all([readFile(proofPath, "utf8"), readFile(configPath, "utf8")]);
    expect(proof).toContain('SHELLX_MOTION_RUN_UNTRUSTED_BROWSER_PROOF === "1"');
    expect(proof).toContain("createMotionBrowserRenderSession(pkg, {");
    expect(proof).toContain("untrustedExecution: ENFORCED_UNTRUSTED_BROWSER_EXECUTION");
    expect(proof).not.toContain("launchBrowser:");
    expect(proof).toContain('readFile(`/proc/${pid}/mountinfo`, "utf8")');
    expect(proof).toContain('rm(root, { recursive: true, force: true })');
    expect(config).toContain('include: ["src/test-support/enforced-untrusted-browser.real-proof.ts"]');
    expect(config).toContain("vitest-setup-job-stores.ts");
    expect(isNonShippingSource("packages/renderer-browser/src/test-support/enforced-untrusted-browser.real-proof.ts")).toBe(true);
  });

  it("refuses active content and a Chromium sandbox opt-out before constructing a launcher", async () => {
    const active = prepareEnforcedUntrustedBrowserLaunch({
      motion: { layers: [{ id: "foreign-html", type: "web" }] } as any,
      packageRoot: "/not-used",
      browserExecutable: "/not-used",
      chromiumArgs: [],
      networkAccessRequested: false,
    });
    await expect(active).rejects.toMatchObject({
      name: UntrustedMotionExecutionRefusal.name,
      code: "active_content_refused",
    });

    const noSandbox = prepareEnforcedUntrustedBrowserLaunch({
      motion: { layers: [{ id: "title", type: "text" }] } as any,
      packageRoot: "/not-used",
      browserExecutable: "/not-used",
      chromiumArgs: ["--no-sandbox"],
      networkAccessRequested: false,
    });
    await expect(noSandbox).rejects.toMatchObject({ code: "chromium_sandbox_opt_out_refused" });

    const network = prepareEnforcedUntrustedBrowserLaunch({
      motion: { layers: [{ id: "title", type: "text" }] } as any,
      packageRoot: "/not-used",
      browserExecutable: "/not-used",
      chromiumArgs: [],
      networkAccessRequested: true,
    });
    await expect(network).rejects.toMatchObject({ code: "untrusted_network_configuration_refused" });
  });
});
