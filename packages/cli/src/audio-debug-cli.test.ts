/** CLI parity for optional audio controls: omit optional keys so Debug handlers can apply defaults. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./main.js";
import { writeTinyPackageWithAudioLayer, writeTinyPackageWithTwoAudioLayers } from "./main.fixtures-packages.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("audio Debug CLI defaults", () => {
  it("omits curve when absent so the crossfade handler applies equal-power, and preserves an explicit curve", async () => {
    const source = await writeTinyPackageWithTwoAudioLayers();
    roots.push(source);
    const defaultOut = await scratch("crossfade-default");
    const explicitOut = await scratch("crossfade-explicit");

    const defaultResult = await runCli([
      "debug", "audio-crossfade-set", "--tier", "edit_motion", "--package", source, "--out", defaultOut,
      "--from-layer", "music", "--to-layer", "voice", "--duration-ms", "180",
    ], { trustedLocalTier: true });
    const explicitResult = await runCli([
      "debug", "audio-crossfade-set", "--tier", "edit_motion", "--package", source, "--out", explicitOut,
      "--from-layer", "music", "--to-layer", "voice", "--duration-ms", "180", "--curve", "linear",
    ], { trustedLocalTier: true });

    expect(defaultResult).toMatchObject({ ok: true, result: { curve: "equal-power" } });
    expect(explicitResult).toMatchObject({ ok: true, result: { curve: "linear" } });
  });

  it("omits channel when absent so the envelope producer applies mix, and accepts an explicit mix channel", async () => {
    const source = await writeTinyPackageWithAudioLayer();
    roots.push(source);
    const defaultOut = await scratch("envelope-default");
    const explicitOut = await scratch("envelope-explicit");
    const runner = async () => ({ exitCode: 0, stdout: "lavfi.astats.Overall.RMS_level=-20.0\n", stderr: "" });

    const defaultResult = await runCli([
      "debug", "audio-envelope-produce", "--tier", "edit_motion", "--package", source, "--out", defaultOut,
      "--source-layer", "music", "--envelope-id", "default-mix",
    ], { trustedLocalTier: true, ffmpegRunner: runner });
    const explicitResult = await runCli([
      "debug", "audio-envelope-produce", "--tier", "edit_motion", "--package", source, "--out", explicitOut,
      "--source-layer", "music", "--envelope-id", "explicit-mix", "--channel", "mix",
    ], { trustedLocalTier: true, ffmpegRunner: runner });

    expect(defaultResult).toMatchObject({ ok: true, result: { envelope: { channel: "mix" } } });
    expect(explicitResult).toMatchObject({ ok: true, result: { envelope: { channel: "mix" } } });
    const stored = JSON.parse(await readFile(join(defaultOut, "motion.json"), "utf8")) as { relationships?: { audioEnvelopes?: Array<{ id: string; channel: string }> } };
    expect(stored.relationships?.audioEnvelopes).toContainEqual({ id: "default-mix", sourceLayerId: "music", channel: "mix", samples: expect.any(Array) });
  });
});

async function scratch(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-cli-audio-${label}-`));
  roots.push(root);
  return root;
}
