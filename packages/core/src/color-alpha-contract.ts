import type {
  ColorAlphaUnsupportedFeature,
  CurrentColorAlphaContract,
  RendererColorAlphaCapability
} from "./color-alpha-types";

const UNSUPPORTED: readonly ColorAlphaUnsupportedFeature[] = Object.freeze([
  "hdr",
  "wide-gamut",
  "icc-profile-conversion",
  "ocio",
  "user-selectable-working-space"
]);

/**
 * The only renderer facts currently backed by implementation and conformance evidence.
 *
 * `unprofiled-srgb-assumed` is an input requirement, not ICC conversion: native PNG decoding reads
 * raw 8-bit RGB(A) samples and ignores profile chunks, while Chromium owns its own asset decode.
 * Profile-bearing image/video interpretation is therefore intentionally unsupported/undefined
 * rather than silently represented as a portable Motion feature.
 */
export const COLOR_ALPHA_LANE_CAPABILITIES = Object.freeze({
  native: Object.freeze({
    sourceEncoding: "sdr-srgb-encoded",
    rasterInput: "unprofiled-srgb-assumed",
    embeddedProfiles: "unsupported-undefined",
    alphaBoundary: "straight-rgba-png",
    filterDomain: "temporary-premultiplied-encoded-srgb",
    blendDomain: "encoded-srgb",
    crossRendererConformance: false,
    unsupported: UNSUPPORTED
  } satisfies RendererColorAlphaCapability),
  browser: Object.freeze({
    sourceEncoding: "sdr-srgb-encoded",
    rasterInput: "unprofiled-srgb-assumed",
    embeddedProfiles: "unsupported-undefined",
    alphaBoundary: "browser-managed-before-png-capture",
    filterDomain: "chromium-managed",
    blendDomain: "chromium-managed",
    crossRendererConformance: false,
    unsupported: UNSUPPORTED
  } satisfies RendererColorAlphaCapability),
  gpu: Object.freeze({
    sourceEncoding: "sdr-srgb-encoded",
    rasterInput: "unprofiled-srgb-assumed",
    embeddedProfiles: "unsupported-undefined",
    alphaBoundary: "straight-rgba-stream",
    filterDomain: "premultiplied-encoded-srgb",
    blendDomain: "premultiplied-encoded-srgb",
    crossRendererConformance: false,
    unsupported: UNSUPPORTED
  } satisfies RendererColorAlphaCapability),
  ffmpeg: Object.freeze({
    sourceEncoding: "sdr-srgb-encoded",
    rasterInput: "unprofiled-srgb-assumed",
    embeddedProfiles: "unsupported-undefined",
    alphaBoundary: "png-or-raw-rgba-frame-input",
    filterDomain: "not-a-frame-producer",
    blendDomain: "not-a-frame-producer",
    crossRendererConformance: false,
    delivery: Object.freeze({
      profile: "sdr-bt709",
      conversion: "rgb-full-to-yuv-limited",
      readback: "ffprobe-observed-tags"
    }),
    unsupported: UNSUPPORTED
  } satisfies RendererColorAlphaCapability)
});

/**
 * Current, observable SDR boundary. ADR-0204's linear-sRGB target remains proposed until a
 * renderer-neutral import, filter, blend, output, and readback conformance suite implements it.
 */
export const CURRENT_COLOR_ALPHA_CONTRACT: CurrentColorAlphaContract = Object.freeze({
  schema: "shellx-motion/color-alpha@1",
  status: "current-observable",
  authoredColors: Object.freeze({
    encoding: "sdr-srgb-encoded",
    syntax: "motion-css-subset",
    unsupportedSyntax: "wide-gamut-and-hdr-color-functions-refused"
  }),
  unprofiledRaster: Object.freeze({
    assumption: "sdr-srgb-encoded",
    embeddedProfiles: "unsupported-undefined"
  }),
  unsupported: UNSUPPORTED,
  lanes: COLOR_ALPHA_LANE_CAPABILITIES
});

export function cloneRendererColorAlphaCapability(capability: RendererColorAlphaCapability): RendererColorAlphaCapability {
  return {
    ...capability,
    ...(capability.delivery ? { delivery: { ...capability.delivery } } : {}),
    unsupported: [...capability.unsupported]
  };
}

/** Return a mutable response copy so callers cannot alter the canonical capability authority. */
export function currentColorAlphaContract(): CurrentColorAlphaContract {
  return {
    ...CURRENT_COLOR_ALPHA_CONTRACT,
    authoredColors: { ...CURRENT_COLOR_ALPHA_CONTRACT.authoredColors },
    unprofiledRaster: { ...CURRENT_COLOR_ALPHA_CONTRACT.unprofiledRaster },
    unsupported: [...CURRENT_COLOR_ALPHA_CONTRACT.unsupported],
    lanes: {
      native: cloneRendererColorAlphaCapability(CURRENT_COLOR_ALPHA_CONTRACT.lanes.native),
      browser: cloneRendererColorAlphaCapability(CURRENT_COLOR_ALPHA_CONTRACT.lanes.browser),
      gpu: cloneRendererColorAlphaCapability(CURRENT_COLOR_ALPHA_CONTRACT.lanes.gpu),
      ffmpeg: cloneRendererColorAlphaCapability(CURRENT_COLOR_ALPHA_CONTRACT.lanes.ffmpeg)
    }
  };
}
