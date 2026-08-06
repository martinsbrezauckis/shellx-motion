import { hashBuffer } from "./receipts";
import { decodeDotLottieUtf8, parseBoundedJsonObject } from "./dotlottie-json";
import type { ParsedDotLottieManifest } from "./dotlottie-manifest";
import type { DotLottieBundledJsonResource, DotLottieLimits, DotLottieManifestResource } from "./dotlottie-types";
import { findDotLottieFile, readDotLottieZipEntry, type DotLottieZipEntry } from "./dotlottie-zip";

export function readDeclaredDotLottieResources(input: {
  manifest: ParsedDotLottieManifest;
  entries: DotLottieZipEntry[];
  archive: Buffer;
  limits: DotLottieLimits;
}): DotLottieBundledJsonResource[] {
  if (input.manifest.version !== "2") return [];
  return [
    ...readResources("theme", "t", input.manifest.inventory.themes, input),
    ...readResources("state-machine", "s", input.manifest.inventory.stateMachines, input)
  ];
}

function readResources(
  kind: DotLottieBundledJsonResource["kind"],
  prefix: "t" | "s",
  resources: DotLottieManifestResource[],
  input: Parameters<typeof readDeclaredDotLottieResources>[0]
): DotLottieBundledJsonResource[] {
  return resources.map((resource) => {
    const archivePath = `${prefix}/${resource.id}.json`;
    const entry = findDotLottieFile(input.entries, archivePath);
    if (!entry) throw new Error(`dotLottie manifest ${kind} ${resource.id} is missing ${archivePath}.`);
    if (entry.uncompressedSize > input.limits.maxManifestBytes) {
      throw new Error(`dotLottie ${kind} ${resource.id} exceeds the JSON resource limit.`);
    }
    const bytes = readDotLottieZipEntry(input.archive, entry, input.limits);
    const text = decodeDotLottieUtf8(bytes, `dotLottie ${kind} ${resource.id}`);
    parseBoundedJsonObject(text, `dotLottie ${kind} ${resource.id}`);
    return {
      kind,
      id: resource.id,
      ...(resource.name ? { name: resource.name } : {}),
      archivePath,
      text,
      sha256: hashBuffer(bytes)
    };
  });
}
