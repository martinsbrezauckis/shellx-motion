/**
 * Opt-in current-Linux-host proof for the internal enforced-untrusted browser path.
 *
 * This suite is deliberately outside normal Vitest/build/pack discovery. It needs explicit
 * operator opt-in because it launches real Bubblewrap and Chromium. It proves one data-only
 * package through Motion's fixed default Playwright path and observes that Chromium's mount
 * namespace has the planned shape. It does not claim seccomp, a compromised-host boundary,
 * public-route adoption, Chromium-internal sandbox coverage, generic codec isolation, or any
 * Windows/macOS/cross-host result.
 */
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, readFile, readlink, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENFORCED_UNTRUSTED_BROWSER_EXECUTION,
  createMotionBrowserRenderSession,
} from "../index.js";
import { loadMotionPackage } from "@shellx-motion/core";

const describeRealProof = process.env.SHELLX_MOTION_RUN_UNTRUSTED_BROWSER_PROOF === "1" ? describe : describe.skip;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const lowerThirdFixture = join(repoRoot, "fixtures", "packages", "lower-third");
const PSEUDO_FILESYSTEMS = new Set([
  "tmpfs", "proc", "sysfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "mqueue", "securityfs", "tracefs", "debugfs"
]);

interface ProcessFacts {
  pid: number;
  parentPid: number;
}

interface MountInfo {
  root: string;
  mountPoint: string;
  options: string[];
  filesystem: string;
  source: string;
}

interface SandboxedChromiumObservation {
  pid: number;
  executable: string;
  profilePath: string;
  mountNamespace: string;
  mounts: MountInfo[];
}

