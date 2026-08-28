# Tidal Reassembly — V0.2 Particle Motion Sample

An original, asset-free eight-second GPU sample. Three weighted spatial streams share one
sea-glass-and-vermilion field, braid into an asymmetric tide cell, skim a low horizontal
collision boundary, and finally break into an impact pulse. It is composed for 1920x1080
product-film review, not as a diagnostic clip.

`tide-field` is exactly 100,000 seeded circular particles under
`shellx-motion/particle-field@2`. Its four fixed sources are one flow, one turbulence source, one
axis-aligned collision plane, and one finite impact pulse. The three origin weights are
0.36 + 0.36 + 0.28 = 1. The short analytic two-sample trail and fixed `glow` shading are renderer-owned
controls; the emitter primary/secondary colours are shared by all three origins. The fixed v2
compute route retains two 64-byte-per-instance buffers: 12,800,000 bytes at this 100,000-particle
fixture and 16,777,216 bytes at the 131,072-particle maximum. This package supplies no shaders,
callbacks, scripts, texture, or persistent state.

The composition deliberately avoids a framing mask or particle matte: the three streams and their
fixed field mechanics own the silhouette, with no hard aperture or collision guide competing with
the particle motion. The package participates in strict GPU static/frame admission; native pixel, retained
resource, transport, and final-receipt proof remain separate qualification evidence.

The source recipe is at
[`templates/generators/tidal-reassembly/recipe.json`](../../../templates/generators/tidal-reassembly/recipe.json)
and can regenerate this package through the adjacent `generate.py`. It uses only checked-in JSON
and Python standard-library serialization. There are no third-party source assets, fonts, logos,
characters, generated image inputs, or copied visual references to attribute.
