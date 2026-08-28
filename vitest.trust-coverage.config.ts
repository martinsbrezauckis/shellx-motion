/**
 * Targeted trust-boundary coverage gate.
 *
 * This deliberately does not replace `debug:coverage`, which measures the actions package's
 * command surface. The small, named source set below is the separately maintained safety net for
 * code that decides where Motion may connect, read, write, redirect, admit work, or refuse an
 * unauthorized request. It also names the currently integrated producer-to-segment boundary:
 * canonical producer ranges, immutable package input, resumable checkpoint storage, constrained
 * concat authority, and the contained sequential spool. It deliberately excludes the separately
 * evolving high-level final adapter. `all: true` makes a removed import or test show up as zero
 * coverage.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/actions/src/permission-refusal.test.ts",
      "packages/core/src/job-governor.test.ts",
      "packages/core/src/job-lease.test.ts",
      "packages/core/src/network-policy.test.ts",
      "packages/core/src/output-dir-guard.test.ts",
      "packages/core/src/package-archive.test.ts",
      "packages/core/src/package-id-path-safety.test.ts",
      "packages/core/src/path-contract.test.ts",
      "packages/core/src/capabilities.test.ts",
      "packages/core/src/capability-card-contract.test.ts",
      "packages/core/src/capability-delivery-pipeline.test.ts",
      "packages/core/src/integration-protocol.test.ts",
      "packages/renderer-browser/src/browser-redirect-downgrade.test.ts",
      "packages/renderer-browser/src/browser-streaming-producer.test.ts",
      "packages/renderer-native/src/native-frame-producer.test.ts",
      "packages/renderer-ffmpeg/src/ffmpeg-process-control.test.ts",
      "packages/renderer-ffmpeg/src/lossless-segment-concat-command.test.ts",
      "packages/renderer-ffmpeg/src/package-content-fingerprint.test.ts",
      "packages/renderer-ffmpeg/src/render-segment-spool.test.ts",
      "packages/renderer-ffmpeg/src/render-segment-store.test.ts",
      "packages/renderer-ffmpeg/src/streaming-process.test.ts",
      "packages/renderer-ffmpeg/src/streaming-foundation.test.ts"
    ],
    setupFiles: ["./scripts/vitest-setup-job-stores.ts"],
    // The suites create real temporary files, leases, and local HTTP servers. Serial file execution
    // keeps the gate deterministic and avoids competing with Motion's heavier browser workloads.
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 45_000,
    hookTimeout: 45_000,
    coverage: {
      provider: "v8",
      enabled: true,
      all: true,
      include: [
        "packages/actions/src/permission-refusal.ts",
        "packages/core/src/job-governor.ts",
        "packages/core/src/job-lease.ts",
        "packages/core/src/network-policy.ts",
        "packages/core/src/output-dir-guard.ts",
        "packages/core/src/package-archive.ts",
        "packages/core/src/path-contract.ts",
        "packages/core/src/capabilities.ts",
        "packages/core/src/integration-protocol.ts",
        "packages/renderer-browser/src/browser-redirect-guard.ts",
        "packages/renderer-browser/src/browser-route-policy.ts",
        "packages/renderer-browser/src/browser-streaming-frame-range.ts",
        "packages/renderer-browser/src/browser-streaming-producer.ts",
        "packages/renderer-native/src/native-frame-range.ts",
        "packages/renderer-native/src/native-frame-producer.ts",
        "packages/renderer-ffmpeg/src/ffmpeg-process-control.ts",
        "packages/renderer-ffmpeg/src/unadopted/segmented-final/lossless-segment-concat-command.ts",
        "packages/renderer-ffmpeg/src/unadopted/segmented-final/package-content-fingerprint.ts",
        "packages/renderer-ffmpeg/src/unadopted/segmented-final/render-segment-plan.ts",
        "packages/renderer-ffmpeg/src/unadopted/segmented-final/render-segment-spool-helpers.ts",
        "packages/renderer-ffmpeg/src/unadopted/segmented-final/render-segment-spool.ts",
        "packages/renderer-ffmpeg/src/unadopted/segmented-final/render-segment-store.ts",
        "packages/renderer-ffmpeg/src/streaming-foundation.ts",
        "packages/renderer-ffmpeg/src/streaming-process.ts"
      ],
      reporter: ["text"],
      // This is intentionally a per-file floor for the named trust boundaries above, not a
      // repository-wide percentage. It leaves room for legitimate platform-only/error branches
      // while preventing a focused suite from silently ceasing to exercise one of these modules.
      thresholds: {
        perFile: true,
        "packages/actions/src/permission-refusal.ts": { statements: 85, branches: 75, functions: 90, lines: 85 },
        "packages/core/src/{job-lease,network-policy,output-dir-guard,path-contract}.ts": { statements: 85, branches: 75, functions: 90, lines: 85 },
        "packages/core/src/{capabilities,integration-protocol,package-archive}.ts": { statements: 85, branches: 75, functions: 90, lines: 85 },
        "packages/renderer-browser/src/browser-streaming-frame-range.ts": { statements: 85, branches: 75, functions: 90, lines: 85 },
        "packages/renderer-native/src/{native-frame-range,native-frame-producer}.ts": { statements: 85, branches: 75, functions: 90, lines: 85 },
        "packages/renderer-ffmpeg/src/ffmpeg-process-control.ts": { statements: 85, branches: 75, functions: 90, lines: 85 },
        "packages/renderer-ffmpeg/src/unadopted/segmented-final/{lossless-segment-concat-command,package-content-fingerprint,render-segment-plan,render-segment-spool-helpers,render-segment-spool,render-segment-store}.ts": { statements: 85, branches: 75, functions: 90, lines: 85 },
        // These long-lived authorities already have their own broad deterministic suites. Their
        // host-only and recovery seams make the standard strict floor unrealistic, so preserve
        // meaningful source-specific ratchets instead of weakening every named boundary.
        "packages/core/src/job-governor.ts": {
          statements: 80,
          branches: 75,
          functions: 80,
          lines: 80
        },
        "packages/renderer-browser/src/browser-streaming-producer.ts": {
          statements: 90,
          branches: 75,
          functions: 80,
          lines: 90
        },
        // These network authorities retain complete function coverage but contain browser error
        // branches that the deterministic Linux run cannot force. Ratchet the first complete CI
        // measurement per file instead of applying an aspirational grouped floor that never ran.
        "packages/renderer-browser/src/browser-redirect-guard.ts": {
          statements: 78,
          branches: 44,
          functions: 100,
          lines: 78
        },
        "packages/renderer-browser/src/browser-route-policy.ts": {
          statements: 83,
          branches: 75,
          functions: 100,
          lines: 83
        },
        // The public foundation exercises the admitted producer, backpressure, failure, and
        // cleanup paths. Preserve its measured baseline separately from process-control coverage.
        "packages/renderer-ffmpeg/src/streaming-foundation.ts": {
          statements: 85,
          branches: 66,
          functions: 87,
          lines: 85
        },
        // The transport's Windows-only launch modes cannot run on this Linux control host. Direct
        // shell, child, signal, backpressure, timeout, and cleanup paths stay strongly ratcheted.
        "packages/renderer-ffmpeg/src/streaming-process.ts": {
          statements: 90,
          branches: 70,
          functions: 70,
          lines: 90
        }
      }
    }
  }
});
