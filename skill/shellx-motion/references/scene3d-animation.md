# Persisted scene3d animation authoring

C5C1C is a closed Debug API/MCP persistence surface. Its only renderer exception is the direct `@shellx-motion/renderer-browser` `renderMotionGpuPreview` one-shot lowerer for the strict persisted-animation package shape; it is not a general playback or rendering capability.

## Workflow

1. Call `motion.timeline.scene3d-animation.inspect` and read the current store, stable track IDs, package identity, and Motion identity.
2. Use one of the five mutations: `track.upsert`, `track.remove`, `keyframe.upsert`, `keyframe.delete`, or `keyframe.move`.
3. Supply `edit_motion`, the source `packageRoot`, and an explicit `outDir` outside it. The output must be absent or empty.
4. Reopen the returned copy-on-write package and inspect its timeline receipt and bound source/output identities.

`track.upsert` accepts one complete typed track. Its immutable locator selects a `layerId` and exactly one channel:

- camera: `position`, `target`, or `fovDeg`;
- lighting: `ambient`, `direction`, `intensity`, or `color`;
- object: an `objectId` plus `position`, `rotationDeg`, `scale`, `emissive`, or `color`;
- background: `color`.

Values are locator-typed numbers, vec3 values, or `#RRGGBB` colours. They are never generic property paths or arbitrary JSON. Every `atUs` is an exact safe-integer physical microsecond; milliseconds and floating-point times refuse. Keyframe edits address the inspected stable `trackId`.

The trusted Debug host configures the required receipt mirror; the caller cannot widen it. Never hand-author `scene3dAnimation` JSON to evade the copy-on-write or receipt boundary.

The direct `@shellx-motion/renderer-browser` one-shot emits one PNG frame only when the accepted Core static/frame wrappers admit a visible root-only Scene3D document with no package assets, nested/companion layers, unsupported locator, or resource overage. Public reusable GPU sessions, generic Debug and Action preview, CLI, local SDK, Native, Browser HTML, FFmpeg/final, provider, Cut, and UE paths continue to refuse before resource or renderer work. It does not widen final rendering. The env-gated Node 24 qualified Linux GPU-host fixture still needs installed real-WebGPU two-playhead pixel, publication, and cleanup proof; WSL fake-runtime tests are source-contract evidence only. The [generated command reference](../../../docs/public/DEBUG_API_COMMANDS.md#motiontimelinescene3d-animationinspect) owns the exact argument schemas, and the [Debug API surface table](../../../docs/public/DEBUG_API.md) records the intentional no-route boundary.
