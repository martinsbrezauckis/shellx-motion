# Color pipeline contract

> Generated from `packages/core/src/color-pipeline.ts`. Do not edit by hand.

Motion packages may omit `colorPipeline`; omission resolves to `legacy-encoded-sdr@0.2.65` and preserves the encoded-SDR compatibility behavior of v0.2.65. It never inherits strict linear-light admission.

## Package declaration

`colorPipeline`, when present, is closed data:

```json
{
  "schema": "shellx-motion/color-pipeline@1",
  "intent": "linear-srgb-sdr@1"
}
```

No open `colorSpace` selector, profile path, ICC/OCIO configuration, or HDR/wide-gamut declaration exists.

## Declared intents

| Intent | Package input/work | Delivery intent | Admission now |
| --- | --- | --- | --- |
| `legacy-encoded-sdr@0.2.65` | legacy unprofiled SDR / renderer-defined encoded work | existing renderer-defined behavior | compatibility only |
| `linear-srgb-sdr@1` | unprofiled sRGB decode / premultiplied linear-sRGB | straight-sRGB frame boundary, limited SDR BT.709 `mp4-h264` through GPU to FFmpeg | exact bounded final route |

The strict declaration selects one closed final-delivery implementation: an opaque background plus at most 64 canvas-contained static rectangles, normal source-over only, up to 1920x1080, through the exact streamed GPU to FFmpeg `mp4-h264` route. A rectangle has either a lower-case `#rrggbb` fill or an F2a static linear/radial gradient: 2–16 lower-case `#rrggbb` stops, strictly increasing offsets anchored at 0 and 1, a finite linear angle in 0..360 degrees, or a radial centre in 0..1. The strict producer decodes each gradient stop to linear-sRGB before interpolation; alpha remains the bounded top-level rectangle opacity. Motion preflights the route shape plus the exact FFmpeg `zscale` and `libx264` contract before reserving output, performs premultiplied linear-sRGB WebGPU composition, validates BT.709 limited delivery with FFprobe, inverse-decodes one retained producer frame for calibrated comparison, and binds the observed evidence into the final receipt. Browser, Native, direct-frame, segmented, materialized, image/video/effect/audio, gradient keyframes, non-rect shapes, HDR, ICC, OCIO, fallback, and every other strict route remain refused.

## Receipt boundary

A package-validation receipt records the requested pipeline and explicitly marks lane implementation, frame alpha, observed delivery tags, decoded pixels, and runtime/tool identities as `not-observed`. That is source/validation evidence only, not pixel, host, installed, HDR, or native qualification.
