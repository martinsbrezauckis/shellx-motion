import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionInstanceBuffers } from "./gpu-page-instance-buffers";
import { installWebGpuPageSessionResources, readWebGpuPageSessionResourceMetrics } from "./gpu-page-session-resources";

describe("persistent static point instance buffers", () => {
  it("uploads an exact static point batch once and keeps its bounded high-water evidence", async () => {
    const destroy = vi.fn();
    const createBuffer = vi.fn(() => ({ destroy, getMappedRange: () => new ArrayBuffer(4), mapAsync: async () => undefined, unmap: vi.fn() }));
    const writeBuffer = vi.fn();
    const context = createContext({
      Error,
      Float32Array,
      Math,
      Number,
      Object,
      Map,
      Set,
      Uint32Array,
      GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2, VERTEX: 4 },
      GPUTextureUsage: { COPY_SRC: 1, RENDER_ATTACHMENT: 2, TEXTURE_BINDING: 4 },
      __shellxMotionGpuSessionV1: {
        device: { createBuffer, createTexture: vi.fn(() => ({ createView: () => ({}), destroy })), queue: { writeBuffer } },
        limits: { maxBufferSize: 2_097_152 }
      }
    });
    const installResources = runInContext(`(${installWebGpuPageSessionResources.toString()})`, context) as typeof installWebGpuPageSessionResources;
    const install = runInContext(`(${installWebGpuPageSessionInstanceBuffers.toString()})`, context) as typeof installWebGpuPageSessionInstanceBuffers;
    const readMetrics = runInContext(`(${readWebGpuPageSessionResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionResourceMetrics;
    expect(await installResources()).toEqual({ ok: true });
    expect(await install()).toEqual({ ok: true });

    const first = "new Float32Array([0, 0, 1, 1, 1, 1, 1, 1])";
    const second = "new Float32Array([1, 0, 1, 1, 1, 1, 1, 1])";
    runInContext(`globalThis.__shellxMotionGpuSessionV1.instanceBuffers.acquire(${first});`, context);
    runInContext(`globalThis.__shellxMotionGpuSessionV1.instanceBuffers.acquire(${first});`, context);
    expect(createBuffer).toHaveBeenCalledTimes(1);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(runInContext("globalThis.__shellxMotionGpuSessionV1.instanceBuffers.snapshot()", context)).toMatchObject({
      pointRaster: "gpu-native-instanced",
      positionEvaluation: "core-cpu-exact-time",
      computeField: "not-used",
      immutablePointBufferSlots: 1,
      immutablePointBufferBytes: 32,
      immutablePointMirrorBytes: 32,
      immutablePointBufferHighWaterSlots: 1,
      immutablePointBufferHighWaterBytes: 32,
      adapterPointInstanceLimit: 65_536
    });

    runInContext(`globalThis.__shellxMotionGpuSessionV1.instanceBuffers.acquire(${second});`, context);
    expect(createBuffer).toHaveBeenCalledTimes(2);
    const snapshot = runInContext("globalThis.__shellxMotionGpuSessionV1.instanceBuffers.snapshot()", context);
    expect(snapshot).toMatchObject({ immutablePointBufferSlots: 2, immutablePointBufferHighWaterSlots: 2, immutablePointBufferHighWaterBytes: 64 });
    expect(await readMetrics()).toMatchObject({
      pointRaster: "gpu-native-instanced",
      pointPositionEvaluation: "core-cpu-exact-time",
      pointComputeField: "not-used",
      immutablePointBufferSlots: 2,
      immutablePointBufferBytes: 64,
      immutablePointBufferHighWaterSlots: 2,
      immutablePointBufferHighWaterBytes: 64,
      adapterPointInstanceLimit: 65_536
    });
    runInContext("for (let index = 2; index < 16; index += 1) globalThis.__shellxMotionGpuSessionV1.instanceBuffers.acquire(new Float32Array([index, 0, 1, 1, 1, 1, 1, 1]));", context);
    expect(() => runInContext("globalThis.__shellxMotionGpuSessionV1.instanceBuffers.acquire(new Float32Array([16, 0, 1, 1, 1, 1, 1, 1]));", context)).toThrow("32 MiB or 16-buffer");
    expect(createBuffer).toHaveBeenCalledTimes(16);
    expect(await readMetrics()).toMatchObject({ immutablePointBufferSlots: 16, immutablePointBufferHighWaterSlots: 16, immutablePointBufferHighWaterBytes: 512 });
    runInContext("globalThis.__shellxMotionGpuSessionV1.instanceBuffers.destroy()", context);
    expect(destroy).toHaveBeenCalledTimes(16);
  });
});
