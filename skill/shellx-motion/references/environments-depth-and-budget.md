# Environments, depth cameras, and the render budget an agent must plan against

Three things a piece can be designed around only if you know them **before** you author it: the
closed value sets an environment layer accepts, the exact arithmetic a camera applies to a depth
plane, and how much browser memory a full-length render actually costs. Each statement below was
read out of the implementation or measured on a real render; where a number is a local measurement
rather than a rule, it says so.

## Environment layers: the closed sets

An `type: "environment"` layer carries a bounded `environment` record. Four fields are closed sets
and `shellx-motion validate` refuses anything outside them **before** you render, so validate the
package rather than discovering the set at render time.

| Field | Accepted values | Source of record |
|---|---|---|
| `environment.schema` | `shellx-motion/environment@1` | `ENVIRONMENT_SCHEMA` |
| `environment.kind` | `rain`, `water`, `snow`, `fog` | `ENVIRONMENT_KINDS` |
| `environment.quality` | `preview`, `balanced`, `cinematic` | `ENVIRONMENT_QUALITY_TIERS` |
| `environment.mode` | `scene`, `overlay` | `validateEnvironmentLayers` |

The first three constants live in `packages/core/src/environment.ts`; `mode` is checked in
`packages/core/src/validate.ts`. There is no `"standard"`, `"high"`, `"low"` or `"draft"` quality,
and the refusal names the whole set:

```jsonc
// shellx-motion validate <package> — with "quality": "standard"
{ "path": "/layers/0/environment/quality", "message": "must be preview, balanced, cinematic" }
```

Bounds enforced alongside them: at most **4** environment layers in one document
(`MAX_ENVIRONMENT_LAYERS`); at most **4** rain / snow / fog depth layers and 4 water wave octaves;
`seed` is an unsigned 32-bit integer; every environment colour field is `#RRGGBB` — an 8-digit
`#RRGGBBAA` is refused by validate, so do not carry alpha in an environment colour.

**What `quality` actually changes.** It caps the shader's per-frame inner cost, nothing else:
`preview` clamps effective depth layers (or water wave octaves) to 2, `balanced` to 3, `cinematic`
to 4, and the receipt records requested vs effective (`effectiveDepthLayers`). It is a cost dial,
not a memory dial — see the measurement in the budget section below before reaching for it to
rescue a render.

### Binding an environment to package footage

Place a **visible full-frame image layer before** the environment layer and declare
`environment.sceneSourceLayerId`. The source must cover the environment's complete timing, use
`fit: "fill"`, opacity 1, and an identity full-document transform; crop, masks, mattes, effects,
keyframes and blend modes are all rejected, because the fixed shader samples decoded package pixels
directly. `mode: "scene"` is required. Rain samples it for wet-ground reflections, water for
reflection and refraction, snow for accumulated ground coverage. Complete example:
`fixtures/packages/environment-rain-footage`.

For authored occlusion or shore/contact coverage, add a **second earlier full-frame image at
effective opacity 0** and declare `environment.effectMaskLayerId`. White permits the effect, black
protects foreground pixels, grayscale gives a soft boundary. The hidden mask obeys the same timing,
fit, transform and no-lossy-processing rules as the scene source.

Both bindings are declared rich controls afterwards, so rebind through
`debug layer-rich-set --path environment.sceneSourceLayerId` rather than editing raw JSON.

### Fog

`kind: "fog"` uses the same fixed, data-only host runtime. Its bounded `fog` record exposes
`density`, `speed`, `scale`, `turbulence`, `height`, `depthLayers` (up to 4) and `lightStrength`;
every scalar except the depth-layer count is keyframable. Multi-timestamp footage-aware example:
`fixtures/packages/environment-fog-cinematic`.

## Depth compositions and the camera

A depth composition is one `camera` layer plus a `depth` on every generated visual layer. Motion
then renders each layer as its own plane and applies camera motion scaled by that plane's depth.

