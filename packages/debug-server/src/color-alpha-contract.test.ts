import { afterEach, describe, expect, it } from "vitest";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index";

const servers: MotionDebugServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("MCP colour and alpha capability propagation", () => {
  it("returns the current FFmpeg delivery boundary over the callable MCP surface", async () => {
    const server = await startMotionDebugServer({ host: "127.0.0.1", port: 0, grantedTier: "read_motion" });
    servers.push(server);
    const response = await fetch(new URL("/rpc", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.capabilityToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "color-alpha-contract",
        method: "tools/call",
        params: {
          name: "motion_capabilities_panel",
          arguments: { args: { output: "mp4-h264", target: "final" } }
        }
      })
    });
    const body = await response.json() as { result?: { isError?: boolean; structuredContent?: unknown } };

    expect(response.status).toBe(200);
    const content = body.result?.structuredContent as { ok: boolean; command: string; result: { cards: unknown[] } } | undefined;
    expect(body.result).toMatchObject({ isError: false });
    expect(content).toMatchObject({
      ok: true,
      command: "motion.capabilities.panel"
    });
    expect(content?.result.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "renderer.ffmpeg",
        colorAlpha: expect.objectContaining({
          alphaBoundary: "png-or-raw-rgba-frame-input",
          delivery: expect.objectContaining({
            profile: "sdr-bt709",
            conversion: "rgb-full-to-yuv-limited",
            readback: "ffprobe-observed-tags"
          })
        })
      })
    ]));
  });
});