describeRealProof("opt-in Linux Bubblewrap Chromium proof", () => {
  it("renders one data-only frame through the fixed launcher and observes its mount namespace", async () => {
    if (process.platform !== "linux") {
      throw new Error("Untrusted browser proof refused: it requires an actual Linux host.");
    }

    const root = await mkdtemp(join(tmpdir(), "shellx-motion-untrusted-browser-proof-"));
    const packageRoot = join(root, "package");
    const frameRoot = join(root, "frames");
    const framePath = join(frameRoot, "enforced.png");
    const siblingRoot = join(root, "sibling");
    const sentinel = join(siblingRoot, "must-not-be-mounted");
    let session: Awaited<ReturnType<typeof createMotionBrowserRenderSession>> | undefined;
    try {
      await Promise.all([mkdir(packageRoot), mkdir(frameRoot), mkdir(siblingRoot)]);
      await Promise.all([
        copyFile(join(lowerThirdFixture, "manifest.json"), join(packageRoot, "manifest.json")),
        copyFile(join(lowerThirdFixture, "motion.json"), join(packageRoot, "motion.json")),
        writeFile(sentinel, "host sibling sentinel; this path must not be mounted in Chromium\n", "utf8")
      ]);

      const pkg = await loadMotionPackage(packageRoot);
      expect(pkg.manifest.assets).toEqual([]);
      expect(pkg.motion.assets).toEqual([]);
      expect(pkg.motion.assets.filter(isFontAsset)).toEqual([]);
      expect(pkg.motion.layers.every((layer) => !["web", "html", "canvas"].includes(layer.type))).toBe(true);
      expect(await realpath(pkg.root)).toBe(await realpath(packageRoot));
      expect((await lstat(sentinel)).isFile()).toBe(true);
      const sentinelSha256 = sha256(await readFile(sentinel));
      const siblingEntriesBeforeLaunch = await readdir(siblingRoot);

      const hostMountNamespace = await readlink("/proc/self/ns/mnt");
      const descendantsBeforeLaunch = await descendantPids(process.pid);

      // No launchBrowser seam is supplied. `untrustedExecution` is renderer-host-only and makes
      // the renderer call Chromium's default Playwright launcher with the fixed launcher shim.
      session = await createMotionBrowserRenderSession(pkg, {
        untrustedExecution: ENFORCED_UNTRUSTED_BROWSER_EXECUTION,
      });
      expect(session.metrics.browserLaunches).toBe(1);

      const packageCanonical = await realpath(packageRoot);
      const siblingCanonical = await realpath(siblingRoot);
      const observation = await awaitSandboxedChromium({
        rootPid: process.pid,
        descendantsBeforeLaunch,
        hostMountNamespace,
        packageRoot: packageCanonical,
        siblingRoot: siblingCanonical,
      });
      expect(observation.mountNamespace).not.toBe(hostMountNamespace);
      expect(observation.executable).not.toBe(await realpath(process.execPath));
      assertPlannedMountShape(observation, packageCanonical, siblingCanonical);

      const result = await session.renderFrame({
        atMs: 0,
        outDir: frameRoot,
        outputPath: framePath,
      });
      expect(result.ok).toBe(true);
      expect(result.output.path).toBe(framePath);
      expect(result.output.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.output.width).toBe(pkg.motion.width);
      expect(result.output.height).toBe(pkg.motion.height);
      expect(result.output.browser.name).toBe("chromium");
      const frameBytes = await readFile(framePath);
      const frameSha256 = sha256(frameBytes);
      expect((await stat(framePath)).size).toBeGreaterThan(0);
      expect(frameBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(frameSha256).toBe(result.output.sha256);
      // Screenshot bytes arrive over Playwright's host-side pipe and are written by the renderer
      // host. This host-side artifact is evidence of a real rendered frame, not a browser RW mount.
      expect(result.receipt.output).toMatchObject({ path: framePath, sha256: frameSha256 });
      expect(result.output.resources?.sandbox).toMatchObject({
        schema: "shellx-motion/runtime-sandbox@1",
        provider: "linux-bubblewrap",
        status: "enforced",
        scope: "browser-process",
        launcher: { path: expect.stringMatching(/^\//), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        interpreter: { path: expect.stringMatching(/^\//), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        executable: { path: expect.stringMatching(/^\//), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        policy: {
          network: "denied",
          packageFilesystem: "read-only",
          writableFilesystem: "isolated-tmpfs-root-and-browser-profile",
          process: "new-pid-namespace",
          capabilities: "dropped",
          seccomp: "not-configured",
        }
      });
      expect(result.receipt.output).toMatchObject({
        resources: { sandbox: result.output.resources?.sandbox }
      });
      await session.close();
      session = undefined;
      expect(sha256(await readFile(sentinel))).toBe(sentinelSha256);
      expect(await readdir(siblingRoot)).toEqual(siblingEntriesBeforeLaunch);
    } finally {
      await session?.close();
      await rm(root, { recursive: true, force: true });
      if (existsSync(root)) throw new Error("Untrusted browser proof cleanup failed: owned temporary root remains.");
    }
  }, 90_000);
});

async function awaitSandboxedChromium(input: {
  rootPid: number;
  descendantsBeforeLaunch: ReadonlySet<number>;
  hostMountNamespace: string;
  packageRoot: string;
  siblingRoot: string;
}): Promise<SandboxedChromiumObservation> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const descendants = await descendantPids(input.rootPid);
    for (const pid of descendants) {
      if (input.descendantsBeforeLaunch.has(pid)) continue;
      const observation = await inspectSandboxedChromium(pid);
      if (!observation || observation.mountNamespace === input.hostMountNamespace) continue;
      if (!hasMount(observation.mounts, input.packageRoot, "ro")) continue;
      if (mentionsPath(observation.mounts, input.siblingRoot)) continue;
      return observation;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Untrusted browser proof refused: no live Chromium descendant with observable Bubblewrap mount evidence was found.");
}

async function inspectSandboxedChromium(pid: number): Promise<SandboxedChromiumObservation | undefined> {
  try {
    const [executable, mountNamespace, commandLine, mountInfo] = await Promise.all([
      realpath(`/proc/${pid}/exe`),
      readlink(`/proc/${pid}/ns/mnt`),
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readFile(`/proc/${pid}/mountinfo`, "utf8"),
    ]);
    const profileArg = commandLine.split("\0").find((argument) => argument.startsWith("--user-data-dir="));
    if (!profileArg) return undefined;
    const profilePath = await realpath(profileArg.slice("--user-data-dir=".length));
    return { pid, executable, profilePath, mountNamespace, mounts: parseMountInfo(mountInfo) };
  } catch {
    // Browser helpers and short-lived descendants race naturally. Only a resolved live process can
    // establish this host proof; continue bounded polling rather than turning a race into a pass.
    return undefined;
  }
}

function assertPlannedMountShape(
  observation: SandboxedChromiumObservation,
  packageRoot: string,
  siblingRoot: string,
): void {
  expect(hasMount(observation.mounts, "/", undefined, "tmpfs")).toBe(true);
  expect(hasMount(observation.mounts, "/tmp", undefined, "tmpfs")).toBe(true);
  expect(hasMount(observation.mounts, packageRoot, "ro")).toBe(true);
  expect(mentionsPath(observation.mounts, siblingRoot)).toBe(false);

  const profileMount = observation.mounts.filter((mount) => mount.mountPoint === observation.profilePath);
  expect(profileMount).toHaveLength(1);
  const [profile] = profileMount;
  if (!profile) throw new Error("Untrusted browser proof refused: Playwright profile mount was not observable.");
  expect(profile.options).toContain("rw");
  expect(PSEUDO_FILESYSTEMS.has(profile.filesystem)).toBe(false);

  // This intentionally does not claim that a namespace has no writable mounts. It distinguishes
  // the one expected host-backed Playwright profile bind from namespace-local tmpfs/proc/dev mounts.
  const hostBackedWritableMounts = observation.mounts.filter((mount) => (
    mount.options.includes("rw") && !PSEUDO_FILESYSTEMS.has(mount.filesystem)
  ));
  expect(hostBackedWritableMounts).toEqual([profile]);
}

function hasMount(mounts: readonly MountInfo[], mountPoint: string, access?: "ro" | "rw", filesystem?: string): boolean {
  return mounts.some((mount) => (
    mount.mountPoint === mountPoint
    && (access === undefined || mount.options.includes(access))
    && (filesystem === undefined || mount.filesystem === filesystem)
  ));
}

function mentionsPath(mounts: readonly MountInfo[], path: string): boolean {
  return mounts.some((mount) => [mount.root, mount.mountPoint, mount.source].some((value) => value === path || value.startsWith(`${path}/`)));
}

function parseMountInfo(source: string): MountInfo[] {
  return source.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf(" - ");
    if (separator < 0) throw new Error("Untrusted browser proof refused: Linux mountinfo entry is malformed.");
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 2) throw new Error("Untrusted browser proof refused: Linux mountinfo entry is incomplete.");
    return {
      root: decodeMountInfoPath(left[3]),
      mountPoint: decodeMountInfoPath(left[4]),
      options: left[5].split(","),
      filesystem: right[0],
      source: decodeMountInfoPath(right[1]),
    };
  });
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isFontAsset(asset: unknown): asset is { type: "font" } {
  return typeof asset === "object" && asset !== null && (asset as { type?: unknown }).type === "font";
}

async function descendantPids(rootPid: number): Promise<Set<number>> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const facts = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry) => processFacts(Number(entry.name))));
  const byParent = new Map<number, number[]>();
  for (const fact of facts) {
    if (!fact) continue;
    const children = byParent.get(fact.parentPid) ?? [];
    children.push(fact.pid);
    byParent.set(fact.parentPid, children);
  }
  const descendants = new Set<number>();
  const pending = [...(byParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || descendants.has(pid)) continue;
    descendants.add(pid);
    pending.push(...(byParent.get(pid) ?? []));
  }
  return descendants;
}

async function processFacts(pid: number): Promise<ProcessFacts | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    const fields = close >= 0 ? value.slice(close + 2).trim().split(/\s+/) : [];
    const parentPid = Number(fields[1]);
    return Number.isInteger(parentPid) && parentPid > 0 ? { pid, parentPid } : undefined;
  } catch {
    return undefined;
  }
}
