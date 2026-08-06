# ShellX Media Launch

Media-rich starter-pack template for the ShellX Motion product parity program.

Purpose:

- prove package-local generated media assets;
- expose a media replacement slot through TemplateIR;
- render through the browser + FFmpeg lane without network access;
- keep Cut/Design Studio compatibility disabled until connector receipts exist.

Primary quality-bar evidence:

- generated hero asset: `assets/generated/shellx-media-launch-hero-1080p.jpg`
  (a bundled AI-generated sample resized from 1280x720 to the slot-exact
  1920x1080 hero canvas — see the receipt `sampleDetails.processing`);
- generated hero receipt: `receipts/generated-hero.receipt.json`;
- alternate hero asset (editorial variety, native 1280x720 unmodified generator
  bytes): `assets/generated/shellx-media-launch-hero-alt.jpg`, selectable via the
  second `inputExamples` entry;
- alternate hero receipt: `receipts/generated-hero-alt.receipt.json`;
- preview poster: `preview/poster.png`;
- expected render targets: FHD 16:9 MP4 and square social MP4.

The hero slot (`motion.json` `generated-hero` layer + declared `assets` entry)
is 1920x1080, so the slot-exact 1.5x-upscaled variant is wired as the default;
the unmodified bundled 1280x720 alternate remains available through the second
input example.

## Typography

Text layers render in Inter. The package bundles the Latin-subset Inter weights
it actually selects (600 SemiBold, 800 ExtraBold, 900 Black) under `assets/fonts/`, so the template
produces the same typeface and the same text metrics on a host with no Inter
installed. The declared stack is `Inter, Arial, Helvetica, sans-serif`: if a
host cannot load the bundled WOFF2 at all, it degrades to a sans face rather
than to the browser's default serif. The bundled files are SIL OFL 1.1 — see the
root `NOTICE` and `assets/fonts/LICENSE-Inter.txt`.
