# ShellX Audio Launch

Audio-backed starter-pack template for the ShellX Motion product parity program.

Purpose:

- prove package audio layers in a user-facing template;
- render browser frames through FFmpeg with audio muxing;
- produce MP4s that pass audio stream and level checks;
- keep Cut/Design Studio compatibility disabled until connector receipts exist.

Primary quality-bar evidence:

- audio asset: `assets/audio/shellx-launch-tone.wav`;
- preview poster: `preview/poster.png`;
- expected render target: FHD 16:9 MP4 with an AAC audio stream.

The bundled WAV is a deterministic local synthetic tone generated with FFmpeg `lavfi` and committed as a small fixture so offline tests do not need a network or hosted generator.

## Typography

Text layers render in Inter. The package bundles the Latin-subset Inter weights
it actually selects (600 SemiBold, 800 ExtraBold, 900 Black) under `assets/fonts/`, so the template
produces the same typeface and the same text metrics on a host with no Inter
installed. The declared stack is `Inter, Arial, Helvetica, sans-serif`: if a
host cannot load the bundled WOFF2 at all, it degrades to a sans face rather
than to the browser's default serif. The bundled files are SIL OFL 1.1 — see the
root `NOTICE` and `assets/fonts/LICENSE-Inter.txt`.
