/** Bounded container-signature checks shared only by Core artifact internals. */
export function assertArtifactMediaMagic(header: Buffer, mediaType: string): void {
  const checks: Record<string, () => boolean> = {
    "image/png": () => header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/jpeg": () => header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff,
    "image/gif": () => header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a",
    "video/mp4": () => header.subarray(4, 8).toString("ascii") === "ftyp",
    "video/quicktime": () => header.subarray(4, 8).toString("ascii") === "ftyp",
    "video/webm": () => header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    "audio/wav": () => header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WAVE"
  };
  const check = checks[mediaType];
  if (!check) throw new Error(`unsupported attested artifact media type: ${mediaType}`);
  if (!check()) throw new Error(`artifact bytes do not match declared media type ${mediaType}`);
}
