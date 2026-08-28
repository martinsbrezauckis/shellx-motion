import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileGpuVideoFrameRequests, type MotionPackage } from "@shellx-motion/core";
import {
  createGovernedFfmpegRunner,
  createGpuPreviewVideoFrameProvider,
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
  type FfmpegCommand,
  type FfmpegProcessResult,
  type GpuPreviewFfmpegRunner
} from "./index";
import { probePreviewSource } from "./gpu-video-preview-provider-primitives";

const roots: string[] = [];
const hostFfmpegAvailable = ["ffmpeg", "ffprobe"].every((tool) => spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0);

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("GPU exact-time FFmpeg preview provider", () => {
  it("ceil-bounds a CFR source whose exact end is fractional in integer microseconds", async () => {
    const snapshot = {
      sourcePath: "/source/clip.mp4", path: "/private/clip.mp4", root: "/private",
      sha256: "a".repeat(64), byteLength: 1, release: async () => undefined
    };
    const facts = await probePreviewSource(snapshot, async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ streams: [{
        codec_type: "video", width: 1, height: 1,
        avg_frame_rate: "24/1", r_frame_rate: "24/1", time_base: "1/24",
        duration_ts: "145", nb_frames: "145", start_pts: "0", start_time: "0.000000"
      }] }),
      stderr: ""
    }), new AbortController().signal);
    expect(facts).toMatchObject({ durationUs: 6_041_667, frameCount: 145n, frameDurationPts: 1n });
  });

  it("snapshots CFR source bytes, uses Core requests, and decodes one exact video-only RGBA frame", async () => {
    const fixture = await createFixture();
    const calls: FfmpegCommand[] = [];
    const provider = createGpuPreviewVideoFrameProvider({
      pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch),
      runner: mockRunner(calls, async (command) => {
        if (command.executable === resolveFfprobeExecutable()) return cfrProbe(2, 2);
        const snapshotPath = command.args[command.args.indexOf("-i") + 1]!;
        const contents = await readFile(snapshotPath, "utf8");
        await writeFile(command.args.at(-1)!, Buffer.from(contents === "before" ? [3, 4, 5, 255] : [9, 9, 9, 255]));
        return ok();
      })
    });
    const probe = await provider.probe(new AbortController().signal);
    await writeFile(fixture.source, "changed-after-snapshot", "utf8");
    const request = requestAt(fixture.pkg, probe.snapshots, 500_000)[0]!;
    const frame = (await provider.framesFor([request], new AbortController().signal)).frames[0]!;

    expect(frame.resource).toMatchObject({
      sourceAtUs: 500_000, sourceAtMs: 500, sourceSnapshotSha256: probe.snapshots.get("clip")?.sourceSnapshotSha256,
      decodedRgbaSha256: frame.resource.sha256, requestFingerprint: request.requestFingerprint
    });
    expect([...frame.upload.rgba]).toEqual([3, 4, 5, 255]);
    expect(frame.upload.sha256).toBe(frame.resource.sourceSnapshotSha256);
    expect(frame.upload.decodedSha256).toBe(frame.resource.decodedRgbaSha256);
    const decode = calls.find((command) => command.executable === resolveFfmpegExecutable() && command.args.includes("-frames:v"))!;
    expect(decode.args).toEqual(expect.arrayContaining([
      "-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0",
      "-ss", "0.5", "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo"
    ]));
    expect(decode.args).not.toContain("0:a:0");
    expect(decode.args).not.toContain("pcm_s16le");
    expect(provider.detailedEvidence.decodedFrames.at(-1)).toMatchObject({ requestedSourceAtUs: 500_000, decodedPts: { value: "500", timeBase: "1/1000" } });
    await provider.close();
    await expect(readdir(fixture.scratch)).resolves.toEqual([]);
  });

  it("refuses VFR/ambiguous cadence before a decoder is started", async () => {
    const fixture = await createFixture(); let decodes = 0;
    const provider = createGpuPreviewVideoFrameProvider({
      pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch),
      runner: mockRunner([], async (command) => {
        if (command.executable === resolveFfprobeExecutable()) return cfrProbe(2, 2, { rFrameRate: "3/1" });
        decodes += 1; return ok();
      })
    });
    await expect(provider.probe(new AbortController().signal)).rejects.toThrow("VFR or ambiguous");
    expect(decodes).toBe(0);
    await expect(readdir(fixture.scratch)).resolves.toEqual([]);
  });

  it("refuses multiple video streams before a decoder is started", async () => {
    const fixture = await createFixture(); let decodes = 0;
    const provider = createGpuPreviewVideoFrameProvider({ pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch), runner: mockRunner([], async (command) => {
      if (command.executable === resolveFfprobeExecutable()) return cfrProbe(2, 2, { extraVideo: true }); decodes += 1; return ok();
    }) });
    await expect(provider.probe(new AbortController().signal)).rejects.toThrow("exactly one non-attached");
    expect(decodes).toBe(0); await expect(readdir(fixture.scratch)).resolves.toEqual([]);
  });

  it("honors Core trim, scalar-rate, and loop requests without reimplementing their mapping", async () => {
    const fixture = await createFixture({ durationMs: 1_500, fps: 2, layer: { trimStartMs: 100, trimDurationMs: 300, loop: true, playbackRate: 1.5 } });
    const provider = createGpuPreviewVideoFrameProvider({ pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch), runner: mockRunner([], decodeOnePixel) });
    const probe = await provider.probe(new AbortController().signal);
    const request = requestAt(fixture.pkg, probe.snapshots, 900_000)[0]!;
    expect(request.sourceAtUs).toBe(250_000); // Core: trim 100ms + ((1000ms * 1.5) mod 300ms)
    const frame = (await provider.framesFor([request], new AbortController().signal)).frames[0]!;
    expect(frame.resource.sourceAtUs).toBe(250_000);
    await provider.close();
  });

  it("evicts completed entries deterministically at the 32-entry LRU cap", async () => {
    const fixture = await createFixture({ fps: 40, durationMs: 1_000 }); let decodeCount = 0;
    const provider = createGpuPreviewVideoFrameProvider({
      pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch),
      runner: mockRunner([], async (command) => {
        if (command.executable === resolveFfprobeExecutable()) return cfrProbe(40, 40);
        decodeCount += 1; await writeFile(command.args.at(-1)!, Buffer.from([decodeCount, 0, 0, 255])); return ok();
      })
    });
    const probe = await provider.probe(new AbortController().signal);
    for (let index = 0; index < 33; index += 1) {
      const request = requestAt(fixture.pkg, probe.snapshots, index * 25_000)[0]!;
      await provider.framesFor([request], new AbortController().signal);
    }
    expect(decodeCount).toBe(33);
    expect(provider.evidence.cache).toMatchObject({ entries: 32, evictions: 1, misses: 33, bytes: 128 });
    expect(provider.detailedEvidence.cache).toMatchObject({ currentEntries: 32, currentBytes: 128, capacityEntries: 32, capacityBytes: 128 * 1024 * 1024 });
    await provider.close();
  });

  it("deduplicates one selected CFR PTS across adjacent source times while one cancelled waiter leaves its sibling intact", async () => {
    const fixture = await createFixture(); let release: (() => Promise<void>) | undefined; let decodes = 0;
    const provider = createGpuPreviewVideoFrameProvider({
      pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch),
      runner: mockRunner([], async (command, signal) => {
        if (command.executable === resolveFfprobeExecutable()) return cfrProbe(2, 2);
        decodes += 1;
        return await new Promise<FfmpegProcessResult>((resolveDecode, rejectDecode) => {
          const abort = () => rejectDecode(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          release = async () => { signal.removeEventListener("abort", abort); await writeFile(command.args.at(-1)!, Buffer.from([1, 2, 3, 255])); resolveDecode(ok()); };
        });
      })
    });
    const probe = await provider.probe(new AbortController().signal), request = requestAt(fixture.pkg, probe.snapshots, 0)[0]!, adjacent = requestAt(fixture.pkg, probe.snapshots, 100_000)[0]!;
    const firstController = new AbortController(), secondController = new AbortController();
    const first = provider.framesFor([request], firstController.signal);
    const second = provider.framesFor([adjacent], secondController.signal);
    await eventually(() => expect(decodes).toBe(1));
    firstController.abort(new Error("first waiter left"));
    await expect(first).rejects.toThrow("first waiter left");
    await release?.();
    await expect(second).resolves.toMatchObject({ atUs: 100_000, frames: [{ resource: { sourceAtUs: 100_000 }, selection: { decodedPts: "0" } }] });
    expect(provider.evidence.cache).toMatchObject({ entries: 1, misses: 1 });
    expect(provider.detailedEvidence.cache.deduplicated).toBe(1);
    await provider.close();
  });

  it("aborts the decoder only when its final waiter leaves and never caches cancellation or failure", async () => {
    const fixture = await createFixture(); let decoderAborts = 0; let decoderStarted = false;
    const provider = createGpuPreviewVideoFrameProvider({
      pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch),
      runner: mockRunner([], async (command, signal) => {
        if (command.executable === resolveFfprobeExecutable()) return cfrProbe(2, 2);
        decoderStarted = true;
        return await new Promise<FfmpegProcessResult>((_resolve, rejectDecode) => signal.addEventListener("abort", () => { decoderAborts += 1; rejectDecode(signal.reason); }, { once: true }));
      })
    });
    const probe = await provider.probe(new AbortController().signal), request = requestAt(fixture.pkg, probe.snapshots, 0)[0]!;
    const one = new AbortController(), two = new AbortController();
    const pendingOne = provider.framesFor([request], one.signal), pendingTwo = provider.framesFor([request], two.signal);
    await eventually(() => expect(decoderStarted).toBe(true));
    one.abort(new Error("one")); two.abort(new Error("two"));
    await expect(pendingOne).rejects.toThrow("one"); await expect(pendingTwo).rejects.toThrow("two");
    await eventually(() => expect(decoderAborts).toBe(1));
    expect(provider.evidence.cache.entries).toBe(0);
    await provider.close();

    const failed = createGpuPreviewVideoFrameProvider({ pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch), runner: mockRunner([], async (command) => command.executable === resolveFfprobeExecutable() ? cfrProbe(2, 2) : { exitCode: 1, stdout: "", stderr: "refused" }) });
    const failedProbe = await failed.probe(new AbortController().signal), failedRequest = requestAt(fixture.pkg, failedProbe.snapshots, 0)[0]!;
    await expect(failed.framesFor([failedRequest], new AbortController().signal)).rejects.toThrow("decoder refused");
    expect(failed.evidence.cache.entries).toBe(0);
    await failed.close();
  });

  it("owns one hard-linked source snapshot and cleans snapshots acquired before a later probe refusal", async () => {
    const fixture = await createFixture({ secondAsset: true });
    const provider = createGpuPreviewVideoFrameProvider({ pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch), runner: mockRunner([], decodeOnePixel) });
    await provider.probe(new AbortController().signal);
    const child = (await readdir(fixture.scratch))[0]!;
    expect(await readdir(join(fixture.scratch, child))).toHaveLength(1);
    await expect(provider.close()).resolves.toMatchObject({ closed: true, releasedSources: 2, privateScratchReleased: true });
    expect(provider.detailedEvidence.cleanup).toMatchObject({ snapshotsReleased: 1, privateRootRemoved: true });
    await expect(readdir(fixture.scratch)).resolves.toEqual([]);

    const failedFixture = await createFixture();
    const failed = createGpuPreviewVideoFrameProvider({
      pkg: failedFixture.pkg, scratchRoot: failedFixture.scratch, scratchAuthority: testAuthority(failedFixture.scratch),
      runner: mockRunner([], async (command) => command.executable === resolveFfprobeExecutable() ? { exitCode: 1, stdout: "", stderr: "probe refusal" } : ok())
    });
    await expect(failed.probe(new AbortController().signal)).rejects.toThrow("probe failed");
    await expect(readdir(failedFixture.scratch)).resolves.toEqual([]);
    await expect(failed.close()).resolves.toEqual({ closed: true, releasedFrames: 0, releasedSources: 0, privateScratchReleased: true });
  });

  it("refuses foreign private-child contents while preserving caller-owned scratch", async () => {
    const fixture = await createFixture();
    const callerMarker = join(fixture.scratch, "caller-owned.txt"); await writeFile(callerMarker, "keep", "utf8");
    const provider = createGpuPreviewVideoFrameProvider({ pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch), runner: mockRunner([], decodeOnePixel) });
    await provider.probe(new AbortController().signal);
    const privateChild = (await readdir(fixture.scratch)).find((name) => name.startsWith(".gpu-preview-video-"));
    expect(privateChild).toBeTruthy();
    const foreign = join(fixture.scratch, privateChild!, "foreign.txt"); await writeFile(foreign, "not-provider-owned", "utf8");
    await expect(provider.close()).rejects.toThrow();
    await expect(readFile(callerMarker, "utf8")).resolves.toBe("keep");
    await expect(readFile(foreign, "utf8")).resolves.toBe("not-provider-owned");
  });

  it("cleans once, refuses post-close calls, and proves a tiny real CFR source selects distinct PTS colors", async () => {
    const fixture = await createFixture();
    const provider = createGpuPreviewVideoFrameProvider({ pkg: fixture.pkg, scratchRoot: fixture.scratch, scratchAuthority: testAuthority(fixture.scratch), runner: mockRunner([], decodeOnePixel) });
    await provider.probe(new AbortController().signal);
    await expect(provider.close()).resolves.toMatchObject({ closed: true });
    await expect(provider.close()).resolves.toMatchObject({ closed: true });
    await expect(provider.probe(new AbortController().signal)).rejects.toThrow("closed");
    await expect(provider.framesFor([], new AbortController().signal)).rejects.toThrow("closed");

    if (!hostFfmpegAvailable) return;
    const real = await createFixture();
    const generator = createGovernedFfmpegRunner({ scratchRoot: real.scratch, operation: "test.gpu-preview-cfr-fixture" });
    const generated = await generator({ executable: resolveFfmpegExecutable(), shell: false, args: [
      "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=red:s=2x2:r=2:d=0.5", "-f", "lavfi", "-i", "color=c=blue:s=2x2:r=2:d=0.5",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", real.source
    ] });
    expect(generated.exitCode).toBe(0);
    const productionRunner: GpuPreviewFfmpegRunner = async (command, signal) => await createGovernedFfmpegRunner({ scratchRoot: real.scratch, operation: "test.gpu-preview-cfr-provider", signal })(command);
    const realProvider = createGpuPreviewVideoFrameProvider({ pkg: real.pkg, scratchRoot: real.scratch, scratchAuthority: testAuthority(real.scratch), runner: productionRunner });
    const realProbe = await realProvider.probe(new AbortController().signal);
    const first = (await realProvider.framesFor(requestAt(real.pkg, realProbe.snapshots, 0), new AbortController().signal)).frames[0]!;
    const second = (await realProvider.framesFor(requestAt(real.pkg, realProbe.snapshots, 500_000), new AbortController().signal)).frames[0]!;
    expect(first.resource.sha256).not.toBe(second.resource.sha256);
    expect(realProvider.detailedEvidence.decodedFrames.slice(-2).map((entry) => entry.decodedPts.value)).toEqual(["0", expect.any(String)]);
    await realProvider.close();
  }, 45_000);
});

