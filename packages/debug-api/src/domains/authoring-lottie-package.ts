/** Lottie-specific wrapper around the shared atomic vector package writer. */
import {
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
      // The Core lowerer selects its bounded GPU precomposition branch before
      // the legacy diagnostics. Passing the original text is essential: the
      // old flattener cannot represent transformed or clipped `ty:0` wrappers.
      // For a source without `ty:0`, this remains byte-for-byte the old input
      // path and therefore leaves package/receipt fingerprints unchanged.
      precomposition = unflattenedPrecomposition(text);
      loweringPath = "source/input.lottie.json";
      const sourceSha256 = hashBuffer(bytes);
      return {
        primaryPath: "source/input.lottie.json",
        primarySha256: sourceSha256,
        loweringPath,
        loweringText: text,
        files: [{ path: "source/input.lottie.json", bytes, sha256: sourceSha256 }],
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

function unflattenedPrecomposition(animationText: string): FlattenedLottiePrecomps {
  return {
    schema: "shellx-motion/lottie-precomp-flattening@1",
    animationText,
    flattenedPrecompCount: 0,
    flattenedLayerCount: 0,
    maxDepth: 0,
    changed: false,
    policy: "full-frame-identity-static"
  };
}

function decodeLottieUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Lottie source must be valid UTF-8.");
  }
}
