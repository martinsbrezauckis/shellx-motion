import { lstat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { hashFile, type RetainedDirectoryAuthority } from "@shellx-motion/core";
import { measureFinalLoudnessInputs } from "./final-encode-shared.js";
import {
  measureAudioLevels,
  type FfmpegAudioInput,
  type FfmpegRunner
} from "./index.js";
import {
  snapshotSelfContainedFfmpegMediaInput,
  type FfmpegMediaInputSnapshot
} from "./ffmpeg-media-input-fence.js";

export async function snapshotStreamingFinalAudio(input: {
  audioInputs: FfmpegAudioInput[];
  inputRoots: string[];
  runner: FfmpegRunner;
  loudnessNormalizationRequested: boolean;
  /** Internal caller-owned child for an aggregate GPU-video operation. */
  staging?: { stagingRoot: string; authority: RetainedDirectoryAuthority };
}): Promise<{
  mediaSnapshots: FfmpegMediaInputSnapshot[];
  audioInputs: FfmpegAudioInput[];
  loudness: Awaited<ReturnType<typeof measureFinalLoudnessInputs>>;
}> {
  const mediaSnapshots = await Promise.all(input.audioInputs.map(async (audio) =>
    await retainedGpuPcmSnapshot(audio, input.staging) ?? await snapshotSelfContainedFfmpegMediaInput(audio.path, input.inputRoots, "final-audio", {
      ...(input.staging ? { stagingRoot: input.staging.stagingRoot, stagingAuthority: input.staging.authority } : {})
    })
  ));
  try {
    const audioInputs = input.audioInputs.map((audio, index) => ({
      ...audio,
      path: mediaSnapshots[index]!.path,
      receiptPath: audio.receiptPath ?? audio.path,
      snapshotSha256: mediaSnapshots[index]!.sha256
    }));
    const loudness = input.loudnessNormalizationRequested
      ? await measureFinalLoudnessInputs(audioInputs, {
          measure: (path) => measureAudioLevels(path, {
            runner: input.runner,
            inputRoots: mediaSnapshots.map((snapshot) => snapshot.root),
            admittedFinalAudio: true
          })
        })
      : { inputs: audioInputs, tracks: [] };
    return { mediaSnapshots, audioInputs, loudness };
  } catch (error) {
    await releaseStreamingFinalMediaSnapshots(mediaSnapshots);
    throw error;
  }
}

/** Reuse only the immutable PCM file created by the same admitted GPU-video stage; never copy it again. */
async function retainedGpuPcmSnapshot(
  audio: FfmpegAudioInput,
  staging: { stagingRoot: string; authority: RetainedDirectoryAuthority } | undefined
): Promise<FfmpegMediaInputSnapshot | undefined> {
  if (!staging || !audio.snapshotSha256) return undefined;
  await staging.authority.assertCurrent();
  const relation = relative(staging.stagingRoot, audio.path);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || relation.includes(sep)) {
    throw new Error("GPU video PCM handoff must remain an exact direct child of its admitted staging root.");
  }
  const info = await lstat(audio.path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("GPU video PCM handoff is no longer a regular immutable file.");
  if (await hashFile(audio.path) !== audio.snapshotSha256) throw new Error("GPU video PCM handoff changed after immutable staging.");
  return {
    sourcePath: audio.receiptPath ?? audio.path,
    path: audio.path,
    sha256: audio.snapshotSha256,
    byteLength: info.size,
    root: staging.stagingRoot,
    // Video staging owns the file and releases it after receipt binding; policy must not remove it.
    release: async () => undefined
  };
}

/** Release private audio copies after the caller has completed execution and final receipt binding. */
export async function releaseStreamingFinalMediaSnapshots(mediaSnapshots: readonly FfmpegMediaInputSnapshot[]): Promise<void> {
  await Promise.all(mediaSnapshots.map(async (snapshot) => await snapshot.release()));
}
