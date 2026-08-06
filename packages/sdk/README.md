# ShellX Motion SDK

`@shellx-motion/sdk` is the versioned programmatic boundary shared by local hosts, future service transports, and the Design Studio-hosted Motion editor. It exposes typed `validate`, `compile`, `preview`, `render`, `status`, `cancel`, `timelineEdit`, and tracking request/inspect/apply/detach/verify operations without coupling consumers to CLI output text.

```ts
import { createMotionSdk, createMotionSdkHandlerTransport } from "@shellx-motion/sdk";

const transport = createMotionSdkHandlerTransport({
  render: async (input, request) => {
    // Bind this handler to the local capability-gated Motion renderer.
    // request.cacheKey is the deterministic idempotency/cache identity.
    return {
      ok: true,
      output: {
        jobId: request.requestId,
        state: "queued",
        packageId: "pkg_example",
        motionId: "motion_example",
        preset: input.preset,
        outputPath: input.outputPath,
        warnings: []
      }
    };
  }
});

const motion = createMotionSdk(transport);
const render = await motion.render({
  packageRoot: "/projects/example",
  outputPath: "/renders/example.webm",
  preset: "webm-vp9",
  cutHandoff: { target: "shellx-cut", mode: "rendered_media" }
});
```

Every transport response must echo the protocol schema, operation, request ID, and SHA-256 cache key. The client rejects metadata swaps, malformed job state, and mismatched artifact identities before returning success.

The headless `createMotionPlayer` accepts only `shellx-motion/player-source@1` values backed by an attested artifact identity. UI hosts provide a small media port for load/play/pause/seek/unload and retain one canonical package, render, receipt, and artifact identity.

Node/local hosts can use the real adapter without pulling Node-only modules into browser Player bundles:

```ts
import { createLocalMotionSdk } from "@shellx-motion/sdk/local";

const motion = createLocalMotionSdk();
const validated = await motion.validate({ packageRoot: "/projects/example" });
const edited = await motion.timelineEdit({
  packageRoot: "/projects/example",
  outDir: "/projects/example-revision-2",
  edit: {
    kind: "keyframe.easing.apply",
    layerId: "title",
    target: "opacity",
    atMs: 320,
    easing: "ease-in-out"
  }
});

const tracked = await motion.trackingRequest({
  packageRoot: "/projects/example",
  outDir: "/projects/example-track-1",
  analysisId: "plate-track",
  assetId: "plate",
  mode: "point",
  model: "translation",
  reference: { atMs: 0, bounds: { x: 300, y: 180, width: 64, height: 64 }, points: [{ x: 332, y: 212 }] },
  settings: {
    startMs: 0, endMs: 5_000, stepMs: 40, direction: "forward",
    // Depth is not free accuracy. Each level halves the resolution, so a level whose pixels are
    // wider than the tracked feature cannot see it and coarse-to-fine locks onto a neighbour. On
    // the repository's 6-point homography fixture (5 px features) depth 2 gives a 0.193 px
    // residual and depth 3 gives 10.879 px with a `partial` status. Pick depth from the feature
    // scale; raise it only when a large `searchRadiusPx` will not otherwise fit the budget.
    searchRadiusPx: 48, pyramidLevels: 2, maxIterations: 40,
    // Inert: the search is exhaustive and ordered and consumes no randomness, so no seed value
    // changes a result. It is required by the schema and hashed into `settingsSha256`, so changing
    // it changes the request identity (and cache hits) and nothing else.
    confidenceFloor: 0.7, deterministicSeed: 20260714
  }
});
```

The local adapter atomically compiles packages and applies copy-on-write keyframe and tracking revisions, reopens each edited package, and returns its hashes with a verified immutable receipt. Tracking transport responses intentionally contain bounded lifecycle, confidence, and qualified-segment summaries; the full sample matrices remain in the package lifecycle artifact. Request uses `write_local`, inspect/verify use `read_motion`, and apply/detach use `edit_motion`. It renders through the capability-gated browser/FFmpeg pipeline, binds the SDK operation hash into an immutable render receipt, writes and verifies an attested artifact handle, and can bind the same handle reference into a rendered-media ShellX Cut plan. Cached Cut plans are bounded, opened without following symlinks, rechecked for stable file identity, and matched to the requested render before reuse. Exact cache/idempotency matches are reusable, and status/cancellation derive from host-owned receipts.

Browser hosts use the authenticated loopback endpoint exposed by `@shellx-motion/debug-server`:

```ts
import { createMotionSdk, createMotionSdkHttpTransport } from "@shellx-motion/sdk";

const motion = createMotionSdk(createMotionSdkHttpTransport({
  baseUrl: "http://127.0.0.1:7310",
  capabilityToken: ephemeralHostCapability
}));
```

The HTTP transport refuses non-loopback targets by default, omits browser credentials/referrers, rejects redirects, bounds response bytes, and aborts stalled requests. The server independently recomputes every request cache key and enforces its authenticated permission grant before invoking the local SDK transport.