### The rules validate enforces

Read these as a set: breaking any one of them fails `validate`, with the message quoted.

| Rule | Refusal message |
|---|---|
| `depth` must be a finite number in **-0.9 … 3** | `must be a finite number between -0.9 and 3` |
| once ANY layer has `depth`, EVERY generated visual layer needs one | `is required on every generated visual layer in a depth composition` |
| `depth` needs a `camera` layer in the document | `requires a camera layer` |
| `depth` only on generated visual layers (`shape`, `text`, `caption`, `image`, `video`, `particles`, `shader`, `scene3d`, `environment`) | `is supported only on generated visual layers` |
| **a depth layer's `blendMode` must be absent or `"normal"`** | `depth planes do not yet support layer blend modes` |
| a depth layer may not carry a `matte` | `depth planes do not yet support mattes` |

The blend-mode rule is the one that costs a session: a "wall of light" wipe, a screen-blended glow,
a `lighten` flare — all of them are ordinary compositing moves that a depth composition rejects
outright. Build the same look with `layer.gradient` under `blendMode: "normal"`, or keep the
blended layer **out** of the depth stack. `adjustment` layers are exempt: they are never depth
planes, and stay screen-space above the camera.

### The parallax arithmetic, exactly

For each plane (`cameraDepthPlaneStyle`, `packages/renderer-browser/src/index.ts`), with `T` the
**camera's** `transform`:

```text
factor       = 1 + clamp(depth, -0.9, 3)          # validate already bounds depth, so factor is 0.1 … 4
translate x  = -T.x * factor
translate y  = -T.y * factor
scale        = clamp(T.scale ** factor, 0.001, 100)   # a POWER of the camera scale, not a product
rotate       = -T.rotation * factor                   # degrees
transform-origin = T.originX/T.originY in px, or `center center` when either is absent
z-index      = the layer's index in document order
```

Depth planes engage only when at least one scene layer declares `depth`. With a camera and no
depth anywhere, all scene layers share **one** wrapper at `translate(-T.x, -T.y) scale(T.scale)
rotate(-T.rotation)` — identical to a plane at `depth: 0`.

**Worked example, measured not derived.** Camera `{ x: 20, y: 0 }`; three 40×40 rects each authored
at `transform.x = 200`; browser lane, 1920×1080:

| depth | factor | predicted screen x | rendered left edge |
|---|---|---|---|
| `0` | 1.0 | 200 − 20×1.0 = **180** | 180 |
| `2` | 3.0 | 200 − 20×3.0 = **140** | 140 |
| `-0.9` | 0.1 | 200 − 20×0.1 = **198** | 198 |

So a background plane at `depth: -0.9` travels a tenth of the camera's distance and a foreground
plane at `depth: 3` travels four times it. To place an object so it is centred at screen `cx` when
the camera is at `T.x`, author `transform.x = cx − w/2 + T.x × (1 + depth)`.

The scale term is a power and it surprises people: with camera `scale: 2`, a plane at `depth: -0.9`
renders at `2 ** 0.1 ≈ 1.072` (a 40 px rect measured 42 px wide), while a plane at `depth: 1`
renders at `2 ** 2 = 4`. A camera scale of exactly 1 removes the term entirely — prefer that unless
you actually want depth-weighted zoom.

## The browser render budget

Every expensive Motion operation runs inside the job governor
(`packages/core/src/job-governor.ts`). It samples the **process-tree RSS** of the processes the job
watches — for a browser render, the whole Chromium tree — and aborts the job the moment a sample
exceeds the ceiling.

Final browser delivery also runs Core's materialised-sequence preflight before it allocates the
full request/result/cache cardinality. Its dry-run and receipt evidence identify the resolved
admission budget and conservative estimate; a refusal means split or simplify the job before
rendering. This is not a frame-streaming encoder path; a bounded producer-to-encoder handoff
remains future work.

