# ShellX Editorial Liquid Surface

An image-led editorial opener that samples a replaceable package-local frame through deterministic water optics, caustics and refractive motion. It is intended to feel like a short premium brand film rather than a moving slide.

The `heroMedia` slot currently accepts still images because scene sampling
requires a stable package-local source. Typography is pinned to package-local
Inter Latin faces (SIL OFL 1.1; see `assets/fonts/LICENSE-Inter.txt`); the
generated sample is redistribution-safe and should be replaced with licensed
media for production exports.

Its authored water-stage 3-sample, 120-degree temporal blur is admitted on the
GPU lane without altering the composition. GPU requires live WebGPU hardware
and refuses rather than silently using a browser, native, or software fallback.
