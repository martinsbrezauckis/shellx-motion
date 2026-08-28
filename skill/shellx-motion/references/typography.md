# ShellX Motion typography delivery

Chromium is Motion's production typography authority only for generated MotionIR text whose
requested family is backed by manifest-declared package font bytes. Motion reads and hashes the
regular package file, embeds it, waits for the face, and records fallback evidence. Inspect
`receipt.output.typography.fontAssets` and the `attestation` rather than inferring a host font from
the rendered pixels.

HTML, web, and canvas layers can render normally, but their text scope is always `unverified`:
dynamic canvas and package script can draw text Motion cannot enumerate or attribute. They add a
receipt warning. If the package requests `quality.maxFontFallbacks`, final render and dry-run
refuse that browser scope with `browser_html_typography_unverified`; an unbound generated family
refuses with `browser_motion_typography_unverified`. Do not claim arbitrary host fonts, cross-host
glyph parity, or a complex-script conformance fixture from this evidence. Native remains the
block-glyph preview lane and refuses non-deliverable text rather than switching lanes.
