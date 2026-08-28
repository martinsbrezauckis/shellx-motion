import { describe, expect, it } from "vitest";
import { renderGeneratedPointCloud } from "./generated-points";

describe("generated point canvas markup", () => {
  it("serializes 4,201 ordered points into one renderer-owned canvas surface", () => {
    const points = Array.from({ length: 4_201 }, (_item, index) => ({
      x: index % 120,
      y: Math.floor(index / 120),
      color: index === 0 ? "#ff0000" : "#00ff00",
      size: 1,
      opacity: 1,
    }));
    const html = renderGeneratedPointCloud({
      layer: { id: "swarm", type: "points", startMs: 0, durationMs: 1_000, pointCloud: { points } },
      atMs: 0,
      width: 120,
      height: 80,
      style: "position:absolute;",
      resolveColor: (value) => value,
    });
    const encoded = /data-motion-points-config="([^"]+)"/.exec(html)?.[1];

    expect(html.match(/<canvas/g)).toHaveLength(1);
    expect(html).not.toContain("<span");
    expect(html).toContain('data-motion-points-count="4201"');
    expect(encoded).toBeTruthy();
    const config = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as { points: Array<{ x: number; y: number; color: string }>; trails: unknown[] };
    expect(config.points).toHaveLength(4_201);
    expect(config.points.slice(0, 2)).toEqual([
      { x: 0, y: 0, size: 1, opacity: 1, color: "#ff0000" },
      { x: 1, y: 0, size: 1, opacity: 1, color: "#00ff00" },
    ]);
    expect(config.trails).toEqual([]);
  });
});
