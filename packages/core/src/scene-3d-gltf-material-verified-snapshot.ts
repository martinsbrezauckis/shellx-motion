/**
 * Internal-only handoff for a decoder-owned RGBA result already bound by the sidecar verifier.
 * The symbol is intentionally not part of the Core barrel: normal callers can obtain only a
 * defensive copy through `rgba`, while the adjacent dormant render planner reuses the same owned
 * snapshot rather than decoding a second large image.
 */
const RGBA_SNAPSHOT = Symbol("scene3d-gltf-material-verified-rgba");

export interface Scene3dGltfVerifiedTextureSnapshot {
  readonly assetRef: string;
  readonly encodedSha256: string;
  readonly encodedByteLength: number;
  readonly decodedRgbaSha256: string;
  readonly decodedRgbaByteLength: number;
  readonly width: number;
  readonly height: number;
  /** A defensive copy of the verifier-owned decoded RGBA snapshot. */
  readonly rgba: Buffer;
}

type InternalSnapshot = Scene3dGltfVerifiedTextureSnapshot & { readonly [RGBA_SNAPSHOT]: Buffer };

/** Takes ownership of the decoder result; callers must not retain or mutate `rgba` afterward. */
export function ownScene3dGltfVerifiedTextureSnapshot(
  value: Omit<Scene3dGltfVerifiedTextureSnapshot, "rgba">,
  rgba: Buffer,
): Scene3dGltfVerifiedTextureSnapshot {
  const snapshot = { ...value } as Record<PropertyKey, unknown>;
  Object.defineProperty(snapshot, RGBA_SNAPSHOT, { value: rgba });
  Object.defineProperty(snapshot, "rgba", { enumerable: true, get: () => Buffer.from(rgba) });
  return Object.freeze(snapshot) as unknown as Scene3dGltfVerifiedTextureSnapshot;
}

/** Adjacent Core planner-only transfer; never expose this mutable Buffer to package consumers. */
export function scene3dGltfVerifiedTextureRgba(snapshot: Scene3dGltfVerifiedTextureSnapshot): Buffer {
  const rgba = (snapshot as InternalSnapshot)[RGBA_SNAPSHOT];
  if (!Buffer.isBuffer(rgba)) throw new Error("scene3d glTF verified texture snapshot lost its owned RGBA bytes.");
  return rgba;
}
