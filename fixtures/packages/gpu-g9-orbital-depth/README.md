# Orbital Depth — G9 GPU Film

Creative intent: an orbital launch chamber uses a slow spatial orbit, a cyan glTF sail, a rose pyramid, cold telemetry light, snow trails, and shifting fog to give Motion a genuine depth-first closing film.

`assets/source/orbital-triangle.gltf` is the checked-in ShellX Motion bounded triangle fixture. The scene carries the exact lowerer-produced mesh geometry and geometry SHA-256, so it proves the data-only glTF route rather than claiming an arbitrary 3D loader. The `scene3d` layer is depth-buffered with its own camera; the separate Motion camera establishes the 2D camera contract.

This film intentionally does not use a `depth` property on every 2D layer: the current 2.5D depth contract requires it on every generated visual layer and refuses depth/mattes and non-normal blends. Keeping the environment overlays and stateless trails screen-space is the honest composition that still combines a real depth-buffered 3D scene, camera, two environments, trails, and post effects.

Inter is copied from the checked-in product pack under SIL OFL 1.1. Hardware proof is pending: render only through `render --lane ffmpeg --frame-lane gpu` on an approved native host and retain representative frames, final media hash, FFprobe, quality, GPU evidence, timing, memory, and visual review before treating this as a product film.
