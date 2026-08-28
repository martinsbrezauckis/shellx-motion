/**
 * Public current-only colour/alpha vocabulary.
 *
 * This is deliberately observational rather than a future working-space selector. It describes
 * only the renderer facts callers can rely on before ADR-0204's proposed parity work exists.
 */
export type ColorAlphaUnsupportedFeature =
  | "hdr"
  | "wide-gamut"
  | "icc-profile-conversion"
  | "ocio"
  | "user-selectable-working-space";

export interface RendererColorAlphaCapability {
  sourceEncoding: "sdr-srgb-encoded";
  rasterInput: "unprofiled-srgb-assumed";
  embeddedProfiles: "unsupported-undefined";
  alphaBoundary:
    | "straight-rgba-png"
    | "browser-managed-before-png-capture"
    | "straight-rgba-stream"
    | "png-or-raw-rgba-frame-input";
  filterDomain: "temporary-premultiplied-encoded-srgb" | "premultiplied-encoded-srgb" | "chromium-managed" | "not-a-frame-producer";
  blendDomain: "encoded-srgb" | "premultiplied-encoded-srgb" | "chromium-managed" | "not-a-frame-producer";
  crossRendererConformance: false;
  delivery?: {
    profile: "sdr-bt709";
    conversion: "rgb-full-to-yuv-limited";
    readback: "ffprobe-observed-tags";
  };
  unsupported: readonly ColorAlphaUnsupportedFeature[];
}

/** Public read-only description consumed by the local SDK capability endpoint. */
export interface CurrentColorAlphaContract {
  schema: "shellx-motion/color-alpha@1";
  status: "current-observable";
  authoredColors: {
    encoding: "sdr-srgb-encoded";
    syntax: "motion-css-subset";
    unsupportedSyntax: "wide-gamut-and-hdr-color-functions-refused";
  };
  unprofiledRaster: {
    assumption: "sdr-srgb-encoded";
    embeddedProfiles: "unsupported-undefined";
  };
  unsupported: readonly ColorAlphaUnsupportedFeature[];
  lanes: Readonly<Record<"native" | "browser" | "gpu" | "ffmpeg", RendererColorAlphaCapability>>;
}
