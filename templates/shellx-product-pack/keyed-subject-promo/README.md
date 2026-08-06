# ShellX Keyed Subject Promo

A presenter-led campaign template that combines a replaceable scene with a chroma-keyed subject, spill suppression, matte cleanup, parallax motion and a branded finishing pass.

The initial `subjectMedia` contract accepts a still plate on an even `#00ff00` background. Both media slots require production rights. Typography uses the host sans-serif stack and the included sample assets are redistribution-safe.

Generated background footage:

- The `backgroundMedia` slot now ships real generated moving footage and its
  `acceptedKinds` are `["image", "video"]`.
- Asset: `assets/generated/atmosphere-fog-rays.mp4` - a bundled AI-generated
  sample (teal-cyan volumetric god-rays and drifting fog, 736x400 @24fps ~6s).
  The primary `h264` video stream is
  preserved bit-for-bit; the incidental AAC audio track and mjpeg cover-art
  stream were stripped at import (`ffmpeg -map 0:v:0 -c:v copy -an`) so the
  background is a clean silent moving scene. The `background-scene` layer sets
  `includeAudio: false`.
- Receipt: `receipts/generated-background.receipt.json` (public-safe licence,
  content-hash, dimensions, and stream-processing evidence).
- The `background-scene` layer uses `fit: fill` onto the 1920x1080 canvas, so
  the footage upscales at render time; atmospheric fog tolerates the small fill
  aspect adjustment without visible distortion.
- `neon-studio.svg` is retained as a redistribution-safe still-image alternate.
