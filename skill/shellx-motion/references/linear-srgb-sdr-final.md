# Strict linear-SDR final recipe

Use [`fixtures/packages/linear-srgb-sdr-final`](../../../fixtures/packages/linear-srgb-sdr-final) as
the checked flat-rectangle recipe and
[`fixtures/packages/linear-srgb-sdr-f2a-gradients`](../../../fixtures/packages/linear-srgb-sdr-f2a-gradients)
as the checked F2a gradient recipe for `colorPipeline.intent: "linear-srgb-sdr@1"`. The route is
deliberately narrow: one opaque lower-case hex background plus at most 64 static, canvas-contained
`shape: "rect"` layers with either a lower-case six-digit hex fill or one F2a linear/radial
gradient. An F2a gradient has 2–16 lower-case six-digit opaque stops with strictly increasing
offsets anchored at `0` and `1`, plus either a finite `angle` in `0..360` or a radial `centerX` /
`centerY` in `0..1`; stops interpolate in linear light. Every layer starts at zero, spans the full
document duration, and uses only integer `transform.x/y/width/height` plus optional top-level
`opacity`. Assets, audio, animation, gradient keyframes, effects, masks, groups, alternate shapes,
screen composition, blur/glow, and fallback lanes refuse before GPU/output allocation.

```bash
shellx-motion render /path/to/linear-srgb-sdr-package \
  --lane ffmpeg --frame-lane gpu --preset mp4-h264 \
  --out /path/to/absent-output.mp4
```

This exact route preflights WebGPU plus FFmpeg `zscale`, `libx264`, and FFprobe before reserving the
output. Success means the receipt binds the linear-sRGB producer, fixed limited-BT.709 conversion,
observed delivery tags, inverse-decoded frame comparison, output hash, tool identities, and cleanup.
It is not Browser/Native parity, a general GPU scene route, HDR, or installed-host qualification.
The generated [rendering sample catalog](../../../docs/public/RENDERING_SAMPLES.md) owns the canonical
source-checkout and installed invocation forms.
