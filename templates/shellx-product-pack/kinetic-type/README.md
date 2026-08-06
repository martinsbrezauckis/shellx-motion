# ShellX Kinetic Type

Type-led explainer card built from deterministic text keyframes. It gives the starter catalog a kinetic typography family that agents can pick without hand-authoring every keyframe.

## Typography

Text layers render in Inter. The package bundles the Latin-subset Inter weights
it actually selects (700 Bold, 900 Black) under `assets/fonts/`, so the template
produces the same typeface and the same text metrics on a host with no Inter
installed. The declared stack is `Inter, Arial, Helvetica, sans-serif`: if a
host cannot load the bundled WOFF2 at all, it degrades to a sans face rather
than to the browser's default serif. The bundled files are SIL OFL 1.1 — see the
root `NOTICE` and `assets/fonts/LICENSE-Inter.txt`.
