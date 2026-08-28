# ShellX Cinematic Rain Launch

An environment-backed product promo template with a replaceable full-frame scene, deterministic rain, wet-ground reflections, lens atmosphere, bounded copy controls, and explicit agent review targets.

The `heroMedia` slot intentionally accepts images in this first version because scene-sampled environment effects currently require a stable image source. Design Studio and Cut receive the rendered Motion result while preserving the linked package for later edits.

Typography is pinned to package-local Inter Latin faces (SIL OFL 1.1; see
`assets/fonts/LICENSE-Inter.txt`). Its authored rain-stage 3-sample, 150-degree
temporal blur is admitted on the GPU lane without altering the composition.
GPU requires live WebGPU hardware and refuses rather than silently using a
browser, native, or software fallback.
