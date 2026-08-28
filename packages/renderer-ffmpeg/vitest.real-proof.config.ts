/**
 * Explicitly opt-in configuration for real host proofs.
 *
 * This is intentionally separate from vitest.config.ts: ordinary package test discovery must
 * never execute or even collect a Bubblewrap/FFmpeg proof. The command also requires its
 * SHELLX_MOTION_RUN_UNTRUSTED_PARSER_PROOF gate before the suite becomes active.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test-support/enforced-untrusted-parser.real-proof.ts"],
    setupFiles: ["../../scripts/vitest-setup-job-stores.ts"]
  }
});
