import { afterEach, describe, expect, it, vi } from "vitest";
import { withStreamingFinalLaunchRevalidation } from "../streaming-final-lineage-revalidation.js";

const state = vi.hoisted(() => ({
  gpuPreparationCalls: 0,
  policyPreparationCalls: 0,
  preStoreAuthorityFailure: undefined as string | undefined,
  preStoreExecutable: "ffmpeg",
  preStoreAuthorityAssertions: 0,
  preAdmittedFactories: [] as unknown[]
}));

vi.mock("./segmented-final-adapter-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./segmented-final-adapter-helpers.js")>();
  return {
    ...actual,
    preAdmittedRunner: (...args: Parameters<typeof actual.preAdmittedRunner>) => {
      state.preAdmittedFactories.push(args[1]);
      return actual.preAdmittedRunner(...args);
    }
  };
});

vi.mock("../segmented-final-gpu-admission.js", () => ({
  prepareAdmittedSegmentedGpuInput: async (input: {
    setAuthority(authority: unknown): void;
    runner(command: { executable: string; args: string[]; shell: false }): Promise<unknown>;
  }) => {
    state.gpuPreparationCalls += 1;
    if (state.preStoreAuthorityFailure) {
      input.setAuthority({
        async assertCurrent() {
          state.preStoreAuthorityAssertions += 1;
          throw new Error(state.preStoreAuthorityFailure);
        }
      });
    }
    await input.runner({ executable: state.preStoreExecutable, args: ["-version"], shell: false });
    throw new Error("GPU pre-store probe should have been refused by its process fence");
  }
}));

vi.mock("../streaming-final-encode-policy-stages.js", () => ({
  prepareStreamingFinalEncodePolicy: async (input: { runner(command: { executable: string; args: string[]; shell: false }): Promise<unknown> }) => {
    state.policyPreparationCalls += 1;
    await input.runner({ executable: "ffmpeg", args: ["-encoders"], shell: false });
    throw new Error("policy probe should have been refused by its process fence");
  },
  releaseStreamingFinalMediaSnapshots: async () => undefined
}));

