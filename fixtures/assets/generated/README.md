# Generated Asset Fixtures

This folder is reserved for package-local generated-media fixtures used by offline tests.

Rules:

- Generated media must be imported into a Motion package under an `assets/` path before render.
- Every imported generated asset needs a `shellx-motion/generated-asset-receipt@1` receipt from `packages/core/src/asset-provenance.ts`.
- Authoring, planning, and verification use the configured local agent route.
- Image and video inputs arrive through a configured local generator route and are imported as files.
- Tests may use placeholder files and fake receipts, but the render path must not call local agents, hosted APIs, or the network.
- Receipts must record the package id, package-local asset ref, media type, prompt summary, tool/model label, provenance note, content hash, dimensions, duration for video, timestamp, and status.
