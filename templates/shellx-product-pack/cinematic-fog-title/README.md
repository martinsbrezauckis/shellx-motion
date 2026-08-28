# ShellX Cinematic Fog Title

A source-aware title sequence that turns a replaceable scene into a layered atmospheric opener with deterministic fog, moving light and depth. It is designed for trailers, documentary chapters and premium product films rather than slide transitions.

The media slot currently accepts still images. Typography is pinned to
package-local Inter Latin faces (SIL OFL 1.1; see
`assets/fonts/LICENSE-Inter.txt`); the generated package-local sample is
redistribution-safe and can be replaced with licensed production imagery.

Its authored fog-stage 3-sample, 140-degree temporal blur is admitted on the
GPU lane without altering the composition. GPU requires live WebGPU hardware
and refuses rather than silently using a browser, native, or software fallback.