describe("segmented executor GPU pre-store launch fence", () => {
  afterEach(() => {
    state.preStoreAuthorityFailure = undefined;
    state.preStoreExecutable = "ffmpeg";
    state.preStoreAuthorityAssertions = 0;
    state.preAdmittedFactories = [];
  });

  it("does not start a pre-store policy probe after its coordinator fence fails", async () => {
    const { runSegmentedFinalAdmitted } = await import("./segmented-final-adapter-executor.js");
    let processFactoryCalls = 0;
    const result = await withStreamingFinalLaunchRevalidation(
      async () => { throw new Error("stable lineage changed before GPU pre-store probe"); },
      async () => await runSegmentedFinalAdmitted(
        {
          frameLane: "gpu",
          package: { rootPath: "/private/package", id: "gpu-fence", manifestSha256: "a".repeat(64) },
          timeline: { motionSha256: "b".repeat(64), frameCount: 1, durationMs: 1_000, fps: 1, width: 16, height: 16 },
          plan: { schema: "shellx-motion/render-segment-plan@1", fingerprint: "c".repeat(64), frameCount: 1, segmentFrames: 1, segments: [{ index: 0, startFrame: 0, endFrameExclusive: 1, frameCount: 1 }] } as never,
          outputPath: "/private/final.mp4",
          store: { intent: "create" },
          gpuHost: { pkg: {} as never }
        },
        {} as never,
        undefined,
        () => {},
        { jobId: "gpu-pre-store-fence", scratchRoot: "/private", signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} },
        512 * 1024 * 1024,
        async () => { processFactoryCalls += 1; throw new Error("process factory must not run"); },
        () => {},
        () => {}
      )
    );

    expect(state.gpuPreparationCalls).toBe(1);
    expect(processFactoryCalls).toBe(0);
    expect(result).toMatchObject({ ok: false, failure: { code: "segmented_final_failed", primaryCause: expect.objectContaining({ message: "stable lineage changed before GPU pre-store probe" }) } });
  });

  it("does not start an admitted encode-policy probe after its coordinator fence fails", async () => {
    const { runSegmentedFinalAdmitted } = await import("./segmented-final-adapter-executor.js");
    let processFactoryCalls = 0;
    const result = await withStreamingFinalLaunchRevalidation(
      async () => { throw new Error("stable lineage changed before encode policy probe"); },
      async () => await runSegmentedFinalAdmitted(
        {
          frameLane: "native",
          package: { rootPath: "/private/package", id: "native-fence", manifestSha256: "a".repeat(64) },
          timeline: { motionSha256: "b".repeat(64), frameCount: 1, durationMs: 1_000, fps: 1, width: 16, height: 16 },
          producer: { frameLane: "native" } as never,
          createRangeProducer: (() => { throw new Error("producer must not be created before policy refusal"); }) as never,
          plan: { schema: "shellx-motion/render-segment-plan@1", fingerprint: "c".repeat(64), frameCount: 1, segmentFrames: 1, segments: [{ index: 0, startFrame: 0, endFrameExclusive: 1, frameCount: 1 }] } as never,
          outputPath: "/private/final.mp4",
          store: { intent: "create" }
        },
        {} as never,
        { async assertCurrent() {} } as never,
        () => {},
        { jobId: "native-policy-fence", scratchRoot: "/private", signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} },
        512 * 1024 * 1024,
        async () => { processFactoryCalls += 1; throw new Error("process factory must not run"); },
        () => {},
        () => {}
      )
    );

    expect(state.policyPreparationCalls).toBe(1);
    expect(processFactoryCalls).toBe(0);
    expect(result).toMatchObject({ ok: false, failure: { code: "segmented_final_failed", primaryCause: expect.objectContaining({ message: "stable lineage changed before encode policy probe" }) } });
  });

  it("keeps the direct no-hook policy runner on the supplied process factory", async () => {
    const { runSegmentedFinalAdmitted } = await import("./segmented-final-adapter-executor.js");
    let processFactoryCalls = 0;
    const result = await runSegmentedFinalAdmitted(
      {
        frameLane: "native",
        package: { rootPath: "/private/package", id: "direct-no-hook", manifestSha256: "a".repeat(64) },
        timeline: { motionSha256: "b".repeat(64), frameCount: 1, durationMs: 1_000, fps: 1, width: 16, height: 16 },
        producer: { frameLane: "native" } as never,
        createRangeProducer: (() => { throw new Error("producer must not be created before the controlled policy failure"); }) as never,
        plan: { schema: "shellx-motion/render-segment-plan@1", fingerprint: "c".repeat(64), frameCount: 1, segmentFrames: 1, segments: [{ index: 0, startFrame: 0, endFrameExclusive: 1, frameCount: 1 }] } as never,
        outputPath: "/private/final.mp4",
        store: { intent: "create" }
      },
      {} as never,
      { async assertCurrent() {} } as never,
      () => {},
      { jobId: "direct-no-hook", scratchRoot: "/private", signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} },
      512 * 1024 * 1024,
      async () => { processFactoryCalls += 1; throw new Error("direct supplied process factory reached"); },
      () => {},
      () => {}
    );

    expect(processFactoryCalls).toBe(1);
    expect(result).toMatchObject({ ok: false, failure: { code: "segmented_final_failed", primaryCause: expect.objectContaining({ message: "direct supplied process factory reached" }) } });
  });

  it.each(["ffmpeg", "ffprobe"])("refuses a coordinated resumed pre-store %s launch after durable store authority drift", async (executable) => {
    const { runSegmentedFinalAdmitted } = await import("./segmented-final-adapter-executor.js");
    state.preStoreExecutable = executable;
    state.preStoreAuthorityFailure = `resumed durable store changed before ${executable} pre-store probe`;
    let processFactoryCalls = 0;

    const result = await withStreamingFinalLaunchRevalidation(
      async () => undefined,
      async () => await runSegmentedFinalAdmitted(
      {
        frameLane: "gpu",
        package: { rootPath: "/private/package", id: `resume-${executable}-fence`, manifestSha256: "a".repeat(64) },
        timeline: { motionSha256: "b".repeat(64), frameCount: 1, durationMs: 1_000, fps: 1, width: 16, height: 16 },
        plan: { schema: "shellx-motion/render-segment-plan@1", fingerprint: "c".repeat(64), frameCount: 1, segmentFrames: 1, segments: [{ index: 0, startFrame: 0, endFrameExclusive: 1, frameCount: 1 }] } as never,
        outputPath: "/private/final.mp4",
        store: { intent: "resume" },
        gpuHost: { pkg: {} as never }
      },
      {} as never,
      undefined,
      () => {},
      { jobId: `resume-${executable}-fence`, scratchRoot: "/private", signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} },
      512 * 1024 * 1024,
      async () => { processFactoryCalls += 1; throw new Error("pre-store process factory must not run after authority drift"); },
      () => {},
      () => {}
      )
    );

    expect(processFactoryCalls).toBe(0);
    expect(state.preStoreAuthorityAssertions).toBe(1);
    expect(result).toMatchObject({ ok: false, failure: { code: "segmented_final_failed", primaryCause: expect.objectContaining({ message: state.preStoreAuthorityFailure }) } });
  });

  it("keeps create-new GPU pre-store work on the direct supplied process factory", async () => {
    const { runSegmentedFinalAdmitted } = await import("./segmented-final-adapter-executor.js");
    let processFactoryCalls = 0;
    const processFactory = async () => {
      processFactoryCalls += 1;
      return { async end() { return { exitCode: 0, stdout: "", stderr: "" }; } } as never;
    };
    const result = await runSegmentedFinalAdmitted(
      {
        frameLane: "gpu",
        package: { rootPath: "/private/package", id: "create-direct-gpu", manifestSha256: "a".repeat(64) },
        timeline: { motionSha256: "b".repeat(64), frameCount: 1, durationMs: 1_000, fps: 1, width: 16, height: 16 },
        plan: { schema: "shellx-motion/render-segment-plan@1", fingerprint: "c".repeat(64), frameCount: 1, segmentFrames: 1, segments: [{ index: 0, startFrame: 0, endFrameExclusive: 1, frameCount: 1 }] } as never,
        outputPath: "/private/final.mp4",
        store: { intent: "create" },
        gpuHost: { pkg: {} as never }
      },
      {} as never,
      undefined,
      () => {},
      { jobId: "create-direct-gpu", scratchRoot: "/private", signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} },
      512 * 1024 * 1024,
      processFactory,
      () => {},
      () => {}
    );

    expect(processFactoryCalls).toBe(1);
    expect(state.preAdmittedFactories).toContain(processFactory);
    expect(result).toMatchObject({ ok: false, failure: { code: "segmented_final_failed", primaryCause: expect.objectContaining({ message: "GPU pre-store probe should have been refused by its process fence" }) } });
  });

  it("keeps direct resumed GPU pre-store work on the exact supplied process factory", async () => {
    const { runSegmentedFinalAdmitted } = await import("./segmented-final-adapter-executor.js");
    state.preStoreAuthorityFailure = "direct resumed authority must not wrap the supplied runner";
    let processFactoryCalls = 0;
    const processFactory = async () => {
      processFactoryCalls += 1;
      return { async end() { return { exitCode: 0, stdout: "", stderr: "" }; } } as never;
    };
    const result = await runSegmentedFinalAdmitted(
      {
        frameLane: "gpu",
        package: { rootPath: "/private/package", id: "resume-direct-gpu", manifestSha256: "a".repeat(64) },
        timeline: { motionSha256: "b".repeat(64), frameCount: 1, durationMs: 1_000, fps: 1, width: 16, height: 16 },
        plan: { schema: "shellx-motion/render-segment-plan@1", fingerprint: "c".repeat(64), frameCount: 1, segmentFrames: 1, segments: [{ index: 0, startFrame: 0, endFrameExclusive: 1, frameCount: 1 }] } as never,
        outputPath: "/private/final.mp4",
        store: { intent: "resume" },
        gpuHost: { pkg: {} as never }
      },
      {} as never,
      undefined,
      () => {},
      { jobId: "resume-direct-gpu", scratchRoot: "/private", signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} },
      512 * 1024 * 1024,
      processFactory,
      () => {},
      () => {}
    );

    expect(processFactoryCalls).toBe(1);
    expect(state.preStoreAuthorityAssertions).toBe(0);
    expect(state.preAdmittedFactories).toContain(processFactory);
    expect(result).toMatchObject({ ok: false, failure: { code: "segmented_final_failed", primaryCause: expect.objectContaining({ message: "GPU pre-store probe should have been refused by its process fence" }) } });
  });
});
