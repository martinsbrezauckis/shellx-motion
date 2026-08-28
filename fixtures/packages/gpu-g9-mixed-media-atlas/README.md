# Atlas of a Moving Story — G9 GPU Film

Creative intent: a filmic violet/teal room opens behind a cleaned presenter, while the text lands low and heavy enough to feel like a launch reel rather than a template preview. The composition deliberately carries moving footage, two static-SVG image plates, manifest typography, a rounded media mask, an alpha matte, fixed chroma spill/matte cleanup, a finishing pass, and an audio delivery contract.

Asset provenance is retained in the source package:

- `atmosphere-fog-rays.mp4` is the existing checked-in, silent generated-background sample, with its original provenance receipt in `templates/shellx-product-pack/keyed-subject-promo/receipts/generated-background.receipt.json`.
- Both SVG plates are the existing redistribution-safe ShellX Motion samples.
- Inter files are exact copies of the pack’s SIL OFL 1.1 faces; the license text is local beside them.
- `shellx-launch-tone.wav` is the checked-in ShellX Motion launch-tone source.

The footage is final-lane-only: stage its exact decoded frame in the governed GPU session, then render with `render --lane ffmpeg --frame-lane gpu`. Hardware proof is pending; this fixture has no final media hash, FFprobe facts, quality result, GPU producer receipt, timing/memory measurement, or visual approval yet.
