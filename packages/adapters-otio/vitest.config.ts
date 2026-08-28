/** Keep native test fixtures and retained job stores inside canonical per-run roots. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../scripts/vitest-setup-job-stores.ts"]
  }
});
