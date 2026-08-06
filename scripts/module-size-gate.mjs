/**
 * Prevent parity work from accumulating in known orchestration hotspots.
 * New domain modules use a strict cap; legacy files use non-growth baselines
 * until their behavior can be extracted safely in later slices.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const limits = new Map([
  // New keying domain modules use strict caps.
  ["packages/core/src/keying.ts", 350],
  ["packages/core/src/keying.test.ts", 600],
  ["packages/core/src/keying-authoring.ts", 350],
  ["packages/core/src/keying-authoring.test.ts", 600],
  ["packages/debug-api/src/domains/authoring-keying.ts", 350],
  ["packages/debug-api/src/domains/authoring-keying.test.ts", 600],
  ["packages/debug-api/src/command-metadata-keying.ts", 350],
  ["packages/debug-api/src/command-metadata-tracking.ts", 350],
  ["packages/debug-api/src/command-metadata-scene3d.ts", 350],
  // Argument-contract modules: strict caps so the sweep does not re-collect in one file.
  ["packages/debug-api/src/command-metadata.ts", 200],
  ["packages/debug-api/src/command-metadata.test.ts", 600],
  ["packages/debug-api/src/command-metadata-enums.ts", 350],
  ["packages/debug-api/src/command-metadata-shared.ts", 200],
  ["packages/debug-api/src/command-metadata-surfaces.ts", 350],
  ["packages/debug-api/src/command-metadata-timeline-layers.ts", 350],
  ["packages/debug-api/src/command-metadata-timeline-keyframes.ts", 350],
  ["packages/debug-api/src/command-metadata-timeline-structure.ts", 350],
  ["packages/debug-api/src/command-metadata-timeline-tracks.ts", 350],
  ["packages/debug-api/src/domains/agent-plan-arguments.ts", 200],
  ["packages/debug-api/src/domains/enum-error.ts", 200],
  ["packages/debug-api/src/domains/authoring-gltf.ts", 350],
  ["packages/debug-api/src/domains/authoring-gltf.test.ts", 600],
  ["packages/actions/src/catalog-media-effects.ts", 350],
  ["packages/actions/src/catalog-media-effects.test.ts", 600],
  ["packages/actions/src/catalog-compositing.ts", 350],
  ["packages/actions/src/catalog-compositing.test.ts", 600],
  ["packages/actions/src/catalog-modular.ts", 350],
  ["packages/actions/src/catalog-surface-commands.ts", 200],
  ["packages/actions/src/catalog-scene3d.ts", 350],
  ["packages/actions/src/catalog-scene3d.test.ts", 600],
  ["packages/sdk/src/keying-types.ts", 350],
  ["packages/sdk/src/keying-client.ts", 350],
  ["packages/sdk/src/tracking-client.ts", 350],
  ["packages/sdk/src/local-keying.ts", 350],
  ["packages/sdk/src/local-receipt.ts", 350],
  ["packages/sdk/src/local-receipt.test.ts", 600],
  ["packages/sdk/src/local-keying.test.ts", 600],
  ["packages/sdk/src/tracking-types.ts", 350],
  ["packages/debug-server/src/sdk-operation-policy.ts", 350],
  ["packages/debug-server/src/sdk-operation-policy.test.ts", 600],
  ["packages/debug-server/src/procedural-sdk-http.test.ts", 600],
  ["packages/debug-server/src/sdk-local-options.ts", 350],
  ["packages/debug-server/src/workbench-image.ts", 350],
  ["packages/debug-server/src/websocket-frame.ts", 200],
  ["packages/compositing-keying/src/keyer.ts", 350],
  ["packages/compositing-keying/src/keyer.test.ts", 600],
  ["packages/compositing-keying/src/matte.ts", 350],
  ["packages/compositing-keying/src/matte.test.ts", 600],
  ["packages/compositing-keying/src/browser-runtime.ts", 350],
  ["packages/renderer-browser/src/generated-keying.ts", 350],
  ["packages/renderer-browser/src/generated-vector-masks.ts", 350],
  ["packages/renderer-browser/src/browser-package-safety.ts", 350],
  ["packages/renderer-browser/src/render-compositing.ts", 350],
  ["packages/renderer-browser/src/compositing-equivalence.test.ts", 600],
  ["packages/renderer-browser/src/generated-scene3d.ts", 350],
  ["packages/renderer-browser/src/generated-value-guards.ts", 350],
  ["packages/renderer-browser/src/scene3d-runtime-script.ts", 350],
  ["packages/renderer-browser/src/gltf-render.test.ts", 600],
  ["packages/renderer-browser/src/test-support/png-fixture.ts", 350],
  ["packages/renderer-browser/src/keying-render.test.ts", 600],
  ["packages/renderer-browser/src/index.fixtures-text.ts", 450],
  // dotLottie container concerns stay isolated before broader fidelity lands.
  ["packages/core/src/dotlottie.ts", 350],
  ["packages/core/src/dotlottie-types.ts", 350],
  ["packages/core/src/dotlottie-json.ts", 350],
  ["packages/core/src/dotlottie-zip.ts", 350],
  ["packages/core/src/dotlottie-manifest.ts", 350],
  ["packages/core/src/dotlottie-assets.ts", 350],
  ["packages/core/src/dotlottie-resources.ts", 350],
  ["packages/core/src/dotlottie-lowering.ts", 350],
  ["packages/core/src/dotlottie-lowering.test.ts", 600],
  ["packages/core/src/dotlottie-theme.ts", 350],
  ["packages/core/src/dotlottie-theme.test.ts", 600],
  ["packages/core/src/lottie-precomp.ts", 350],
  ["packages/core/src/lottie-precomp.test.ts", 600],
  ["packages/core/src/lottie-json.ts", 350],
  ["packages/core/src/dotlottie.test.ts", 600],
  ["packages/core/src/lottie-lowering-assets.ts", 350],
  ["packages/core/src/spatial-path-types.ts", 350],
  ["packages/core/src/spatial-path.ts", 350],
  ["packages/core/src/spatial-path.test.ts", 600],
  ["packages/core/src/spatial-arc-length.ts", 350],
  ["packages/core/src/spatial-arc-length.test.ts", 600],
  ["packages/core/src/compositing-graph-types.ts", 350],
  ["packages/core/src/compositing-graph-safety.ts", 350],
  ["packages/core/src/compositing-graph-node-validate.ts", 350],
  ["packages/core/src/compositing-graph-matte-validate.ts", 350],
  ["packages/core/src/compositing-graph-topology.ts", 350],
  ["packages/core/src/compositing-graph-validate.ts", 350],
  ["packages/core/src/compositing-graph-compile.ts", 350],
  ["packages/core/src/compositing-graph.test.ts", 600],
  ["packages/core/src/motion-matte-validate.ts", 350],
  ["packages/core/src/layer-capability-features.ts", 350],
  ["packages/core/src/scene-3d.ts", 350],
  ["packages/core/src/scene-3d-types.ts", 350],
  ["packages/core/src/scene-3d-validate.ts", 350],
  ["packages/core/src/scene-3d-capabilities.test.ts", 600],
  ["packages/core/src/gltf-types.ts", 350],
  ["packages/core/src/gltf-read.ts", 350],
  ["packages/core/src/gltf-math.ts", 350],
  ["packages/core/src/gltf-container.ts", 350],
  ["packages/core/src/gltf-accessor.ts", 350],
  ["packages/core/src/gltf-preflight.ts", 350],
  ["packages/core/src/gltf-diagnostics.ts", 350],
  ["packages/core/src/gltf-lowering.ts", 350],
  ["packages/core/src/gltf-lowering.test.ts", 600],
  ["packages/core/src/package-render-lineage.ts", 350],
  ["packages/core/src/package-render-lineage.test.ts", 600],
  ["packages/core/src/environment-types.ts", 350],
  ["packages/core/src/procedural-relationship-types.ts", 350],
  ["packages/core/src/procedural-relationship-node.ts", 350],
  ["packages/core/src/procedural-relationship-topology.ts", 350],
  ["packages/core/src/procedural-relationship-validate.ts", 350],
  ["packages/core/src/procedural-relationship-evaluate.ts", 350],
  ["packages/core/src/procedural-relationship-bake.ts", 350],
  ["packages/core/src/procedural-relationship-authoring.ts", 350],
  ["packages/core/src/procedural-relationship-fingerprint.ts", 350],
  ["packages/core/src/procedural-relationship.test.ts", 600],
  ["packages/core/src/motion-document-graphs.ts", 350],
  ["packages/core/src/template-types.ts", 350],
  ["packages/core/src/capability-cards.ts", 400],
  ["packages/core/src/validate-schemas.ts", 200],
  ["packages/core/src/timeline-presets.ts", 350],
  // Motion-density measurement: new domain modules, strict caps from day one. The pixel maths and
  // the author-facing text are separate modules precisely so each stays inside the cap. The main
  // module gets 400 (as capability-cards.ts does) because ~60 lines of it are the doc block
  // recording WHY the metric mirrors ffmpeg freezedetect and where it deliberately differs —
  // rationale a future reader cannot reconstruct from the code. Split it further if it passes 400.
  ["packages/core/src/motion-density.ts", 400],
  ["packages/core/src/motion-density-planes.ts", 350],
  ["packages/core/src/motion-density-warnings.ts", 350],
  ["packages/core/src/motion-density.test.ts", 600],
  ["packages/debug-api/src/timeline-keyframes-panel.test.ts", 600],
  ["packages/core/src/timeline-track-audio.test.ts", 600],
  ["packages/core/src/index.ts", 350],
  ["packages/renderer-browser/src/procedural-layers.ts", 350],
  ["packages/renderer-native/src/procedural-render.test.ts", 600],
  ["packages/renderer-native/src/native-png.ts", 350],
  ["packages/debug-api/src/domains/authoring-compositing-graph.ts", 350],
  ["packages/debug-api/src/domains/authoring-compositing-graph.test.ts", 600],
  ["packages/debug-api/src/domains/authoring-procedural.ts", 350],
  ["packages/debug-api/src/domains/authoring-procedural.test.ts", 600],
  ["packages/debug-api/src/domains/authoring-root-policy.ts", 350],
  ["packages/debug-api/src/command-metadata-compositing.ts", 350],
  ["packages/debug-api/src/command-registry.ts", 350],
  ["packages/debug-api/src/command-registry.test.ts", 600],
  ["packages/debug-api/src/domains/authoring.ts", 350],
  ["packages/debug-api/src/domains/authoring-dotlottie-package.ts", 350],
  ["packages/debug-api/src/domains/authoring-dotlottie-package.test.ts", 600],
  ["packages/debug-api/src/domains/authoring-lottie-package.ts", 350],
  ["packages/debug-api/src/domains/authoring-lottie-package.test.ts", 600],
  ["packages/debug-api/src/domains/authoring-gltf-package.ts", 350],
  ["packages/debug-api/src/domains/authoring-gltf-package.test.ts", 600],
  ["packages/debug-api/src/authoring-package-api.ts", 350],
  ["packages/debug-api/src/domains/timeline-spatial-path.ts", 350],
  ["packages/sdk/src/timeline-edit-types.ts", 350],
  ["packages/sdk/src/package-types.ts", 350],
  ["packages/sdk/src/compositing-types.ts", 350],
  ["packages/sdk/src/compositing-client.ts", 350],
  ["packages/sdk/src/gltf-types.ts", 350],
  ["packages/sdk/src/gltf-client.ts", 350],
  ["packages/sdk/src/gltf-client.test.ts", 600],
  ["packages/sdk/src/procedural-types.ts", 350],
  ["packages/sdk/src/procedural-client.ts", 350],
  ["packages/sdk/src/procedural-client.test.ts", 600],
  ["packages/sdk/src/local-procedural.ts", 350],
  ["packages/sdk/src/local-procedural.test.ts", 600],
  ["packages/sdk/src/local-authoring.ts", 350],
  ["packages/sdk/src/authoring-client-bindings.ts", 350],
  ["packages/sdk/src/authoring-client-validation.ts", 350],
  ["packages/sdk/src/authoring-types.ts", 350],
  ["packages/sdk/src/client-operation-fields.ts", 350],
  ["packages/sdk/src/local-gltf.ts", 350],
  ["packages/sdk/src/local-gltf.test.ts", 600],
  ["packages/sdk/src/local-cut-handoff.ts", 350],
  ["packages/sdk/src/local-cut-handoff.test.ts", 600],
  ["packages/sdk/src/local-render-lineage.ts", 350],
  ["packages/sdk/src/local-render-lineage.test.ts", 600],
  ["packages/sdk/src/local-package.test.ts", 600],
  ["packages/sdk/src/render-client-guards.test.ts", 600],
  ["packages/sdk/src/local-result.ts", 350],
  ["packages/sdk/src/render-client-guards.ts", 350],
  ["packages/sdk/src/timeline-receipt.ts", 350],
  ["packages/sdk/src/local-compositing.ts", 350],
  ["packages/sdk/src/local-compositing.test.ts", 600],
  ["packages/sdk/src/sdk.test.ts", 600],
  ["packages/sdk/src/spatial-timeline-normalize.ts", 350],
  ["packages/sdk/src/spatial-timeline.test.ts", 600],
  ["packages/cli/src/spatial-path-cli.ts", 350],
  ["packages/cli/src/spatial-path-cli.test.ts", 600],
  ["packages/cli/src/compositing-graph-cli.ts", 350],
  ["packages/cli/src/compositing-graph-cli.test.ts", 600],
  ["packages/cli/src/procedural-cli.ts", 350],
  ["packages/cli/src/procedural-cli.test.ts", 600],
  ["packages/cli/src/modular-debug-cli.ts", 350],
  ["packages/cli/src/gltf-cli.ts", 350],
  ["packages/cli/src/gltf-cli.test.ts", 600],
  ["packages/cli/src/debug-context-cli.ts", 350],
  ["packages/cli/src/help-command.ts", 200],
  ["packages/cli/src/browser-workflow-decode.ts", 200],
  ["packages/cli/src/output-dir-guard.ts", 350],
  ["packages/cli/src/entry-point.ts", 100],
  ["packages/cli/src/retired-options.ts", 100],
  ["packages/cli/src/main.test-support.ts", 500],
  ["packages/cli/src/main.fixtures-packages.ts", 550],
  ["packages/cli/src/main.fixtures-batch.ts", 350],
  ["packages/connectors/src/scene3d-cut-handoff.test.ts", 600],
  ["packages/agent-runtime/src/antigravity.ts", 350],
  ["packages/agent-runtime/src/antigravity.test.ts", 600],
  ["packages/actions/src/catalog-procedural.ts", 350],
  ["packages/actions/src/catalog-procedural.test.ts", 600],
  ["skill/shellx-motion/SKILL.md", 350],
  ["scripts/template-host-parity-gate.ts", 350],
  // Raised 450 -> 500 deliberately : the file grew because the engine gained real
  // callable surface (Lottie/dotLottie import), not because it accumulated prose. A reference that
  // omits a shipping command to stay short is the wrong trade. Split it if it passes 500.
  ["skill/shellx-motion/references/cli.md", 500],
  // Readiness + provenance modules: strict caps so the shared
  // requirements answer and the frame-lane handoff cannot re-accumulate into their host files.
  ["packages/renderer-ffmpeg/src/platform-requirements.ts", 350],
  ["packages/renderer-ffmpeg/src/platform-requirements.test.ts", 600],
  // What may appear in a report a third-party binary supplied the text for. Extracted from
  // platform-requirements.ts so the redaction rule has one home instead of being re-derived by the
  // next field someone adds; capped for the same reason.
  ["packages/renderer-ffmpeg/src/report-redaction.ts", 200],
  // The operation/route model, extracted from platform-requirements.ts when `render.final` gained a
  // lane-dependent Chromium requirement. Strict cap so the readiness answer does not re-collect in
  // one file the next time a tool or an operation is added.
  ["packages/renderer-ffmpeg/src/platform-operations.ts", 350],
  ["packages/core/src/browser-executable.ts", 350],
  // Browser-executable's security boundary, split out of it so the search ORDER (a product
  // decision) and the hostile-directory rules (a security one) can be read and changed apart.
  // Strict caps: an execution-trust rule that grows a special case per caller is how it stops
  // being auditable.
  ["packages/core/src/executable-trust.ts", 250],
  ["packages/core/src/playwright-browser-cache.ts", 250],
  ["packages/core/src/browser-executable.test.ts", 600],
  ["packages/renderer-browser/src/frame-lane-handoff.ts", 350],
  ["packages/renderer-browser/src/frame-lane-handoff.test.ts", 600],
  ["packages/renderer-browser/src/browser-screenshot-integrity.ts", 180],
  ["packages/cli/src/doctor-command.ts", 350],
  ["packages/cli/src/doctor-command.test.ts", 600],
  ["packages/core/src/frame-hash-bound.test.ts", 600],
  ["packages/core/src/motion-advisory-resolution.test.ts", 600],
  ["packages/sdk/src/platform.ts", 350],
  // Validation, provenance and smoke-contract modules added during the release gate.
  // Capped from day one for the same reason as the block above: each exists because one answer had
  // drifted across three surfaces, and an uncapped shared module is how it re-accumulates into its
  // host file. Note these caps are what makes the gate cover them at all — the gate lists files
  // explicitly, so a new module with no entry is not measured by anything.
  ["packages/cli/src/package-refusals.ts", 350],
  ["packages/cli/src/unhandled-failure.ts", 350],
  ["packages/cli/src/batch-resume.ts", 350],
  ["packages/core/src/receipt-status.ts", 350],
  ["packages/core/src/receipt-status.test.ts", 600],
  ["packages/connectors/src/ffprobe-readback.test-support.ts", 200],
  ["packages/debug-api/src/ffprobe-readback.test-support.ts", 200],
  ["packages/cli/src/package-refusals.test.ts", 600],
  ["packages/cli/src/render-smoke-contract.test.ts", 600],
  ["packages/cli/src/validate-door-parity.test.ts", 600],
  ["packages/debug-api/src/receipt-tool-provenance.ts", 350],
  ["packages/debug-api/src/receipt-tool-provenance.test.ts", 600],
  ["packages/debug-api/src/render-frames-dir.test.ts", 600],
  ["packages/debug-server/src/workbench-readiness-contract.test.ts", 600],
  ["packages/sdk/src/local-render-tool-provenance.test.ts", 600],
  ["scripts/render-smoke-status.ts", 350],
  ["scripts/package-corpus-validate-gate.ts", 350],
  // Caller-boundary modules, extracted while closing the `POST /sdk` fence gap. Strict caps from
  // day one: each of these exists because one security answer was either inline in a 9k-line file
  // or spread across two, and an uncapped module is how it drifts back. The reasoning comments are
  // deliberately long — these files say WHY a check is where it is, which is the part a future
  // reader cannot reconstruct — so the caps leave room for prose but not for a second concern.
  ["packages/debug-api/src/caller-boundary.ts", 200],
  ["packages/debug-api/src/receipt-raw-prompt-purge.ts", 200],
  ["packages/debug-api/src/receipt-store-discovery.ts", 200],
  ["packages/debug-api/src/prompt-reentry-fence.test.ts", 300],
  ["packages/debug-api/src/receipt-expiry-purge.test.ts", 300],
  ["packages/debug-api/src/agent-revision-contact-sheet-fence.test.ts", 300],
  ["packages/debug-server/src/sdk-route.ts", 200],
  ["packages/debug-server/src/sdk-transport-fence.test.ts", 300],
  ["packages/debug-server/src/receipts-root-declaration.test.ts", 300],
  ["packages/sdk/src/local-debug-context.ts", 150],
  // Legacy hotspots are non-growth baselines until touched behavior is extracted.
  ["packages/core/src/adapter-diagnostics.ts", 1_489],
  ["packages/core/src/capabilities.ts", 453],
  ["packages/core/src/types.ts", 755],
  ["packages/core/src/validate.ts", 5_207],
  // +1 : the `compareCodeUnits` import. timeline.ts persists marker order into
  // motion.json, so its sort must not use the locale-sensitive comparator; no logic was added.
  ["packages/core/src/timeline.ts", 5_795],
  ["packages/core/src/timeline.test.ts", 5_815],
  // New modules extracted from the 4.7k-line entry file; strict caps so the egress policy does not
  // become the next hotspot the ratchet is chasing. The policy split three ways when popup
  // suppression and the document-downgrade rule landed: shared evidence sink and origin primitive
  // (browser-network-state), request-stage decisions (browser-route-policy), response-stage
  // redirect decisions (browser-redirect-guard). Splitting was the alternative to raising a cap.
  ["packages/renderer-browser/src/browser-network-state.ts", 350],
  ["packages/renderer-browser/src/browser-route-policy.ts", 350],
  ["packages/renderer-browser/src/browser-egress-scope.test.ts", 600],
  ["packages/renderer-browser/src/browser-redirect-guard.ts", 350],
  ["packages/renderer-browser/src/index.ts", 4_759],
  ["packages/renderer-native/src/index.ts", 2_582],
  ["packages/renderer-browser/src/index.test.ts", 6_423],
  ["packages/actions/src/catalog.ts", 2_991],
  ["packages/actions/src/catalog.test.ts", 1_494],
  ["packages/sdk/src/local.ts", 1_101],
  ["packages/sdk/src/client.ts", 383],
  ["packages/sdk/src/types.ts", 285],
  ["packages/sdk/src/local.test.ts", 491],
  ["packages/sdk/src/local-keyframe-edits.test.ts", 300],
  // Non-growth baseline pending extraction of the workbench route table and the docs/artifact
  // serving paths, which is a refactor of its own rather than a side effect of another change.
  ["packages/debug-server/src/index.ts", 1_500],
  // Verbatim lift of the pre-sweep metadata block out of index.ts; non-growth baseline.
  ["packages/debug-api/src/command-metadata-core.ts", 834],
  ["packages/debug-api/src/index.ts", 9_891],
  // Non-growth baseline: this suite is the debug API's behavioural contract and splitting it is a
  // deliberate exercise, not something to do while fixing an unrelated defect.
  ["packages/debug-api/src/index.test.ts", 24_200],
  // Non-growth baseline. Keep new readiness-parity and tool-identity work net-zero in this file.
  ["packages/cli/src/main.ts", 7_427],
  ["packages/cli/src/main.test.ts", 17_995],
]);

const failures = [];
for (const [relativePath, limit] of limits) {
  const contents = readFileSync(resolve(root, relativePath), "utf8");
  const lines = contents.endsWith("\n") ? contents.split("\n").length - 1 : contents.split("\n").length;
  if (lines > limit) failures.push(`${relativePath}: ${lines} lines exceeds ${limit}`);
  else console.log(`PASS ${relativePath}: ${lines}/${limit}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