async function createFixture(input: { durationMs?: number; fps?: number; layer?: Record<string, unknown>; secondAsset?: boolean } = {}): Promise<{ root: string; scratch: string; source: string; pkg: MotionPackage }> {
  const root = await mkdtemp(join(process.cwd(), ".scratch-gpu-preview-provider-")); roots.push(root);
  const assets = join(root, "assets"), scratch = join(root, "scratch");
  await mkdir(assets, { mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
  const source = join(assets, "clip.mp4"); await writeFile(source, "before", "utf8");
  const durationMs = input.durationMs ?? 1_000, fps = input.fps ?? 2;
  const layers: MotionPackage["motion"]["layers"] = [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs, transform: { width: 1, height: 1 }, ...(input.layer ?? {}) }];
  const assetsList = ["assets/clip.mp4"];
  if (input.secondAsset) {
    const second = join(assets, "alias.mp4"); await writeFile(second, "before", "utf8");
    // Same inode is the relevant production identity; a hard link models two manifest aliases.
    const { link } = await import("node:fs/promises"); await rm(second); await link(source, second);
    assetsList.push("assets/alias.mp4"); layers.push({ id: "alias", type: "video", assetRef: "assets/alias.mp4", startMs: 0, durationMs, transform: { width: 1, height: 1 } });
  }
  return {
    root, scratch, source,
    pkg: {
      root,
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_preview", name: "preview", motion: "motion.json", assets: assetsList, sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_preview", name: "preview", durationMs, fps, width: 1, height: 1, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers }
    }
  };
}

