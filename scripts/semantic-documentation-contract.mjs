#!/usr/bin/env node
/**
 * Source-driven semantic checks for small claims that otherwise drift silently.
 *
 * Generated-contract checks prove schemas and generated reference pages agree; they cannot prove
 * prose statements about a CLI error path or a missing authoring capability. This gate reads the
 * CLI failure source, layer-type source of truth, and final-render metadata/parser, then asserts
 * only the public, skill, and authored-manual statements that make those facts explicit.
 *
 * Called by `pnpm docs:check`, so a documentation-only change cannot restore either stale claim.
 * It intentionally does not scan every use of "precomp": static Lottie precomposition flattening
 * is a separate, supported import lowering.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RSS_CLI_ASSERTION = "structured JSON failure envelope";
const GROUP_TIMELINE_ASSERTION = "Grouped/precomposed Motion timelines are supported by the strict WebGPU lane";
const NATIVE_FINAL_ASSERTION = 'motion.render.final` accepts frameLane "browser", "native", or strict "gpu"';
const MOTION_VALIDATION_ASSERTION = "a schema pass alone is not a renderability claim";
const STREAMED_FINAL_ASSERTION = "Ordinary file-video final renders use a bounded streamed handoff";
const ENFORCED_UNTRUSTED_ASSERTION = "Linux-only `enforced-untrusted` browser profile is selected only by a direct trusted renderer host";
const ACTIVE_VIDEO_PREVIEW_ASSERTION = "V25-B1 accepted implementation";
const HDR_PUBLIC_BOUNDARY_ASSERTION = "Fenced HDR10 implementation — not a Motion capability.";
const AUTHORED_MANUAL_SOURCE = ["docs", "private", "web", "manual", "build-manual.py"].join("/");

const ASSERTION_MATRIX = [
  {
    path: "docs/public/rendering.md",
    required: [RSS_CLI_ASSERTION, "job_rss_limit_exceeded", "exits non-zero"],
    forbidden: [/stack trace/i, /die without JSON/i, /not wrapped in the usual/i]
  },
  {
    path: "skill/shellx-motion/SKILL.md",
    required: [RSS_CLI_ASSERTION, "job_rss_limit_exceeded", "exits non-zero"],
    forbidden: [/stack trace/i, /die without JSON/i, /not wrapped in the usual/i]
  },
  {
    path: "skill/shellx-motion/references/environments-depth-and-budget.md",
    required: [RSS_CLI_ASSERTION, "job_rss_limit_exceeded", "exits non-zero"],
    forbidden: [/stack trace/i, /die without JSON/i, /not wrapped in the usual/i]
  },
  {
    path: "docs/public/FEATURES.md",
    required: [GROUP_TIMELINE_ASSERTION],
    forbidden: []
  },
  {
    path: "README.md",
    required: [GROUP_TIMELINE_ASSERTION],
    forbidden: [/\bprecomposition\b/i]
  },
  {
    path: "docs/public/FEATURES.md",
    required: [MOTION_VALIDATION_ASSERTION, "Motion document validation"],
    forbidden: []
  },
  {
    path: "docs/public/quickstart.md",
    required: ["validate` runs the ordered structural and runtime-semantic checks", "does not prove a renderer produced an artifact"],
    forbidden: []
  },
  {
    path: "docs/public/rendering.md",
    required: [
      STREAMED_FINAL_ASSERTION,
      "receipt.output.frameTransport",
      "retainedFrameCount: 0",
      "returns the closed `delivery` / `reason` decision",
      "only as that two-field planner decision",
      "receipt.output.frameTransportPlan",
      "resourcePreflight",
      "A streamed attempt never silently",
      "frames after it fails.",
      "Durable segmented final video",
      '`delivery: "resumable-ffv1-segments"`,',
      "checkpoint store from the absolute output path"
    ],
    forbidden: [/encoder still starts after the sequence has been produced/i]
  },
  {
    path: "docs/public/FEATURES.md",
    required: ["Ordinary file-video final rendering", "materialisation remains deliberate"],
    forbidden: [/It does not stream frames to FFmpeg\./]
  },
  {
    path: "docs/public/receipts-and-trust.md",
    required: [
      "two-field",
      "`delivery` / `reason` planner decision",
      "receipt.output.frameTransport",
      "retainedFrameCount: 0",
      "encoder-handoff evidence",
      "receipt.output.frameTransportPlan",
      "resourcePreflight"
    ],
    forbidden: []
  },
  {
    path: "docs/public/DEBUG_API.md",
    required: ["Neither the Debug API nor MCP exposes `untrustedExecution`.", "FFmpeg/FFprobe containment, seccomp, or Windows/macOS equivalence"],
    forbidden: []
  },
  {
    path: "packages/sdk/README.md",
    required: ["`untrustedExecution` is also deliberately absent from every SDK request and transport.", ENFORCED_UNTRUSTED_ASSERTION],
    forbidden: []
  },
  {
    path: "skill/shellx-motion/references/cli.md",
    required: ["`--untrusted-execution` is intentionally not a CLI option.", ENFORCED_UNTRUSTED_ASSERTION],
    forbidden: []
  },
  {
    path: "docs/public/FEATURES.md",
    required: [ACTIVE_VIDEO_PREVIEW_ASSERTION, "host-owned provider", "32 entries / 128 MiB", "64 MiB", "audio-not-rasterized", "final-not-attested", "Native Linux RTX 5080 rig scrub", "RTX 5080", "40b965bb69b02c2bcfc0b0972beaca2a07e4defa"],
    forbidden: [/active video remains final-streaming-only/i]
  },
  {
    path: "docs/public/rendering.md",
    required: [ACTIVE_VIDEO_PREVIEW_ASSERTION, "host-owned provider", "integer microsecond", "32", "128 MiB", "64 MiB", "output.gpuVideoPreview", "qualified Linux RTX 5080 rig's native scrub", "RTX", "40b965bb69b02c2bcfc0b0972beaca2a07e4defa", "does not alter the existing GPU final delivery path"],
    forbidden: [/preview deliberately refuses active video/i]
  },
  {
    path: "docs/public/receipts-and-trust.md",
    required: ["shellx-motion/gpu-preview-video-evidence@1", "preview-visual-only", "32 entries / 128 MiB", "audio-not-rasterized", "final-not-attested"],
    forbidden: []
  },
  {
    path: "skill/shellx-motion/SKILL.md",
    required: [ACTIVE_VIDEO_PREVIEW_ASSERTION, "host-owned CFR provider", "32 entries / 128 MiB", "Linux RTX 5080 rig scrub"],
    forbidden: [/preview refuses active video/i]
  },
  {
    path: "skill/shellx-motion/references/cli.md",
    required: [ACTIVE_VIDEO_PREVIEW_ASSERTION, "host-owned visual-only CFR provider", "32 entries / 128 MiB", "qualified Linux RTX 5080 rig", "40b965bb69b02c2bcfc0b0972beaca2a07e4defa", "frameLane: \"browser\" | \"native\" | \"gpu\""],
    forbidden: [/active video refuses in GPU preview/i]
  },
  ...(existsSync(resolve(ROOT, AUTHORED_MANUAL_SOURCE))
    ? [{
        path: AUTHORED_MANUAL_SOURCE,
        required: [NATIVE_FINAL_ASSERTION],
        requiredCounts: [{ text: RSS_CLI_ASSERTION, minimum: 2 }],
        forbidden: [/stack trace/i, /not a JSON error envelope/i, /frameLane \\"browser\\" only/]
      }]
    : [])
];

const failures = [];
assertCliFailureAuthority();
assertLayerCapabilityAuthority();
assertFinalFrameLaneAuthority();
assertMotionValidationAuthority();
assertStreamingFinalAuthority();
assertEnforcedUntrustedAuthority();
assertActiveVideoPreviewAuthority();
assertHdrPublicBoundary();
assertPublishedSurfaceCounts();
for (const assertion of ASSERTION_MATRIX) assertDocumentation(assertion);

if (failures.length > 0) {
  console.error(`Semantic documentation contract failed (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`semantic-documentation-contract: OK — ${ASSERTION_MATRIX.length} source-backed documentation assertions checked.`);
}

function assertCliFailureAuthority() {
  const failureMapper = read("packages/cli/src/unhandled-failure.ts");
  for (const statement of [
    "export function unhandledFailure(error: unknown)",
    "error instanceof LocalMotionJobError ? error.code : \"internal_error\"",
    "ok: false",
    "code === \"job_rss_limit_exceeded\""
  ]) {
    if (!failureMapper.includes(statement)) {
      failures.push(`packages/cli/src/unhandled-failure.ts no longer proves the structured job_rss_limit_exceeded failure envelope: ${statement}`);
    }
  }

  const entry = read("packages/cli/src/main.ts");
  for (const statement of [
    "result = unhandledFailure(error);",
    "console.log(JSON.stringify(result));",
    "if (!result.ok) process.exitCode = 1;"
  ]) {
    if (!entry.includes(statement)) {
      failures.push(`packages/cli/src/main.ts no longer proves escaped failures are JSON with a non-zero exit: ${statement}`);
    }
  }
}

function assertLayerCapabilityAuthority() {
  const types = read("packages/core/src/types.ts");
  const declaration = types.match(/export type MotionLayerType\s*=([\s\S]*?);/);
  if (!declaration) {
    failures.push("packages/core/src/types.ts no longer exposes MotionLayerType for the grouped/precomposed capability assertion.");
  } else if (!/\|\s*"group"/.test(declaration[1])) {
    failures.push("MotionLayerType no longer includes group; the grouped/precomposed GPU capability claim is stale.");
  }

  const gpuCard = read("packages/core/src/gpu-capability-card.ts");
  if (!/layerTypes:\s*\[[^\]]*"group"/.test(gpuCard)) {
    failures.push("packages/core/src/gpu-capability-card.ts no longer advertises group layers; the grouped/precomposed documentation claim is stale.");
  }

  const capabilities = read("packages/core/src/capabilities.ts");
  if (!capabilities.includes("RENDERER_CAPABILITY_CARDS.flatMap((card) => card.layerTypes)")) {
    failures.push("renderableLayerTypes() no longer derives from renderer capability cards; update this semantic authority check.");
  }
}

function assertFinalFrameLaneAuthority() {
  const metadata = read("packages/debug-api/src/command-metadata-render.ts");
  const finalMetadata = metadata.slice(metadata.indexOf('"motion.render.final":'));
  const frameLane = finalMetadata.match(/frameLane:\s*\{[^}]*\benum:\s*\[([^\]]*)\]/);
  if (!frameLane) {
    failures.push("packages/debug-api/src/command-metadata-render.ts no longer exposes the motion.render.final frameLane enum.");
  } else {
    const values = [...frameLane[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    const expected = ["browser", "native", "gpu"];
    if (values.length !== expected.length || values.some((value, index) => value !== expected[index])) {
      failures.push(`motion.render.final frameLane metadata must be exactly ${JSON.stringify(expected)} (found ${JSON.stringify(values)}); revise the native-final documentation assertion.`);
    }
  }

  const parser = read("packages/debug-api/src/domains/render-final.ts");
  for (const statement of [
    'frameLane: "browser" | "native" | "gpu";',
    'if (frameLaneValue !== "browser" && frameLaneValue !== "native" && frameLaneValue !== "gpu") {',
    'if (frameLane === "native" && (workflowArg || workflowPath)) {',
    'return invalidArgs("Browser workflows require frameLane browser; native final rendering never falls back to browser.");',
    'if (frameLane === "gpu" && (workflowArg || workflowPath)) {',
    'return invalidArgs("GPU final rendering does not support browser workflows; it never falls back to browser materialization.");'
  ]) {
    if (!parser.includes(statement)) {
      failures.push(`packages/debug-api/src/domains/render-final.ts no longer proves bounded native final rendering and browser-workflow refusal: ${statement}`);
    }
  }
}

function assertMotionValidationAuthority() {
  const contract = read("packages/core/src/motion-validation-contract.ts");
  const runtime = read("packages/core/src/motion-validation.ts");
  for (const statement of [
    'export const MOTION_VALIDATION_CONTRACT = "shellx-motion/motion-validation@1"',
    'export const MOTION_VALIDATION_STAGE_ORDER = ["structural", "semantic"]',
    'renderability: "not_proven"'
  ]) {
    if (!contract.includes(statement)) {
      failures.push(`packages/core/src/motion-validation-contract.ts no longer proves the public two-stage validation vocabulary: ${statement}`);
    }
  }
  for (const statement of [
    "const structuralErrors = validateAgainstPublishedSchema(structuralSchema, document);",
    'return { ok: false, stage: "structural"',
    'const semantic = await validateDocument(await loadSchema("motion"), document);'
  ]) {
    if (!runtime.includes(statement)) {
      failures.push(`packages/core/src/motion-validation.ts no longer proves structural-before-semantic validation: ${statement}`);
    }
  }
}

function assertActiveVideoPreviewAuthority() {
  const core = read("packages/core/src/gpu-video-frame-request.ts");
  for (const statement of [
    'export const GPU_VIDEO_FRAME_REQUEST_SCHEMA = "shellx-motion/gpu-video-frame-request@1"',
    "export function gpuVideoTimelineAtUs(atMs: number)",
    "const atUs = Math.round(atMs * 1_000);",
    "GPU video preview accepts at most ${GPU_MAX_VISIBLE_VIDEO_SOURCES} visible video layers."
  ]) {
    if (!core.includes(statement)) {
      failures.push(`packages/core/src/gpu-video-frame-request.ts no longer proves the documented Core-owned exact-time video request: ${statement}`);
    }
  }

  const cache = read("packages/renderer-ffmpeg/src/gpu-video-preview-provider-primitives.ts");
  for (const statement of [
    "MAX_GPU_PREVIEW_VIDEO_CACHE_ENTRIES = 32",
    "MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES = 128 * 1024 * 1024",
    "MAX_GPU_PREVIEW_VIDEO_IN_FLIGHT_RGBA_BYTES = 64 * 1024 * 1024",
    'selection: "cfr-floor-request-sourceAtUs-to-stream-pts"'
  ]) {
    if (!cache.includes(statement)) {
      failures.push(`packages/renderer-ffmpeg/src/gpu-video-preview-provider-primitives.ts no longer proves the documented bounded CFR preview provider: ${statement}`);
    }
  }

  const evidence = read("packages/renderer-browser/src/gpu-preview-video-orchestration.ts");
  for (const statement of [
    'schema: "shellx-motion/gpu-preview-video-evidence@1"',
    'scope: "preview-visual-only"',
    "cache.capacityEntries !== 32",
    "cache.capacityBytes !== 128 * 1024 * 1024",
    "cache.inFlightHighWaterBytes > 64 * 1024 * 1024",
    'limitations: Object.freeze(["audio-not-rasterized", "final-not-attested"] as const)'
  ]) {
    if (!evidence.includes(statement)) {
      failures.push(`packages/renderer-browser/src/gpu-preview-video-orchestration.ts no longer proves the documented preview receipt boundary: ${statement}`);
    }
  }

  const metadata = read("packages/debug-api/src/command-metadata-core.ts");
  if (!metadata.includes("provider controls are never command arguments")) {
    failures.push("packages/debug-api/src/command-metadata-core.ts no longer states that active-video preview provider controls stay host-owned.");
  }
}

function assertStreamingFinalAuthority() {
  const transport = read("packages/renderer-ffmpeg/src/final-video-frame-transport.ts");
  for (const statement of [
    'return { delivery: "streamed", reason: "stream_default" };',
    'if (input.keepFrames === true) return { delivery: "materialized", reason: "explicit_frame_retention" };',
    'if (input.capturedBrowserWorkflow === true) return { delivery: "materialized", reason: "captured_browser_workflow" };',
    'if (input.exactSourceQuality === true) return { delivery: "materialized", reason: "exact_source_quality" };',
    'return { delivery: "materialized", reason: "streaming_quality_capacity" };',
    'if (input.injectedFrameRenderer === true) return { delivery: "materialized", reason: "injected_frame_renderer" };'
  ]) {
    if (!transport.includes(statement)) {
      failures.push(`packages/renderer-ffmpeg/src/final-video-frame-transport.ts no longer proves the documented pre-execution transport decision: ${statement}`);
    }
  }

  const commandPlan = read("packages/renderer-ffmpeg/src/streaming-final-command-plan.ts");
  for (const statement of [
    "* or touching the filesystem. It is the dry-run companion to {@link renderStreamingFinal}.",
    'if (transport.plan.delivery === "materialized") {',
    'code: "frame_transport_materialized_required"'
  ]) {
    if (!commandPlan.includes(statement)) {
      failures.push(`packages/renderer-ffmpeg/src/streaming-final-command-plan.ts no longer proves dry-run transport planning: ${statement}`);
    }
  }

  const adapter = read("packages/renderer-ffmpeg/src/streaming-final-adapter-execution.ts");
  for (const statement of [
    'delivery: "streamed",',
    "retainedFrameCount: 0,",
    "frameTransport"
  ]) {
    if (!adapter.includes(statement)) {
      failures.push(`packages/renderer-ffmpeg/src/streaming-final-adapter-execution.ts no longer proves the streamed receipt transport assertion: ${statement}`);
    }
  }

  const segmented = read("packages/renderer-ffmpeg/src/segmented-final.ts");
  for (const statement of [
    'export async function renderSegmentedFinal',
    'store: { location: "derived-from-output"',
    'createRangeProducer: createSegmentedRangeProducer(input)'
  ]) {
    if (!segmented.includes(statement)) {
      failures.push(`packages/renderer-ffmpeg/src/segmented-final.ts no longer proves the closed durable segmented delivery contract: ${statement}`);
    }
  }
  const segmentedProducers = read("packages/renderer-ffmpeg/src/segmented-final-producers.ts");
  for (const statement of [
    'export function createSegmentedRangeProducer',
    'Segmented final delivery does not support captured browser workflows.'
  ]) {
    if (!segmentedProducers.includes(statement)) {
      failures.push(`packages/renderer-ffmpeg/src/segmented-final-producers.ts no longer proves the closed durable segmented producer contract: ${statement}`);
    }
  }
}

function assertEnforcedUntrustedAuthority() {
  const browser = read("packages/renderer-browser/src/index.ts");
  if (!browser.includes('untrustedExecution?: typeof ENFORCED_UNTRUSTED_BROWSER_EXECUTION;')) {
    failures.push("packages/renderer-browser/src/index.ts no longer keeps the enforced-untrusted renderer-host admission option private.");
  }
  const ownedBrowserLaunch = read("packages/renderer-browser/src/browser-owned-session-launch.ts");
  for (const statement of [
    'await assertEnforcedUntrustedBrowserDefaultLaunch(input.launchBrowser);',
    '...(input.enforcedUntrustedExecution ? { chromiumSandbox: true } : {})',
    'env: untrustedLaunch?.env ?? childEnvironment()'
  ]) {
    if (!ownedBrowserLaunch.includes(statement)) {
      failures.push(`packages/renderer-browser/src/browser-owned-session-launch.ts no longer proves the enforced-untrusted renderer-host admission boundary: ${statement}`);
    }
  }

  const debugSchema = read("schemas/debug.json");
  if (debugSchema.includes('"untrustedExecution"')) {
    failures.push("schemas/debug.json must not publish the renderer-host-only untrustedExecution option.");
  }

  const sdkTypes = read("packages/sdk/src/types.ts");
  const renderRequest = sdkTypes.match(/export interface MotionSdkRenderRequest \{([\s\S]*?)\n\}/);
  if (!renderRequest || /\buntrustedExecution\b/.test(renderRequest[1])) {
    failures.push("packages/sdk/src/types.ts must keep untrustedExecution out of MotionSdkRenderRequest.");
  }

  const cli = read("packages/cli/src/main.ts");
  if (!cli.includes('Unsupported preview option: ${unsupportedOption}. Use --at-ms for the capture time.')) {
    failures.push("packages/cli/src/main.ts no longer proves that unknown preview options are rejected before a renderer starts.");
  }
}

/**
 * HDR10 code is retained only as a fenced implementation vertical. The absence is deliberate:
 * generic final routes refuse the marker, while no public command, Action, SDK, document field,
 * or integration capability admits it. Keep the public statement and those machine contracts in
 * one check so an internal import cannot silently become a public feature claim.
 */
