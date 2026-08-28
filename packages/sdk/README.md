# ShellX Motion SDK

`@shellx-motion/sdk` is the versioned programmatic boundary shared by local hosts, future service transports, and the Design Studio-hosted Motion editor. It exposes typed `validate`, `compile`, `preview`, `render`, `renderCachePlan`, `status`, `cancel`, `timelineEdit`, and tracking request/inspect/apply/detach/verify operations without coupling consumers to CLI output text.

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

`renderCachePlan()` requires `render_motion` and only observes one exact v2 attested-reuse identity.
Its path-free result is a 4 KiB-bounded observation, never a lease, receipt, or authorization to
call `render()`: only a verified entry is a hit; absent/unmaterialized entries are misses; unsafe,
busy, unsupported, and integrity states are refusals. The final render independently rechecks all
identity, admission, output-root, and lock facts.

For file-video renders, `keepFrames?: boolean` is explicit retention intent. Omit it (or pass `false`) for the ordinary streamed FFmpeg route; the response exposes no frame path. `keepFrames: true` requires a final-video FFmpeg preset and, when diagnostic PNGs are needed, a successful materialized render returns `frames?: { dir, count }`. Those PNGs are diagnostic output, not the attested final-media artifact.

`createLocalMotionSdk` also accepts a host-only `streamingFinalRenderer` option for deterministic embedding tests of the bounded image2pipe handoff. It is deliberately not part of the SDK render request or remote transport contract.

`untrustedExecution` is also deliberately absent from every SDK request and transport. The
Linux-only `enforced-untrusted` browser profile is selected only by a direct trusted renderer host
through `BrowserRenderSessionOptions`, never by a package, agent, SDK request, CLI, Debug API, or
MCP call. It accepts data-only packages and requires verified Bubblewrap plus Motion's fixed
launcher; it refuses network authority and Chromium's `--no-sandbox` opt-out. It does not claim
FFmpeg/FFprobe containment, seccomp, or Windows/macOS equivalence. See [host
integration](../../docs/public/host-integration.md#enforced-untrusted-browser-renderer-trusted-host-configuration-only).

The headless `createMotionPlayer` accepts only `shellx-motion/player-source@1` values backed by an attested artifact identity. UI hosts provide a small media port for load/play/pause/seek/unload and retain one canonical package, render, receipt, and artifact identity.

Node/local hosts can use the real adapter without pulling Node-only modules into browser Player bundles:

```ts
import { createLocalMotionSdk } from "@shellx-motion/sdk/local";

const motion = createLocalMotionSdk({callerId:'cut:workspace-7'});
const job = await motion.submitRender({
  // Supply a stable id when a progress UI or reconnecting process must find this job before it ends.
  jobId: "cut:render-42",
  packageRoot: "/projects/example",
  outputPath: "/renders/example.mp4",
  preset: "mp4-h264"
});
// `id` is durable before work starts. A cancellation request is not terminal until status says so.
await job.cancel("operator stopped export");
const state = await job.status();
const events = await job.events();
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

// Existing analytic particle sources remain on the generic rich-set operation;
// this does not add a physics API or arbitrary formula surface.
const fieldEdited = await motion.timelineEdit({
  packageRoot: "/projects/example-revision-2",
  outDir: "/projects/example-revision-3",
  edit: {
    kind: "rich.set",
    layerId: "field-debris",
    path: "emitter.field.sources.0.strength",
    value: 0.72
  }
});

// Static trail fields use the same typed rich-set route. They are available only after a
// particles or points layer declares effects.trail; they are not keyframe targets or formulas.
const trailEdited = await motion.timelineEdit({
  packageRoot: "/projects/example-revision-3",
  outDir: "/projects/example-revision-4",
  edit: {
    kind: "rich.set",
    layerId: "field-debris",
    path: "effects.trail.durationMs",
    value: 480
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

`submitRender()` accepts only the coordinator-cancellable streamed final-video route. Its request
does not accept a workflow, quality manifest, retained frames, or dry run; call blocking `render()`
for those materialized compatibility paths. A direct local SDK host must configure its trusted
`callerId` to submit, inspect, cancel, or retry coordinator jobs; it is not a request field.

The local SDK exposes 35 dedicated operations. Its only dedicated interchange operation is
`gltfImport`. Generic `validate`, `render`, and `timelineEdit` can operate on a caller-selected
template package, but the SDK has no dedicated template catalog, plan, apply, media-replacement,
or ducking operation.

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
