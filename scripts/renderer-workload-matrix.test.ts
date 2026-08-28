import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface Workload {
  id: string;
  transport: "session" | "streamed" | "debug-api";
  lane: "browser" | "native";
  frameCount: number;
  range?: { startFrameIndex: number; endFrameIndexExclusive: number };
  extended?: boolean;
  minCacheHits?: number;
}

const fixture = JSON.parse(
  await readFile("fixtures/benchmarks/renderer-workload-matrix.json", "utf8")
) as { schema: string; workloads: Workload[] };
const source = await readFile("scripts/renderer-workload-matrix.ts", "utf8");

describe("renderer workload matrix", () => {
  it("keeps cold/warm session coverage and adds both streamed lanes", () => {
    expect(fixture.schema).toBe("renderer-workload-matrix@2");
    expect(fixture.workloads).toContainEqual(expect.objectContaining({
      id: "warm-still", transport: "session", lane: "browser", minCacheHits: 1
    }));
    expect(fixture.workloads).toContainEqual(expect.objectContaining({
      id: "debug-preview-strip-5-frame", transport: "debug-api", lane: "browser", frameCount: 5
    }));
    expect(fixture.workloads).toContainEqual(expect.objectContaining({
      id: "streamed-browser-10s-1080p30", transport: "streamed", lane: "browser", frameCount: 300
    }));
    expect(fixture.workloads).toContainEqual(expect.objectContaining({
      id: "streamed-native-10s-1080p30", transport: "streamed", lane: "native", frameCount: 300
    }));
    expect(fixture.workloads).toContainEqual(expect.objectContaining({
      id: "streamed-browser-middle-range-10s-1080p30",
      transport: "streamed",
      lane: "browser",
      range: { startFrameIndex: 149, endFrameIndexExclusive: 151 }
    }));
    expect(fixture.workloads).toContainEqual(expect.objectContaining({
      id: "streamed-native-final-range-10s-1080p30",
      transport: "streamed",
      lane: "native",
      range: { startFrameIndex: 298, endFrameIndexExclusive: 300 }
    }));
  });

  it("keeps the 60-second native RSS-observation case opt-in", () => {
    expect(fixture.workloads).toContainEqual(expect.objectContaining({
      id: "streamed-native-60s-1080p30-rss",
      transport: "streamed",
      lane: "native",
      frameCount: 1_800,
      extended: true
    }));
  });

  it("iterates one frame at a time instead of collecting frame-sized request/results arrays", () => {
    expect(source).toContain("for (let index = 0; index < renderCount; index += 1)");
    expect(source).toContain("createBrowserStreamingFrameProducer");
    expect(source).toContain("produceNativeFrameStream");
    expect(source).toContain('"motion.preview.strip"');
    expect(source).not.toContain("renderFrames(");
    expect(source).not.toContain("Array.from({ length: workload.frameCount");
  });
});
