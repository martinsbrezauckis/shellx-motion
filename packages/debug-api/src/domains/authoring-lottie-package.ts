/** Lottie-specific wrapper around the shared atomic vector package writer. */
import {
  flattenStaticLottiePrecomps,
  hashBuffer,
  lowerStaticLottieToMotion,
  type FlattenedLottiePrecomps
} from "@shellx-motion/core";
import { join } from "node:path";
import {
  writeStaticVectorPackage,
  type StaticVectorPackageOptions,
  type WrittenStaticVectorPackage
} from "./authoring-vector-package.js";

export interface WriteStaticLottiePackageOptions extends StaticVectorPackageOptions {}
export interface WrittenStaticLottiePackage extends WrittenStaticVectorPackage {
  loweringSourcePath: string;
  precomposition: Omit<FlattenedLottiePrecomps, "animationText">;
}

/** Lowers one bounded Lottie JSON source and atomically installs its package. */
export async function writeStaticLottiePackage(options: WriteStaticLottiePackageOptions): Promise<WrittenStaticLottiePackage> {
  let precomposition: FlattenedLottiePrecomps | undefined;
  let loweringPath = "source/input.lottie.json";
  const written = await writeStaticVectorPackage({
    adapterId: "adapter.lottie",
    formatLabel: "Lottie",
    sourceApp: "lottie",
    sourceFileName: "input.lottie.json",
    packagePrefix: "pkg_lottie",
    prepareSource: (bytes) => {
      const text = decodeLottieUtf8(bytes);
      precomposition = flattenStaticLottiePrecomps(text);
      loweringPath = precomposition.changed ? "source/flattened-animation.json" : "source/input.lottie.json";
      const loweringBytes = Buffer.from(precomposition.animationText, "utf8");
      const sourceSha256 = hashBuffer(bytes);
      return {
        primaryPath: "source/input.lottie.json",
        primarySha256: sourceSha256,
        loweringPath,
        loweringText: precomposition.animationText,
        files: [
          { path: "source/input.lottie.json", bytes, sha256: sourceSha256 },
          ...(precomposition.changed ? [{ path: loweringPath, bytes: loweringBytes, sha256: hashBuffer(loweringBytes) }] : [])
        ],
        manifestData: { precomposition: publicPrecomposition(precomposition) }
      };
    },
    lower: lowerStaticLottieToMotion
  }, options);
  if (!precomposition) throw new Error("Lottie precomposition preparation did not complete.");
  return {
    ...written,
    loweringSourcePath: join(written.packageRoot, loweringPath),
    precomposition: publicPrecomposition(precomposition)
  };
}

function publicPrecomposition(value: FlattenedLottiePrecomps): Omit<FlattenedLottiePrecomps, "animationText"> {
  const { animationText: _animationText, ...evidence } = value;
  return evidence;
}

function decodeLottieUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Lottie source must be valid UTF-8.");
  }
}