function assertHdrPublicBoundary() {
  const features = read("docs/public/FEATURES.md");
  const rendering = read("docs/public/rendering.md");
  if (!features.includes(HDR_PUBLIC_BOUNDARY_ASSERTION)) {
    failures.push(`docs/public/FEATURES.md must state the HDR public boundary: ${JSON.stringify(HDR_PUBLIC_BOUNDARY_ASSERTION)}`);
  }
  for (const statement of [
    "not a public renderer lane or product capability.",
    "no\ndeclared Motion-document field",
    "local SDK operation,\nAction, integration capability, connector, or host route.",
    "no HDR operation or field."
  ]) {
    if (!rendering.includes(statement)) {
      failures.push(`docs/public/rendering.md must state the HDR public boundary: ${JSON.stringify(statement)}`);
    }
  }

  // These three files are the published machine contracts. An HDR word here would advertise an
  // operation or document field, and a new public surface must be reviewed as a capability change.
  for (const path of ["schemas/motion.schema.json", "schemas/debug.json", "schemas/actions.json"]) {
    if (/hdr/i.test(read(path))) failures.push(`${path} must not publish an HDR document field, command, or Action while HDR remains fenced.`);
  }

  const publicBarrels = [
    "packages/core/src/index.ts",
    "packages/renderer-browser/src/index.ts",
    "packages/renderer-ffmpeg/src/index.ts",
    "packages/sdk/src/index.ts"
  ];
  for (const path of publicBarrels) {
    if (/hdr/i.test(read(path))) failures.push(`${path} must not expose the fenced HDR implementation from a public package barrel.`);
  }

  const integration = read("packages/core/src/integration-protocol.ts");
  if (/hdr/i.test(integration)) failures.push("packages/core/src/integration-protocol.ts must not advertise HDR through integration capabilities while the route is fenced.");

  const genericFinal = read("packages/renderer-ffmpeg/src/streaming-final-adapter.ts");
  for (const statement of [
    'import { hasScene3dGltfPbrHdr10FinalLocator } from "@shellx-motion/core/internal/scene3d-gltf-pbr-hdr10-final";',
    "if (hasScene3dGltfPbrHdr10FinalLocator(input.pkg.manifest.data)) {",
    'code: "gltf_pbr_hdr10_private_direct_final_only"',
    "refuses every generic final route before output publication"
  ]) {
    if (!genericFinal.includes(statement)) {
      failures.push(`packages/renderer-ffmpeg/src/streaming-final-adapter.ts no longer proves the HDR generic-final refusal: ${statement}`);
    }
  }

  // Source exports keep TypeScript workspace tests working. publishConfig is the installed-package
  // contract: only the Core marker reader and Browser streaming producer are required by a shipping
  // workspace consumer; the session and direct-final helpers are intentionally not installed APIs.
  const coreManifest = JSON.parse(read("packages/core/package.json"));
  const browserManifest = JSON.parse(read("packages/renderer-browser/package.json"));
  const ffmpegManifest = JSON.parse(read("packages/renderer-ffmpeg/package.json"));
  const expectExport = (manifest, subpath, installed) => {
    if (!Object.hasOwn(manifest.exports ?? {}, subpath)) {
      failures.push(`${manifest.name} must retain the fenced HDR source export ${subpath} until the implementation is deliberately removed.`);
    }
    const actualInstalled = Object.hasOwn(manifest.publishConfig?.exports ?? {}, subpath);
    if (actualInstalled !== installed) {
      failures.push(`${manifest.name} installed HDR export ${subpath} must be ${installed ? "present for a shipping internal consumer" : "absent as a non-public helper"}.`);
    }
  };
  expectExport(coreManifest, "./internal/scene3d-gltf-pbr-hdr10-final", true);
  expectExport(browserManifest, "./internal/scene3d-gltf-pbr-hdr10", false);
  expectExport(browserManifest, "./internal/scene3d-gltf-pbr-hdr10-streaming", true);
  expectExport(ffmpegManifest, "./internal/scene3d-gltf-pbr-hdr10-direct-final", false);
  expectExport(ffmpegManifest, "./internal/scene3d-gltf-pbr-hdr10-direct-final-verifier", false);
}

