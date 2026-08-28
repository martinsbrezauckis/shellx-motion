import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeMedia, type FfmpegRunner } from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("delivered media cadence", () => {
  it("derives GIF cadence from its frame count and duration instead of its quantized average-rate field", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gif-cadence-"));
    roots.push(root);
    const path = join(root, "animation.gif");
    await writeFile(path, "GIF89a");
    const runner: FfmpegRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        streams: [{
          codec_type: "video", codec_name: "gif", width: 1280, height: 720,
          avg_frame_rate: "100/3", nb_frames: "90", duration: "3.000000"
        }],
        format: { duration: "3.000000", format_name: "gif" }
      }),
      stderr: ""
    });

    await expect(probeMedia(path, { runner, inputRoots: [root] })).resolves.toMatchObject({
      codec: "gif", durationMs: 3_000, fps: 30
    });
  });
});
