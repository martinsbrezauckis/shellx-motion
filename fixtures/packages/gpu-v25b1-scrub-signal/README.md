# Scrub the Signal — V25-B1 GPU Preview Fixture

`Scrub the Signal` is an original 1920x1080, 30 fps, 6400 ms **visual-only**
Motion composition for the V25-B1 exact-time active-video preview slice. It layers trimmed,
looping atmosphere footage beneath an original neon studio treatment, local Inter typography,
fixed shape accents, and a bounded vignette/grain finishing pass. It intentionally has no audio
layer, audio asset, final-video staging, mux contract, Cut linkage, or frame-extraction material.

The test subject is `signal-footage`. It begins at 480 ms and lasts 5600 ms; its source is
trimmed to the half-open 720..1620 ms interval, loops, and runs at 1.25x. The exact forward,
backward, and random playhead contract is in [SCRUB_TRACE.md](SCRUB_TRACE.md). This is a source
fixture for deterministic request and cache qualification. V25-B1 source implementation can admit
it only through the host-owned visual-only provider; the fixture alone is not evidence that a qualified Linux GPU-host
native run has succeeded, decoded-frame/cache/texture high-water evidence has been retained, or
human visual acceptance has occurred.

## Package-local asset closure

Every referenced visual asset is copied byte-for-byte into this package by the checked-in source
recipe. The recipe pins both origin and digest:

| package asset | bytes | SHA-256 | retained origin |
| --- | ---: | --- | --- |
| `assets/video/atmosphere-fog-rays.mp4` | 392,216 | `24cfaf7065119713d771a48d3d47966c13004d95a8671c4cf2e53516c0834c7c` | `keyed-subject-promo` generated-background source and receipt |
| `assets/images/neon-studio.svg` | 1,517 | `4766625ed3986536412fa1c74c4abb40d746ea14a624a7e6483ea59582f47409` | ShellX Motion keyed-subject-promo Neon Studio sample |
| `assets/fonts/inter-latin-600-normal.woff2` | 24,452 | `f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a` | Inter SemiBold Latin subset, SIL OFL 1.1 |
| `assets/fonts/inter-latin-900-normal.woff2` | 23,900 | `d5c0ed7b8b5dde97d48b97947d740bbd8ad3ba9f2c5cc6b8280f16acba2d828e` | Inter Black Latin subset, SIL OFL 1.1 |
| `assets/fonts/LICENSE-Inter.txt` | 4,477 | `3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345` | package-local SIL Open Font License text |

The atmosphere video is the already-tracked silent source asset, not a rendered proof. Its
original generated-asset receipt is
`templates/shellx-product-pack/keyed-subject-promo/receipts/generated-background.receipt.json`.
The source recipe is
[`templates/generators/scrub-signal/recipe.json`](../../../templates/generators/scrub-signal/recipe.json);
it verifies the source bytes before copying and records canonical JSON parity for `manifest.json`
and `motion.json`. No code or visual material is imported from a researched repository.
