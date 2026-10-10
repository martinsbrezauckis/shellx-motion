/** Fixed frame-zero review-pack geometry for the private same-parent diagnostic only. */
import type { FileHandle } from "node:fs/promises";
import type { HeldFileFacts, HeldLeaf } from "./linear-srgb-sdr-final-held-media-files.js";

export const STRICT_SDR_FRAME0_PACK_WIDTH = 1_280;
export const STRICT_SDR_FRAME0_PACK_HEIGHT = 720;
export const STRICT_SDR_FRAME0_PACK_BYTES = STRICT_SDR_FRAME0_PACK_WIDTH * STRICT_SDR_FRAME0_PACK_HEIGHT * 4;
export const STRICT_SDR_FRAME0_PACK_SLOT_MAXIMUM_BYTES = 16 * 1024 * 1024;
export const STRICT_SDR_FRAME0_PACK_PARENT_MAXIMUM_BYTES = 128 * 1024 * 1024;
export const STRICT_SDR_FRAME0_PACK_ALL_SIX_MAXIMUM_BYTES = 74_618_216;

export type StrictSdrCandidateFrame0PackSlot = "f2a" | "f2b-screen" | "f2b-screen-controls";
type Root = Readonly<{ path: string; handle: FileHandle; identity: HeldFileFacts }>;

export type StrictSdrCandidateThreeSlotF2aFrame0PackAllocation = Readonly<{
  root: Root;
  leaves: Readonly<{
    sourceWhole: HeldLeaf;
    decodedWhole: HeldLeaf;
    sourceLinearBlackWhite: HeldLeaf;
    decodedLinearBlackWhite: HeldLeaf;
    sourceRadialThreeStop: HeldLeaf;
    decodedRadialThreeStop: HeldLeaf;
  }>;
}>;
export type StrictSdrCandidateF2bScreenFrame0PackAllocation = Readonly<{
  root: Root;
  leaves: Readonly<{
    sourceWhole: HeldLeaf;
    decodedWhole: HeldLeaf;
    sourceNormal: HeldLeaf;
    decodedNormal: HeldLeaf;
    sourceRadial: HeldLeaf;
    decodedRadial: HeldLeaf;
    sourceLeftOverlap: HeldLeaf;
    decodedLeftOverlap: HeldLeaf;
  }>;
}>;
export type StrictSdrCandidateF2bScreenControlsFrame0PackAllocation = Readonly<{
  root: Root;
  leaves: Readonly<{
    sourceWhole: HeldLeaf;
    decodedWhole: HeldLeaf;
    sourceSaturatedOverlays: HeldLeaf;
    decodedSaturatedOverlays: HeldLeaf;
    sourcePartialAlpha: HeldLeaf;
    decodedPartialAlpha: HeldLeaf;
    sourceTransparentZeroAlpha: HeldLeaf;
    decodedTransparentZeroAlpha: HeldLeaf;
  }>;
}>;

export type StrictSdrCandidateFrame0PackAllocation = StrictSdrCandidateThreeSlotF2aFrame0PackAllocation
  | StrictSdrCandidateF2bScreenFrame0PackAllocation
  | StrictSdrCandidateF2bScreenControlsFrame0PackAllocation;
export type StrictSdrCandidateFrame0PackImage = Readonly<{
  leaf: HeldLeaf;
  name: string;
  kind: "source" | "decoded";
  x: number;
  y: number;
  width: number;
  height: number;
  maximumBytes: number;
}>;

/** Fixed physical leaf tuple; callers cannot choose names or omit a literal crop. */
export function strictSdrCandidateFrame0PackLeafNames(slot: StrictSdrCandidateFrame0PackSlot): readonly string[] {
  if (slot === "f2a") return Object.freeze(["sourceWhole", "decodedWhole", "sourceLinearBlackWhite", "decodedLinearBlackWhite", "sourceRadialThreeStop", "decodedRadialThreeStop"]);
  if (slot === "f2b-screen") return Object.freeze(["sourceWhole", "decodedWhole", "sourceNormal", "decodedNormal", "sourceRadial", "decodedRadial", "sourceLeftOverlap", "decodedLeftOverlap"]);
  return Object.freeze(["sourceWhole", "decodedWhole", "sourceSaturatedOverlays", "decodedSaturatedOverlays", "sourcePartialAlpha", "decodedPartialAlpha", "sourceTransparentZeroAlpha", "decodedTransparentZeroAlpha"]);
}

const WHOLE_MAXIMUM_BYTES = 4 * 1024 * 1024;
const F2A_CROP_MAXIMUM_BYTES = 1_400_000;
const SCREEN_NORMAL_MAXIMUM_BYTES = 750_000;
const SCREEN_RADIAL_MAXIMUM_BYTES = 360_000;
const SCREEN_OVERLAP_MAXIMUM_BYTES = 250_000;
const CONTROLS_CROP_MAXIMUM_BYTES = 550_000;

