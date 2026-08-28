/**
 * Explicitly opt-in configuration for the real Linux Bubblewrap + Chromium proof.
 *
 * It is separate from the ordinary renderer Vitest configuration: routine test discovery must
 * neither collect nor start a browser through Bubblewrap. The suite has a second environment
 * gate, so this config alone cannot start the host proof.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test-support/enforced-untrusted-browser.real-proof.ts"],
    setupFiles: ["../../scripts/vitest-setup-job-stores.ts"]
  }
});