function assertPublishedSurfaceCounts() {
  const debugSchema = JSON.parse(read("schemas/debug.json"));
  const actionsSchema = JSON.parse(read("schemas/actions.json"));
  const debugCommands = Array.isArray(debugSchema.commands) ? debugSchema.commands.length : -1;
  const actions = Array.isArray(actionsSchema.actions) ? actionsSchema.actions.length : -1;
  if (debugSchema.commandCount !== debugCommands) {
    failures.push(`schemas/debug.json commandCount ${debugSchema.commandCount} does not match ${debugCommands} commands.`);
  }
  if (actionsSchema.actionCount !== actions) {
    failures.push(`schemas/actions.json actionCount ${actionsSchema.actionCount} does not match ${actions} actions.`);
  }

  const readme = read("README.md");
  const requiredMatrixClaims = [
    `**${debugCommands}** typed commands; MCP exposes the full registry.`,
    `**${actions} discoverable actions**.`
  ];
  for (const claim of requiredMatrixClaims) {
    if (!readme.includes(claim)) {
      failures.push(`README.md must publish the source-backed surface-matrix claim: ${claim}`);
    }
  }
}

function assertDocumentation(assertion) {
  const source = read(assertion.path);
  for (const required of assertion.required) {
    if (!source.includes(required)) failures.push(`${assertion.path} must state: ${JSON.stringify(required)}`);
  }
  for (const { text, minimum } of assertion.requiredCounts ?? []) {
    const count = source.split(text).length - 1;
    if (count < minimum) {
      failures.push(`${assertion.path} must state ${JSON.stringify(text)} at least ${minimum} times (found ${count}).`);
    }
  }
  for (const forbidden of assertion.forbidden) {
    if (forbidden.test(source)) failures.push(`${assertion.path} still contains a retired claim matching ${forbidden}.`);
  }
}

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}