/** No caller chooses a crop: the private owner derives the complete literal image tuple. */
export function strictSdrCandidateFrame0PackImages(
  slot: StrictSdrCandidateFrame0PackSlot,
  allocation: StrictSdrCandidateFrame0PackAllocation,
): readonly StrictSdrCandidateFrame0PackImage[] {
  const whole = wholeImages(allocation);
  if (slot === "f2a") {
    const value = allocation as StrictSdrCandidateThreeSlotF2aFrame0PackAllocation;
    return Object.freeze([...whole,
      image(value.leaves.sourceLinearBlackWhite, "sourceLinearBlackWhite", "source", 64, 64, 544, 592, F2A_CROP_MAXIMUM_BYTES),
      image(value.leaves.decodedLinearBlackWhite, "decodedLinearBlackWhite", "decoded", 64, 64, 544, 592, F2A_CROP_MAXIMUM_BYTES),
      image(value.leaves.sourceRadialThreeStop, "sourceRadialThreeStop", "source", 672, 64, 544, 592, F2A_CROP_MAXIMUM_BYTES),
      image(value.leaves.decodedRadialThreeStop, "decodedRadialThreeStop", "decoded", 672, 64, 544, 592, F2A_CROP_MAXIMUM_BYTES),
    ]);
  }
  if (slot === "f2b-screen") {
    const value = allocation as StrictSdrCandidateF2bScreenFrame0PackAllocation;
    return Object.freeze([...whole,
      image(value.leaves.sourceNormal, "sourceNormal", "source", 700, 156, 420, 408, SCREEN_NORMAL_MAXIMUM_BYTES),
      image(value.leaves.decodedNormal, "decodedNormal", "decoded", 700, 156, 420, 408, SCREEN_NORMAL_MAXIMUM_BYTES),
      image(value.leaves.sourceRadial, "sourceRadial", "source", 760, 216, 280, 288, SCREEN_RADIAL_MAXIMUM_BYTES),
      image(value.leaves.decodedRadial, "decodedRadial", "decoded", 760, 216, 280, 288, SCREEN_RADIAL_MAXIMUM_BYTES),
      image(value.leaves.sourceLeftOverlap, "sourceLeftOverlap", "source", 360, 236, 220, 248, SCREEN_OVERLAP_MAXIMUM_BYTES),
      image(value.leaves.decodedLeftOverlap, "decodedLeftOverlap", "decoded", 360, 236, 220, 248, SCREEN_OVERLAP_MAXIMUM_BYTES),
    ]);
  }
  const value = allocation as StrictSdrCandidateF2bScreenControlsFrame0PackAllocation;
  return Object.freeze([...whole,
    image(value.leaves.sourceSaturatedOverlays, "sourceSaturatedOverlays", "source", 64, 180, 352, 352, CONTROLS_CROP_MAXIMUM_BYTES),
    image(value.leaves.decodedSaturatedOverlays, "decodedSaturatedOverlays", "decoded", 64, 180, 352, 352, CONTROLS_CROP_MAXIMUM_BYTES),
    image(value.leaves.sourcePartialAlpha, "sourcePartialAlpha", "source", 464, 180, 352, 352, CONTROLS_CROP_MAXIMUM_BYTES),
    image(value.leaves.decodedPartialAlpha, "decodedPartialAlpha", "decoded", 464, 180, 352, 352, CONTROLS_CROP_MAXIMUM_BYTES),
    image(value.leaves.sourceTransparentZeroAlpha, "sourceTransparentZeroAlpha", "source", 864, 180, 352, 352, CONTROLS_CROP_MAXIMUM_BYTES),
    image(value.leaves.decodedTransparentZeroAlpha, "decodedTransparentZeroAlpha", "decoded", 864, 180, 352, 352, CONTROLS_CROP_MAXIMUM_BYTES),
  ]);
}

export function strictSdrCandidateFrame0PackCrop(bytes: Buffer, image: StrictSdrCandidateFrame0PackImage): Buffer {
  if (bytes.byteLength !== STRICT_SDR_FRAME0_PACK_BYTES) throw new Error("Strict-SDR frame-zero pack requires one exact 1280x720 RGBA frame.");
  if (image.x === 0 && image.y === 0 && image.width === STRICT_SDR_FRAME0_PACK_WIDTH && image.height === STRICT_SDR_FRAME0_PACK_HEIGHT) return Buffer.from(bytes);
  const rowBytes = image.width * 4, result = Buffer.alloc(image.height * rowBytes);
  for (let row = 0; row < image.height; row += 1) {
    const start = ((image.y + row) * STRICT_SDR_FRAME0_PACK_WIDTH + image.x) * 4;
    bytes.copy(result, row * rowBytes, start, start + rowBytes);
  }
  return result;
}

function wholeImages(allocation: StrictSdrCandidateFrame0PackAllocation): readonly StrictSdrCandidateFrame0PackImage[] {
  return [
    image(allocation.leaves.sourceWhole, "sourceWhole", "source", 0, 0, STRICT_SDR_FRAME0_PACK_WIDTH, STRICT_SDR_FRAME0_PACK_HEIGHT, WHOLE_MAXIMUM_BYTES),
    image(allocation.leaves.decodedWhole, "decodedWhole", "decoded", 0, 0, STRICT_SDR_FRAME0_PACK_WIDTH, STRICT_SDR_FRAME0_PACK_HEIGHT, WHOLE_MAXIMUM_BYTES),
  ];
}
function image(leaf: HeldLeaf, name: string, kind: "source" | "decoded", x: number, y: number, width: number, height: number, maximumBytes: number): StrictSdrCandidateFrame0PackImage {
  return Object.freeze({ leaf, name, kind, x, y, width, height, maximumBytes });
}
