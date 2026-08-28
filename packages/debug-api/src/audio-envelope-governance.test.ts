import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index.js";

const roots: string[] = [];

describe("procedural audio-envelope decoder authority", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  // This fixture is a POSIX shebang, not a native Windows executable. Windows Job Object process
  // containment is exercised with native children in renderer-ffmpeg's dedicated Windows suite.
  it.skipIf(process.platform === "win32")("routes the default Debug surface through the caller-bound governed decoder", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-envelope-governance-"));
    roots.push(root);
    const packageRoot = join(root, "source");
    const outDir = join(root, "out");
    const scratchRoot = join(root, "scratch");
    const ffmpegShim = join(root, "ffmpeg-envelope-shim.js");
    const previousFfmpeg = process.env.SHELLX_MOTION_FFMPEG;
    const previousScratch = process.env.SHELLX_MOTION_SCRATCH_ROOT;
    await writeEnvelopePackage(packageRoot);
    await writeFile(
      ffmpegShim,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const duration = args.indexOf("-t");
const expected = duration >= 0 && args[duration + 1] === "1" && args.includes("-vn") && args.includes("-sn") && args.includes("-dn");
if (!expected) process.exit(87);
process.stdout.write("lavfi.astats.Overall.RMS_level=-20.0\\n");
`,
      "utf8",
    );
    await chmod(ffmpegShim, 0o755);
    process.env.SHELLX_MOTION_FFMPEG = ffmpegShim;
    process.env.SHELLX_MOTION_SCRATCH_ROOT = scratchRoot;
    try {
      const result = await dispatchDebugCommand(
        "motion.procedural.audio-envelope.produce",
        { packageRoot, outDir, sourceLayerId: "music", envelopeId: "music-rms", sampleEveryMs: 50 },
        {
          tier: "edit_motion",
          callerId: "governed-envelope-test",
          authoringInputRoots: [root],
          authoringOutputRoots: [root],
        },
      );
      expect(result).toMatchObject({
        ok: true,
        result: {
          resources: {
            schema: "shellx-motion/local-job-resources@1",
            lane: "ffmpeg",
            operation: "ffmpeg.render",
            state: "passed",
          },
          receipt: {
            output: {
              resources: {
                schema: "shellx-motion/local-job-resources@1",
                lane: "ffmpeg",
                operation: "ffmpeg.render",
                state: "passed",
              },
            },
          },
        },
      });
    } finally {
      restoreEnv("SHELLX_MOTION_FFMPEG", previousFfmpeg);
      restoreEnv("SHELLX_MOTION_SCRATCH_ROOT", previousScratch);
    }
  });
});

async function writeEnvelopePackage(root: string): Promise<void> {
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "tone.wav"), "fixture audio bytes", "utf8");
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "governed-envelope-fixture",
    name: "Governed envelope fixture",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["ffmpeg"], hosts: ["shellx-motion"] },
  }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "governed-envelope-motion",
    name: "Governed envelope fixture",
    durationMs: 1_000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [{ id: "music", type: "audio", source: "assets/tone.wav", startMs: 0, durationMs: 1_000 }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
  }, null, 2)}\n`, "utf8");
}

function restoreEnv(name: "SHELLX_MOTION_FFMPEG" | "SHELLX_MOTION_SCRATCH_ROOT", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