One thing is deliberately OUTSIDE it: the tool identity probe behind `shellx-motion doctor` and
`motion.platform.requirements`, which runs `ffmpeg -version` / `chrome --version`. Slot admission is
global and takes no account of what the operation is, so a governed probe would spend one of the
`maxConcurrentJobs` slots below and could starve the renders it is a pre-flight for. It runs
ungoverned instead, bounded by its own 15-second budget
(`SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS`) rather than the ten-minute command timeout — a tool that has
not printed its version in 15 seconds is reported `broken`, not waited on.

| Policy field | Default | Environment override | Clamped to |
|---|---|---|---|
| `maxProcessTreeRssBytes` | adaptive from total/free RAM and concurrency; 6 GiB only without host facts | `SHELLX_MOTION_MAX_JOB_RSS_BYTES` | adaptive 512 MiB … 64 GiB; override 64 MiB … 1024 GiB |
| `rssPollIntervalMs` | 1 000 ms | `SHELLX_MOTION_RSS_POLL_MS` | 25 … 60 000 ms |
| `maxWallClockMs` | 30 min | `SHELLX_MOTION_MAX_JOB_MS` | 100 ms … 24 h |
| `maxConcurrentJobs` | 2 | `SHELLX_MOTION_MAX_CONCURRENT_JOBS` | 1 … 16 |

The ceiling is **per job**, and it is a sampled peak at 1 Hz, not an average. Crossing it raises
`LocalMotionJobError` with `code: "job_rss_limit_exceeded"` and job state `rss_limit_exceeded`.
Through the CLI, that error is written to stdout as a structured JSON failure envelope (`ok: false`,
with `error.code: "job_rss_limit_exceeded"`) and the process exits non-zero. Branch on the error
code and use its suggested action to reduce the job's resource demand before retrying.

### GPU shutter sampling

The strict GPU lane admits fixed rain, water, snow, and fog with 2..8 authored motion-blur samples.
It keeps the four-active-environment ceiling separate from the maximum 32 sample draws, evaluates
every draw at canonical Motion time, and accumulates premultiplied results before one outer layer
composite. Scene and effect-mask textures remain immutable inputs. The frame plan and receipt bind
sample work, retained arena high-water resources, pipeline identity, and cleanup; explicit GPU use
refuses unsupported temporal layer kinds instead of removing their blur.

That retained WebGPU path is distinct from WebGL/browser rendering. Browser process-memory receipts
do not prove GPU throughput or memory behavior; only a fresh native GPU receipt supports a host claim.

### Planning browser-render capacity

A browser render launches Chromium once and reuses a pooled context and page for the sequence
(`browserLaunches: 1` in the receipt's `renderSession`). Plan for the full frame count, and remember
that `effects.motionBlur.samples: N` renders each delivered frame N times. Environment layers,
resolution, other layer kinds, and the host's available capacity also affect resource demand.

When a piece does not fit:

1. **Cut the frame count per job.** Render bounded segments and concatenate them; this also helps
   with the frame/pixel-frame limits in `docs/public/rendering.md`.
2. **Remove or reduce `effects.motionBlur.samples`** where the look permits it.
3. **Reduce overlapping environment layers** where the composition does not need them together.
4. **Lower `environment.quality`** to reduce shader work; measure its effect on peak memory on the
   target host rather than assuming a fixed saving.
5. **Read the adaptive ceiling in `doctor` first.** Motion reserves max(4 GiB, 20% of physical RAM),
   considers current free RAM, and divides the safe pool across concurrent jobs. Raise it with
   `SHELLX_MOTION_MAX_JOB_RSS_BYTES` only as a host-operator decision, never from package/agent data.

Verify rather than assume: every render receipt carries `resources.peakProcessTreeRssBytes` and
`resources.policy.maxProcessTreeRssBytes`. Render a short prefix of the piece, read the ratio, and
scale it against the frame count you actually need.
