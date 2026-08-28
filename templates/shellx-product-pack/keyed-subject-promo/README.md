# ShellX Keyed Subject Promo

A presenter-led campaign template that combines a replaceable scene with a chroma-keyed subject, spill suppression, matte cleanup, parallax motion and a branded finishing pass.

The initial `subjectMedia` contract accepts a still plate on an even `#00ff00`
background. Both media slots require production rights. Typography is pinned to
package-local Inter Latin faces (SIL OFL 1.1; see
`assets/fonts/LICENSE-Inter.txt`) and the included sample assets are
redistribution-safe.

V25-B1 accepted implementation also admits the active background video to
`preview --lane gpu` through its host-owned, visual-only exact-time CFR provider.
That preview binds immutable source and decoded-RGBA evidence, uses pre-reserved
dynamic textures, and is not audio, final-video, or encoder/mux proof. Existing
final delivery remains `render --lane ffmpeg --frame-lane gpu`. The qualified Linux RTX 5080 rig
scrub/repeat, retained-resource high water, visual output, and cleanup are accepted
for the preview provider at runtime commit
`40b965bb69b02c2bcfc0b0972beaca2a07e4defa`.

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
