import { describe, expect, it, vi } from "vitest";
import { withStreamingFinalLaunchRevalidation } from "./streaming-final-lineage-revalidation.js";
import { createClosedSegmentedGpuHostVerdict } from "./segmented-final-gpu-host-verdict.js";

describe("segmented GPU host verdict launch fence", () => {
  it("refuses before openRuntime creates a pre-store Browser session", async () => {
    const openRuntime = vi.fn(async () => { throw new Error("openRuntime must not be reached"); });

    await expect(withStreamingFinalLaunchRevalidation(
      async () => { throw new Error("stable lineage changed before GPU host runtime"); },
      async () => await createClosedSegmentedGpuHostVerdict({
        resources: { resources: { sessionImages: [], sessionFonts: [] } } as never,
        location: { executable: "/private/chromium", source: "override" },
        executableSha256: "a".repeat(64),
        job: { jobId: "gpu-host-fence", scratchRoot: "/private", signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} },
        maxProcessTreeRssBytes: 512 * 1024 * 1024,
        policy: { openRuntime: openRuntime as never }
      })
    )).rejects.toThrow("stable lineage changed before GPU host runtime");

    expect(openRuntime).not.toHaveBeenCalled();
  });

  it("asserts a resumed store before the final lineage fence and keeps create-new host verdicts valid", async () => {
    const resumedEvents: string[] = [];
    const resumedOpenRuntime = vi.fn(async (_images, _fonts, options) => {
      resumedEvents.push("openRuntime");
      return acceptedRuntime(options);
    });

    await expect(withStreamingFinalLaunchRevalidation(
      async () => { resumedEvents.push("lineage"); },
      async () => await createClosedSegmentedGpuHostVerdict({
        ...verdictInput(resumedOpenRuntime),
        assertStoreAuthorityCurrent: async () => {
          resumedEvents.push("store-authority");
          throw new Error("resumed durable store changed before GPU host runtime");
        }
      })
    )).rejects.toThrow("resumed durable store changed before GPU host runtime");
    expect(resumedEvents).toEqual(["store-authority"]);
    expect(resumedOpenRuntime).not.toHaveBeenCalled();

    const orderedEvents: string[] = [];
    const orderedOpenRuntime = vi.fn(async (_images, _fonts, options) => {
      orderedEvents.push("openRuntime");
      return acceptedRuntime(options);
    });
    await withStreamingFinalLaunchRevalidation(
      async () => { orderedEvents.push("lineage"); },
      async () => await createClosedSegmentedGpuHostVerdict({
        ...verdictInput(orderedOpenRuntime),
        assertStoreAuthorityCurrent: async () => { orderedEvents.push("store-authority"); }
      })
    );
    expect(orderedEvents).toEqual(["store-authority", "lineage", "openRuntime"]);

    const createEvents: string[] = [];
    const createOpenRuntime = vi.fn(async (_images, _fonts, options) => {
      createEvents.push("openRuntime");
      return acceptedRuntime(options);
    });
    await withStreamingFinalLaunchRevalidation(
      async () => { createEvents.push("lineage"); },
      async () => await createClosedSegmentedGpuHostVerdict(verdictInput(createOpenRuntime))
    );
    expect(createEvents).toEqual(["lineage", "openRuntime"]);
  });
});

function verdictInput(openRuntime: unknown) {
  return {
    resources: { resources: { sessionImages: [], sessionFonts: [] } } as never,
    location: { executable: "/private/chromium", source: "override" as const },
    executableSha256: "a".repeat(64),
    job: { jobId: "gpu-host-fence", scratchRoot: "/private", signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} },
    maxProcessTreeRssBytes: 512 * 1024 * 1024,
    policy: { openRuntime: openRuntime as never }
  };
}

function acceptedRuntime(options: { finalBrowser: { maxProcessTreeRssBytes: number } }) {
  return {
    ok: true as const,
    session: {
      browserProcess: {
        pid: 4_242,
        launcher: "precontained-direct-chromium",
        containment: {
          rootPid: 4_242,
          mode: "unix-process-group",
          status: "enforced",
          killTree: true,
          memoryLimit: "rss-monitor",
          maxProcessTreeRssBytes: options.finalBrowser.maxProcessTreeRssBytes
        }
      },
      browserVersion: "test-chromium/1",
      runtimeEvidence: {
        schema: "shellx-motion/gpu-runtime-evidence@1",
        backend: "webgpu-browser",
        browserSource: "override",
        webgpuFeatureStatus: "enabled",
        adapterFingerprint: "c".repeat(64),
        adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null },
        limits: { maxTextureDimension2D: 4_096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 }
      },
      async close() {}
    }
  } as never;
}
