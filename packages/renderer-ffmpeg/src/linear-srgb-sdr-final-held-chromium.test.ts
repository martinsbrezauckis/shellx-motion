import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortStrictSdrCandidateHeldPair,
  closeStrictSdrCandidateHeldWorkspace,
  createStrictSdrCandidateHeldWorkspace,
  openStrictSdrCandidateHeldPair,
  strictSdrCandidateOutputPublication,
  strictSdrCandidateTerminalBinding,
  withStrictSdrCandidateHeldPairRendering,
  withStrictSdrCandidateHeldWorkspace,
  claimCurrentStrictSdrCandidateHeldPairRendererBinding,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldWorkspace,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import { resolveLinearSrgbSdrFinalRoute, type LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import {
  claimStrictSdrCandidateHeldChromium,
  createStrictSdrCandidateHeldChromiumProducer,
  withStrictSdrCandidateHeldChromium,
  type StrictSdrCandidateHeldChromiumHost,
} from "./linear-srgb-sdr-final-held-chromium.js";

const PREPARATION = "a".repeat(64);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

describe("strict SDR candidate held Chromium scope", () => {
  it("rejects a missing or forged Core binding without opening Chromium and rejects nesting", async () => {
    let opened = 0;
    const host: StrictSdrCandidateHeldChromiumHost = { async open() { opened += 1; return runtime([]); } };
    const current = job("/tmp/held-chromium-forged");
    await withStrictSdrCandidateHeldChromium(host, PREPARATION, async () => {
      expect(() => claimStrictSdrCandidateHeldChromium({} as never, PREPARATION, current)).toThrow(/binding is absent/i);
      await expect(withStrictSdrCandidateHeldChromium(host, PREPARATION, async () => undefined)).rejects.toThrow(/cannot nest/i);
    });
    expect(opened).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("refuses a live Core-held binding without an active Chromium holder before Core consumption", async () => {
    await withCoreHeldPair(async (pair) => {
      const binding = claimBinding(pair);
      expect(() => claimStrictSdrCandidateHeldChromium(binding, PREPARATION, job("/tmp/held-chromium-missing")))
        .toThrow(/unavailable/i);
    });
  });

  it.skipIf(process.platform !== "linux")("captures one holder opener, binds the exact input job, and forwards only the governed wrapper", async () => {
    const events: string[] = [], watched: number[] = [];
    let openedJob: Parameters<StrictSdrCandidateHeldChromiumHost["open"]>[0] | undefined;
    const host: StrictSdrCandidateHeldChromiumHost = {
      async open(current) {
        events.push("host-open");
        openedJob = current;
        current.watchProcess(99);
        return runtime(events);
      },
    };
    await withCoreHeldPair(async (pair) => await withStrictSdrCandidateHeldChromium(host, PREPARATION, async () => {
      const inputJob = job("/tmp/held-chromium-bound", (pid) => watched.push(pid));
      const processJob = { ...inputJob, watchProcess: (pid: number) => inputJob.watchProcess(pid) };
      const executor = claimStrictSdrCandidateHeldChromium(claimBinding(pair), PREPARATION, inputJob);
      expect(() => createStrictSdrCandidateHeldChromiumProducer(executor, { ...inputJob }, route())).toThrow(/does not match its claimed execution job/i);
      const producer = createStrictSdrCandidateHeldChromiumProducer(executor, inputJob, route());
      if (!producer.ok) throw new Error(producer.refusal.message);
      await expect(producer.producer.produce({ ...processJob, scratchRoot: "/tmp/held-chromium-wrong-root" })).rejects.toThrow(/does not match its admitted candidate job/i);
      expect(events).toEqual([]);
      host.open = async () => { throw new Error("scope must use the opener captured at installation"); };
      const frame = await producer.producer.produce(processJob);
      expect(frame).toMatchObject({ width: 2, height: 2, rgba8Srgb: expect.any(Buffer) });
      expect(openedJob).toBe(processJob);
      expect(openedJob?.signal).toBe(inputJob.signal);
      expect(openedJob?.scratchRoot).toBe(inputJob.scratchRoot);
      expect(openedJob?.maxProcessTreeRssBytes).toBe(inputJob.maxProcessTreeRssBytes);
      expect(openedJob?.watchProcess).toBe(processJob.watchProcess);
      expect(openedJob?.watchProcess).not.toBe(inputJob.watchProcess);
      expect(watched).toEqual([99, 42]);
      expect(events).toEqual(["host-open", "page-open", "page-prepare", "page-render", "page-read", "page-release", "page-close", "runtime-close"]);
      await expect(producer.producer.produce(processJob)).rejects.toThrow(/already opened/i);
    }));
  });

  it.skipIf(process.platform !== "linux")("expires a claimed executor when its holder scope ends without opening it", async () => {
    let producer: ReturnType<typeof createStrictSdrCandidateHeldChromiumProducer> | undefined;
    const inputJob = job("/tmp/held-chromium-expired");
    const host: StrictSdrCandidateHeldChromiumHost = { async open() { throw new Error("expired holder must not open"); } };
    await withCoreHeldPair(async (pair) => await withStrictSdrCandidateHeldChromium(host, PREPARATION, async () => {
      producer = createStrictSdrCandidateHeldChromiumProducer(
        claimStrictSdrCandidateHeldChromium(claimBinding(pair), PREPARATION, inputJob), inputJob, route()
      );
    }));
    if (!producer || !producer.ok) throw new Error("expected admitted producer");
    await expect(producer.producer.produce(inputJob)).rejects.toThrow(/scope expired before runtime opening/i);
  });
});

async function withCoreHeldPair<T>(operation: (pair: StrictSdrCandidateHeldPair) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-held-chromium-"));
  roots.push(root);
  let workspace: StrictSdrCandidateHeldWorkspace | undefined;
  let pair: StrictSdrCandidateHeldPair | undefined;
  const anchor = await createTrustedWorkspaceAnchor(root);
  return await withTrustedWorkspaceAnchor(anchor, async () => {
    workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
    try {
      return await withStrictSdrCandidateHeldWorkspace(workspace!, PREPARATION, async () => {
        pair = await openStrictSdrCandidateHeldPair(workspace!);
        return await withStrictSdrCandidateHeldPairRendering(pair!, PREPARATION, async () => await operation(pair!));
      });
    } finally {
      if (pair) await abortStrictSdrCandidateHeldPair(pair);
      else if (workspace) await closeStrictSdrCandidateHeldWorkspace(workspace);
    }
  });
}

function claimBinding(pair: StrictSdrCandidateHeldPair) {
  const binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(
    strictSdrCandidateOutputPublication(pair), PREPARATION, strictSdrCandidateTerminalBinding(pair).outputPath
  );
  if (!binding) throw new Error("expected Core-held renderer binding");
  return binding;
}

function job(scratchRoot: string, watchProcess: (pid: number) => void = () => undefined) {
  return { admission: "pre-acquired" as const, signal: new AbortController().signal, scratchRoot, maxProcessTreeRssBytes: 64 * 1024 * 1024, watchProcess };
}

function route(): LinearSrgbSdrFinalRoute {
  const resolved = resolveLinearSrgbSdrFinalRoute({
    schema: "shellx-motion/motion@1", id: "held-chromium", name: "Held Chromium", durationMs: 1_000, fps: 2, width: 2, height: 2,
    background: "#000000", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [],
    provenance: { sourceApp: "test", createdBy: "held-chromium-test" },
    layers: [],
  }, { target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264" });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function runtime(events: string[]) {
  const padded = Buffer.alloc(512);
  for (const offset of [3, 7, 259, 263]) padded[offset] = 255;
  return {
    ok: true as const,
    session: {
      browserProcess: { pid: 42, launcher: "precontained-direct-chromium", containment: { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 64 * 1024 * 1024 } },
      page: { async evaluate() {
        const step = events.filter((event) => event.startsWith("page-")).length;
        const event = ["page-open", "page-prepare", "page-render", "page-read", "page-release", "page-close"][step];
        events.push(event!);
        if (step === 0) return { ok: true, runtime: {} };
        if (step === 1 || step === 2) return { ok: true };
        if (step === 3) return { ok: true, paddedBase64: padded.toString("base64"), evidence: { bytesPerRow: 256, paddedByteLength: 512, tightByteLength: 16, mappedBufferUnmapped: true, mappedBufferDestroyed: true } };
        if (step === 4) return { hadResources: true, releasedGpuBytes: 1, remainingGpuBytes: 0, releaseFailed: false };
        return { deviceDestroyed: true, forcedResourceRelease: false, releaseFailed: false };
      } },
      assessRender: async () => ({ ok: true, evidence: {} }),
      close: async () => { events.push("runtime-close"); },
    },
  } as never;
}
