/**
 * Opt-in Linux host proof for the internal untrusted-parser staging factory.
 *
 * This is deliberately skipped unless an operator explicitly sets
 * SHELLX_MOTION_RUN_UNTRUSTED_PARSER_PROOF=1. It starts real Bubblewrap, FFmpeg, and FFprobe;
 * it is not part of the normal renderer test suite and proves neither public-route adoption nor
 * Windows/macOS support. A capability or mount failure is an honest failed proof, never a pass.
 */
import { constants, existsSync } from "node:fs";
import { access, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { probeLocalMotionSandboxCapability, type MotionDocument } from "@shellx-motion/core";
import {
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
  type FfmpegCommand
} from "../index.js";
import {
  createEnforcedUntrustedParserProcessFactory,
  isolatedParserCommand,
  prepareEnforcedUntrustedParserLaunch
} from "../enforced-untrusted-parser.js";

const describeRealProof = process.env.SHELLX_MOTION_RUN_UNTRUSTED_PARSER_PROOF === "1" ? describe : describe.skip;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const packageRoot = join(repoRoot, "fixtures", "packages", "lower-third");

describeRealProof("opt-in Linux Bubblewrap FFmpeg/FFprobe parser proof", () => {
  it("stages a bounded PPM, probes it, and rejects a sibling requested-output sentinel", async () => {
    if (process.platform !== "linux") {
      throw new Error("Untrusted parser proof refused: it requires an actual Linux host.");
    }

    const root = await mkdtemp(join(tmpdir(), "shellx-motion-untrusted-parser-proof-"));
    const inputRoot = join(root, "input");
    const stagingRoot = join(root, "staging");
    const requestedOutputParent = join(root, "requested-output-parent");
    const sentinel = join(requestedOutputParent, "must-not-read.ppm");
    try {
      await Promise.all([mkdir(inputRoot), mkdir(stagingRoot), mkdir(requestedOutputParent)]);
      await writeFile(join(inputRoot, "pixel.ppm"), "P3\n1 1\n255\n255 0 0\n", "ascii");
      const motion = JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8")) as Pick<MotionDocument, "layers">;
      expect(motion.layers.every((layer) => !["web", "html", "canvas"].includes(layer.type))).toBe(true);

      // Probe once, then reuse that exact capability report for planning and factory construction.
      // A missing/non-Linux provider causes the opt-in proof to refuse; it is not converted to a pass.
      const capability = await probeLocalMotionSandboxCapability();
      const services = { probe: async () => capability };
      const ffmpegExecutable = await resolveProofTool(resolveFfmpegExecutable(), "FFmpeg");
      const ffprobeExecutable = await resolveProofTool(resolveFfprobeExecutable(), "FFprobe");
      const common = {
        motion,
        packageRoot,
        inputRoots: [inputRoot],
        ffmpegExecutable,
        ffprobeExecutable
      };
      const plan = await prepareEnforcedUntrustedParserLaunch({ ...common, stagingRoot }, services);
      const config = JSON.parse(plan.env.SHELLX_MOTION_ENFORCED_FFMPEG_CONFIG ?? "{}");
      const hostHome = homedir();
      expect(Object.keys(plan.env)).toEqual(["SHELLX_MOTION_ENFORCED_FFMPEG_CONFIG"]);
      expect(plan.executablePath).toBe(await realpath(process.execPath));
      expect(config).toMatchObject({ nodeExecutable: plan.executablePath, launcherExecutable: plan.launcherPath, packageRoot, inputRoots: [inputRoot], stagingRoot });
      expect(config.nodeSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(config.launcherSha256).toMatch(/^[a-f0-9]{64}$/);
      expect([config.packageRoot, ...config.inputRoots, config.stagingRoot]).not.toContain(hostHome);
      expect(JSON.stringify(config)).not.toContain(requestedOutputParent);
      const launcherSource = await readFile(plan.launcherPath, "utf8");
      const plannedFfprobe = await isolatedParserCommand(plan, {
        executable: ffprobeExecutable,
        args: ["-version"],
        shell: false
      });
      expect(plannedFfprobe.executable).toBe(plan.executablePath);
      expect(plannedFfprobe.args.slice(0, 2)).toEqual([plan.launcherPath, config.ffprobeExecutable]);
      expect(launcherSource).toContain('"--unshare-all"');
      expect(launcherSource).not.toContain('"--share-net"');
      expect(launcherSource).toContain('regularFile(process.execPath, "Node executable")');
      expect(launcherSource).not.toContain("process.env.HOME");
      expect(launcherSource).toContain('"/etc/alternatives"');
      expect(launcherSource).not.toContain('"/etc"');
      expect(launcherSource).not.toContain('"/opt"');
      expect(launcherSource).not.toContain('"/sbin"');
      expect(launcherSource.indexOf('args.push("--tmpfs", "/tmp")')).toBeLessThan(
        launcherSource.indexOf("for (const root of [...toolRoots, packageRoot, ...inputRoots])")
      );

      const controller = new AbortController();
      const factory = await createEnforcedUntrustedParserProcessFactory({
        ...common,
        job: { scratchRoot: stagingRoot, signal: controller.signal }
      }, services);
      const containment: unknown[] = [];
      const watchedPids: number[] = [];
      const run = async (command: FfmpegCommand) => {
        const process = await factory({
          command,
          signal: controller.signal,
          watchProcess: (pid) => watchedPids.push(pid),
          reportProcessContainment: (evidence) => containment.push(evidence)
        });
        return await process.end();
      };

      const stagedPng = join(stagingRoot, "pixel.png");
      const encoded = await run({
        executable: ffmpegExecutable,
        args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", join(inputRoot, "pixel.ppm"), "-frames:v", "1", stagedPng],
        shell: false
      });
      expect(encoded.exitCode, encoded.stderr).toBe(0);

      const probed = await run({
        executable: ffprobeExecutable,
        args: ["-v", "error", "-print_format", "json", "-show_streams", stagedPng],
        shell: false
      });
      expect(probed.exitCode, probed.stderr).toBe(0);
      expect(JSON.parse(probed.stdout)).toMatchObject({ streams: [expect.objectContaining({ codec_name: "png" })] });
      // A byte-identical valid PNG in the sibling requested-output root would also probe
      // successfully if that root leaked into the child. Its bytes are never logged or evidenced.
      const sentinelBytes = await readFile(stagedPng);
      const sentinelSha256 = createHash("sha256").update(sentinelBytes).digest("hex");
      await writeFile(sentinel, sentinelBytes);
      const outsideRead = await run({
        executable: ffprobeExecutable,
        args: ["-v", "error", "-print_format", "json", "-show_streams", sentinel],
        shell: false
      });
      expect(outsideRead.exitCode).not.toBe(0);
      expect(JSON.parse(outsideRead.stdout)).not.toHaveProperty("streams");
      const stagedCanonical = await realpath(stagedPng);
      expect(relative(stagingRoot, stagedCanonical).startsWith("..")).toBe(false);
      expect(existsSync(stagedPng)).toBe(true);
      expect(createHash("sha256").update(await readFile(sentinel)).digest("hex")).toBe(sentinelSha256);
      expect(await readdir(requestedOutputParent)).toEqual(["must-not-read.ppm"]);
      expect(watchedPids).toHaveLength(3);
      expect(containment).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (existsSync(root)) throw new Error("Untrusted parser proof cleanup failed: owned temporary root remains.");
    }
  }, 45_000);
});

/**
 * The production parser contract deliberately accepts only canonical absolute tool paths. This
 * opt-in host proof normalizes the ordinary PATH-token discovery result without invoking a shell,
 * then supplies the canonical executable to that contract. It neither changes production lookup
 * nor allows a relative PATH entry or a non-file/non-executable target.
 */
async function resolveProofTool(configured: string, label: string): Promise<string> {
  if (configured.includes("\0")) throw new Error(`Untrusted parser proof refused: ${label} executable contains NUL.`);
  const candidates = isAbsolute(configured)
    ? [configured]
    : basename(configured) === configured
      ? (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map((directory) => join(directory, configured))
      : [];
  for (const candidate of candidates) {
    let canonical: string;
    try { canonical = await realpath(candidate); } catch { continue; }
    let facts;
    try {
      facts = await lstat(canonical);
      await access(canonical, constants.X_OK);
    } catch {
      continue;
    }
    if (facts.isFile() && !facts.isSymbolicLink()) return canonical;
  }
  throw new Error(`Untrusted parser proof refused: no canonical executable ${label} was found in absolute PATH entries.`);
}