function requestAt(pkg: MotionPackage, snapshots: ReadonlyMap<string, import("@shellx-motion/core").GpuVideoSourceSnapshot>, atUs: number) {
  const result = compileGpuVideoFrameRequests({ motion: pkg.motion, atUs, snapshots });
  if (!result.ok) throw new Error(result.failure.message);
  return result.requests;
}

function mockRunner(calls: FfmpegCommand[], decode: (command: FfmpegCommand, signal: AbortSignal) => Promise<FfmpegProcessResult>): GpuPreviewFfmpegRunner {
  return async (command, signal) => {
    calls.push(command);
    if (command.args[0] === "-version") return { exitCode: 0, stdout: `${command.executable} version fixture\n`, stderr: "" };
    return await decode(command, signal);
  };
}
async function decodeOnePixel(command: FfmpegCommand): Promise<FfmpegProcessResult> {
  if (command.executable === resolveFfprobeExecutable()) return cfrProbe(2, 2);
  await writeFile(command.args.at(-1)!, Buffer.from([5, 6, 7, 255])); return ok();
}
function cfrProbe(fps: number, frameCount: number, input: { rFrameRate?: string; extraVideo?: boolean } = {}): FfmpegProcessResult {
  const durationTs = 1_000, timeBase = "1/1000", frameDuration = 1_000 / fps;
  const video = { codec_type: "video", width: 1, height: 1, avg_frame_rate: `${fps}/1`, r_frame_rate: input.rFrameRate ?? `${fps}/1`, time_base: timeBase, duration_ts: durationTs, nb_frames: frameCount, start_pts: 0, start_time: "0.000000" };
  return { exitCode: 0, stdout: JSON.stringify({ streams: input.extraVideo ? [video, video] : [video], format: {} }), stderr: "" };
}
function ok(): FfmpegProcessResult { return { exitCode: 0, stdout: "", stderr: "" }; }
async function eventually(assertion: () => void): Promise<void> { for (let attempt = 0; attempt < 50; attempt += 1) { try { assertion(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); } } assertion(); }
function testAuthority(path: string) { return { path, async assertCurrent() {} }; }
