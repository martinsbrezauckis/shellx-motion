import { createHash } from "node:crypto";
import { mkdtemp, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor, type TrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { PairedOutputReceiptPublication } from "./paired-output-receipt-publication";
import type { DerivedOutputPublication } from "./derived-output-publication";
import { strictSdrCandidateHeldPairState, strictSdrCandidateHeldWorkspaceState } from "./strict-sdr-candidate-held-workspace";
import {
  abortStrictSdrCandidateHeldPair,
  claimCurrentStrictSdrCandidateHeldPairRendererBinding,
  closeStrictSdrCandidateHeldWorkspace,
  commitStrictSdrCandidateHeldPair,
  consumeCurrentStrictSdrCandidateHeldPairRendererBinding,
  consumeStrictSdrCandidateHeldPair,
  createStrictSdrCandidateHeldWorkspace,
  currentStrictSdrCandidateHeldWorkspace,
  isStrictSdrCandidateHeldPairRendererBinding,
  matchesCurrentStrictSdrCandidateHeldPairRendererInput,
  matchesCurrentStrictSdrCandidateHeldPairObservation,
  openStrictSdrCandidateHeldPair,
  registerStrictSdrCandidateF2aFinalizer,
  recordStrictSdrCandidateHeldMediaStage,
  stageStrictSdrCandidateFinalReceipt as stageCoreFinalReceipt,
  strictSdrCandidateHeldPairForConsumedRendererBinding,
  strictSdrCandidateOutputPublication,
  strictSdrCandidateTerminalBinding,
  withStrictSdrCandidateHeldPairRendering,
  withStrictSdrCandidateHeldWorkspace,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldPairObservation,
  type StrictSdrCandidateHeldWorkspace
} from "./strict-sdr-candidate-held-pair";
import type { OperationReceipt } from "./types";

const PREPARATION = "a".repeat(64);
const bytes = Buffer.from("strict SDR held pair bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");

// Synthetic pair fixtures supply the verified Core stage without running the renderer operation.
async function stageStrictSdrCandidateFinalReceipt(
  pair: StrictSdrCandidateHeldPair,
  receipt: OperationReceipt,
  evidence: NonNullable<Parameters<typeof stageCoreFinalReceipt>[2]>,
): Promise<void> {
  if (strictSdrCandidateHeldPairState(pair).rendererClaimed) strictSdrCandidateHeldPairState(pair).adoptedStage = evidence;
  await stageCoreFinalReceipt(pair, receipt, evidence);
}

function deferred<T = void>(): Readonly<{ promise: Promise<T>; resolve(value?: T): void; reject(error: unknown): void }> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return Object.freeze({ resolve: (value?: T) => resolvePromise!(value as T), reject: (error) => rejectPromise!(error), promise });
}

async function fixtureRootFdTargets(root: string): Promise<readonly string[]> {
  const entries = await readdir("/proc/self/fd");
  const targets = await Promise.all(entries.filter((entry) => /^\d+$/u.test(entry)).map(async (entry) => {
    const target = await readlink(`/proc/self/fd/${entry}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    return target === root || target?.startsWith(`${root}/`) ? `${entry}:${target}` : undefined;
  }));
  return targets.filter((target): target is string => target !== undefined).sort();
}

async function withFixture<T>(operation: (root: string, anchor: TrustedWorkspaceAnchor) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-strict-sdr-core-"));
  try {
    const anchor = await createTrustedWorkspaceAnchor(root);
    return await withTrustedWorkspaceAnchor(anchor, async () => await operation(root, anchor));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function strictReceipt(stagePath: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: "strict-sdr-candidate-pair",
    operation: "render.final",
    status: "passed",
    packageId: "pkg_strict_sdr",
    inputHashes: {
      motion: "b".repeat(64),
      "linear-srgb-sdr-route": "c".repeat(64),
      "linear-srgb-sdr-preparation": PREPARATION,
      "linear-srgb-sdr-ffmpeg-contract": "d".repeat(64),
      "linear-srgb-sdr-webgpu-producer": "e".repeat(64),
      "linear-srgb-sdr-producer-frame": "f".repeat(64),
      "linear-srgb-sdr-comparison-policy": "0".repeat(64),
      "linear-srgb-sdr-execution": "1".repeat(64)
    },
    createdAt: "2026-09-07T00:00:00.000Z",
    lane: "ffmpeg",
    output: {
      path: stagePath,
      sha256,
      byteLength: bytes.byteLength,
      frameTransport: {
        schema: "shellx-motion/linear-srgb-sdr-final-transport@2",
        privateOutputAdoption: {
          schema: "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1",
          verifiedOutput: { sha256, byteLength: bytes.byteLength },
          privatePublicationStage: { sha256, byteLength: bytes.byteLength }
        }
      }
    },
    warnings: []
  };
}

describe.runIf(process.platform === "linux")("strict-SDR candidate held Core pair", () => {
  it("records only one consumed, live renderer binding for the verified Core stage", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        let binding!: NonNullable<ReturnType<typeof claimCurrentStrictSdrCandidateHeldPairRendererBinding>>;
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, strictSdrCandidateTerminalBinding(pair).outputPath)!;
          await expect(recordStrictSdrCandidateHeldMediaStage(binding, output)).rejects.toThrow(/unconsumed/i);
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
          await expect(recordStrictSdrCandidateHeldMediaStage(Object.freeze({}) as typeof binding, output)).rejects.toThrow(/forged/i);
          await expect(recordStrictSdrCandidateHeldMediaStage(binding, {} as DerivedOutputPublication)).rejects.toThrow(/publication/i);
          const evidence = await output.writePrivateFile(bytes, { label: "renderer-bound Core stage", maxBytes: 256 * 1024 * 1024 });
          const concurrent = await Promise.allSettled([recordStrictSdrCandidateHeldMediaStage(binding, output), recordStrictSdrCandidateHeldMediaStage(binding, output)]);
          expect(concurrent.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
          expect(concurrent.find((result) => result.status === "fulfilled")).toMatchObject({ value: evidence });
          expect(concurrent.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.any(Error) });
          await expect(recordStrictSdrCandidateHeldMediaStage(binding, output)).rejects.toThrow(/unrecorded/i);
        });
        await expect(recordStrictSdrCandidateHeldMediaStage(binding, output)).rejects.toThrow(/expired/i);
        await stageCoreFinalReceipt(pair, strictReceipt(output.stagingPath));
        await commitStrictSdrCandidateHeldPair(pair);
        await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          expect(observation.media).toEqual({ sha256, byteLength: bytes.byteLength });
        });
      });
    });
  });

  it("refuses a renderer-claimed final receipt without its operation-owned stage adoption", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, strictSdrCandidateTerminalBinding(pair).outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
        });
        const evidence = await output.writePrivateFile(bytes, { label: "missing renderer adoption", maxBytes: 256 * 1024 * 1024 });
        await expect(stageCoreFinalReceipt(pair, strictReceipt(output.stagingPath), evidence)).rejects.toThrow(/renderer-owned Core stage adoption/i);
        await abortStrictSdrCandidateHeldPair(pair);
      });
    });
  });

  it("keeps ordinary work out of candidate scope and refuses forged opaque values", async () => {
    expect(currentStrictSdrCandidateHeldWorkspace()).toBeUndefined();
    expect(matchesCurrentStrictSdrCandidateHeldPairRendererInput({} as never, PREPARATION, "/ordinary.mp4")).toBe(false);
    expect(claimCurrentStrictSdrCandidateHeldPairRendererBinding({} as never, PREPARATION, "/ordinary.mp4")).toBeUndefined();
    await expect(openStrictSdrCandidateHeldPair({} as StrictSdrCandidateHeldWorkspace)).rejects.toThrow(/not created by Core/i);
    await expect(abortStrictSdrCandidateHeldPair({} as StrictSdrCandidateHeldPair)).rejects.toThrow(/not created by Core/i);
  });

  it("leaves an unregistered ordinary paired receipt publication unchanged", async () => {
    await withFixture(async (root) => {
      const outputPath = join(root, "ordinary.mp4");
      const pair = await PairedOutputReceiptPublication.acquire({
        outputPath,
        receiptPath: `${outputPath}.receipt.json`,
        outputArtifact: { role: "rendered_media", mediaType: "video/mp4", primary: true },
        receiptArtifact: { role: "render_receipt", mediaType: "application/json" }
      });
      const output = pair.outputPublication;
      await output.writePrivateFile(bytes, { label: "ordinary paired Core test media", maxBytes: 256 * 1024 * 1024 });
      await expect(pair.stageReceipt(strictReceipt(output.stagingPath))).resolves.toBeUndefined();
      await expect(pair.commit()).resolves.toBeUndefined();
    });
  });

  it("revokes workspace and renderer authority captured by delayed detached callbacks", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      const resumeWorkspace = deferred();
      let detachedWorkspace: Promise<unknown> | undefined;
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        detachedWorkspace = (async () => {
          await resumeWorkspace.promise;
          expect(currentStrictSdrCandidateHeldWorkspace()).toBeUndefined();
          return await openStrictSdrCandidateHeldPair(workspace);
        })();
      });
      resumeWorkspace.resolve();
      await expect(detachedWorkspace!).rejects.toThrow(/workspace scope/i);
      await closeStrictSdrCandidateHeldWorkspace(workspace);

      const rendererWorkspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(rendererWorkspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(rendererWorkspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const resumeRenderer = deferred();
        let detachedRendererClaim: Promise<unknown> | undefined;
        let detachedRendererConsume: Promise<unknown> | undefined;
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, strictSdrCandidateTerminalBinding(pair).outputPath)!;
          detachedRendererClaim = (async () => {
            await resumeRenderer.promise;
            return claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, strictSdrCandidateTerminalBinding(pair).outputPath);
          })();
          detachedRendererConsume = (async () => {
            await resumeRenderer.promise;
            expect(isStrictSdrCandidateHeldPairRendererBinding(binding)).toBe(false);
            consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
          })();
        });
        resumeRenderer.resolve();
        await Promise.all([
          expect(detachedRendererClaim!).rejects.toThrow(/scope expired/i),
          expect(detachedRendererConsume!).rejects.toThrow(/forged, expired, mismatched, or already consumed/i)
        ]);
        await abortStrictSdrCandidateHeldPair(pair);
      });
    });
  });

  it("binds one fixed pair to the scoped preparation and consumes retained descriptors exactly once", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        expect(currentStrictSdrCandidateHeldWorkspace()).toBe(workspace);
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        await expect(openStrictSdrCandidateHeldPair(workspace)).rejects.toThrow(/cannot open another pair/i);
        const terminalBinding = strictSdrCandidateTerminalBinding(pair);
        expect(terminalBinding.outputPath).toMatch(/\/output\.mp4$/u);
        expect(terminalBinding.receiptPath).toMatch(/\/output\.mp4\.receipt\.json$/u);
        expect(terminalBinding.outputPath).not.toContain("/proc/self/fd/");

        const output = strictSdrCandidateOutputPublication(pair);
        expect(matchesCurrentStrictSdrCandidateHeldPairRendererInput(output, PREPARATION, terminalBinding.outputPath)).toBe(false);
        expect(claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, terminalBinding.outputPath)).toBeUndefined();
        let expiredBinding: ReturnType<typeof claimCurrentStrictSdrCandidateHeldPairRendererBinding>;
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          expect(matchesCurrentStrictSdrCandidateHeldPairRendererInput(output, PREPARATION, terminalBinding.outputPath)).toBe(true);
          expect(matchesCurrentStrictSdrCandidateHeldPairRendererInput(output, PREPARATION, `${terminalBinding.outputPath}.wrong`)).toBe(false);
          expect(matchesCurrentStrictSdrCandidateHeldPairRendererInput({} as unknown as DerivedOutputPublication, PREPARATION, terminalBinding.outputPath)).toBe(false);
          expect(matchesCurrentStrictSdrCandidateHeldPairRendererInput(output, "b".repeat(64), terminalBinding.outputPath)).toBe(false);
          expect(() => claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, "b".repeat(64), terminalBinding.outputPath)).toThrow(/does not match/i);
          expect(() => claimCurrentStrictSdrCandidateHeldPairRendererBinding({} as unknown as DerivedOutputPublication, PREPARATION, terminalBinding.outputPath)).toThrow(/does not match/i);
          expect(() => claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, `${terminalBinding.outputPath}.wrong`)).toThrow(/does not match/i);
          const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, terminalBinding.outputPath);
          expect(rendererBinding).toBeDefined();
          expiredBinding = rendererBinding;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding!);
          expect(isStrictSdrCandidateHeldPairRendererBinding(rendererBinding)).toBe(false);
          expect(() => consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding!)).toThrow(/already consumed/i);
          expect(() => claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, terminalBinding.outputPath)).toThrow(/does not match/i);
        });
        expect(isStrictSdrCandidateHeldPairRendererBinding(expiredBinding)).toBe(false);

        const evidence = await output.writePrivateFile(bytes, {
          label: "strict-SDR candidate Core test media",
          maxBytes: 256 * 1024 * 1024
        });
        await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
        await commitStrictSdrCandidateHeldPair(pair);

        let expiredObservation: StrictSdrCandidateHeldPairObservation | undefined;
        const consumed = await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          expiredObservation = observation;
          expect(observation.media).toEqual({ sha256, byteLength: bytes.byteLength });
          await expect(observation.hashMedia()).resolves.toEqual({ sha256, byteLength: bytes.byteLength });
          const receipt = await observation.readReceipt();
          expect(receipt.byteLength).toBeGreaterThan(0);
          return receipt.toString("utf8");
        });
        expect(consumed).toContain('"pairedOutputReceiptPublication"');
        await expect(expiredObservation!.readReceipt()).rejects.toThrow(/expired/i);
        await expect(consumeStrictSdrCandidateHeldPair(pair, async () => undefined)).rejects.toThrow(/not available/i);
      });
    });
  });

  it("keeps the F2a descriptor callback one-shot and finalizes its lease after capture closure", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const binding = strictSdrCandidateTerminalBinding(pair);
        const events: string[] = [];
        let finalizerTargets: readonly string[] = [];
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, binding.outputPath)!;
          expect(() => strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding)).toThrow(/unconsumed/i);
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding);
          expect(strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding)).toBe(pair);
          expect(() => strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding)).toThrow(/already resolved/i);
          registerStrictSdrCandidateF2aFinalizer(pair, async () => {
            finalizerTargets = await fixtureRootFdTargets(root);
            events.push("finalizer");
          });
          expect(() => registerStrictSdrCandidateF2aFinalizer(pair, async () => undefined)).toThrow(/does not match/i);
        });
        const evidence = await output.writePrivateFile(bytes, { label: "strict-SDR F2a descriptor callback media", maxBytes: 256 * 1024 * 1024 });
        await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
        await commitStrictSdrCandidateHeldPair(pair);
        let expiredObservation: StrictSdrCandidateHeldPairObservation | undefined;
        await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          expiredObservation = observation;
          await expect(observation.withF2aCommittedMediaDescriptor(async (input) => {
            expect(input.fd).toBeGreaterThan(2);
            expect(input.media).toEqual({ sha256, byteLength: bytes.byteLength });
            events.push("descriptor");
          })).resolves.toBeUndefined();
          await expect(observation.withF2aCommittedMediaDescriptor(async () => undefined)).rejects.toThrow(/one-shot/i);
        });
        expect(events).toEqual(["descriptor", "finalizer"]);
        expect(finalizerTargets.some((target) => target.includes("/output.mp4"))).toBe(false);
        await expect(expiredObservation!.withF2aCommittedMediaDescriptor(async () => undefined)).rejects.toThrow(/expired/i);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
      });
    });
  });

  it("binds an F2a observation to its exact consuming pair only while its evaluator is active", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      const otherWorkspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      let otherPair: StrictSdrCandidateHeldPair | undefined;
      await withStrictSdrCandidateHeldWorkspace(otherWorkspace, PREPARATION, async () => {
        otherPair = await openStrictSdrCandidateHeldPair(otherWorkspace);
      });
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const evidence = await output.writePrivateFile(bytes, { label: "strict-SDR F2a observation pair binding", maxBytes: 256 * 1024 * 1024 });
        await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
        await commitStrictSdrCandidateHeldPair(pair);
        let expired: StrictSdrCandidateHeldPairObservation | undefined;
        await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          expired = observation;
          expect(matchesCurrentStrictSdrCandidateHeldPairObservation(pair, observation)).toBe(true);
          expect(matchesCurrentStrictSdrCandidateHeldPairObservation(otherPair!, observation)).toBe(false);
          expect(matchesCurrentStrictSdrCandidateHeldPairObservation(Object.freeze({}) as StrictSdrCandidateHeldPair, observation)).toBe(false);
          expect(matchesCurrentStrictSdrCandidateHeldPairObservation(pair, Object.freeze({}))).toBe(false);
        });
        expect(matchesCurrentStrictSdrCandidateHeldPairObservation(pair, expired)).toBe(false);
      });
      await withStrictSdrCandidateHeldWorkspace(otherWorkspace, PREPARATION, async () => {
        await abortStrictSdrCandidateHeldPair(otherPair!);
      });
    });
  });

  it("waits for an unawaited rejected F2a descriptor callback before finalizing or closing", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const binding = strictSdrCandidateTerminalBinding(pair);
        const callbackEntered = deferred(), releaseCallback = deferred();
        const callbackFailure = new Error("deferred F2a descriptor callback failed");
        let finalizerCalls = 0;
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, binding.outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding);
          strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding);
          registerStrictSdrCandidateF2aFinalizer(pair, async () => { finalizerCalls += 1; });
        });
        const evidence = await output.writePrivateFile(bytes, { label: "strict-SDR deferred F2a descriptor media", maxBytes: 256 * 1024 * 1024 });
        await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
        await commitStrictSdrCandidateHeldPair(pair);
        let expiredObservation: StrictSdrCandidateHeldPairObservation | undefined;
        const consumed = consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          expiredObservation = observation;
          void observation.withF2aCommittedMediaDescriptor(async () => {
            callbackEntered.resolve();
            await releaseCallback.promise;
            throw callbackFailure;
          });
        });
        await callbackEntered.promise;
        expect(matchesCurrentStrictSdrCandidateHeldPairObservation(pair, expiredObservation)).toBe(false);
        expect(finalizerCalls).toBe(0);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(false);
        expect((await fixtureRootFdTargets(root)).some((target) => target.includes("/output.mp4"))).toBe(true);
        releaseCallback.resolve();
        await expect(consumed).rejects.toBe(callbackFailure);
        expect(finalizerCalls).toBe(1);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
      });
    });
  });

  it("refuses media mutation made during the F2a descriptor callback after its post-callback recheck", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const binding = strictSdrCandidateTerminalBinding(pair);
        let finalizerCalled = false;
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, binding.outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding);
          strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding);
          registerStrictSdrCandidateF2aFinalizer(pair, async () => { finalizerCalled = true; });
        });
        const evidence = await output.writePrivateFile(bytes, { label: "strict-SDR F2a mutation callback media", maxBytes: 256 * 1024 * 1024 });
        await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
        await commitStrictSdrCandidateHeldPair(pair);
        await expect(consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          await observation.withF2aCommittedMediaDescriptor(async () => {
            await writeFile(binding.outputPath, Buffer.from("tampered during F2a descriptor callback"));
          });
        })).rejects.toThrow(/exact single-link inode capture/i);
        expect(finalizerCalled).toBe(true);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
      });
    });
  });

  it("refuses a resolved F2a binding that leaves renderer scope without its finalizer", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const binding = strictSdrCandidateTerminalBinding(pair);
        await expect(withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, binding.outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding);
          strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding);
        })).rejects.toThrow(/did not register its required finalizer/i);
        await expect(abortStrictSdrCandidateHeldPair(pair)).rejects.toThrow(/resolved without its required finalizer/i);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
      });
    });
  });

  it("runs the registered F2a finalizer on abort before workspace closure", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const binding = strictSdrCandidateTerminalBinding(pair);
        let calls = 0;
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, binding.outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding);
          strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding);
          registerStrictSdrCandidateF2aFinalizer(pair, async () => {
            calls += 1;
            expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(false);
          });
        });
        await abortStrictSdrCandidateHeldPair(pair);
        expect(calls).toBe(1);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
      });
    });
  });

  it("aggregates evaluator and F2a finalizer failures after retained capture closure", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const binding = strictSdrCandidateTerminalBinding(pair);
        const primary = new Error("F2a evaluator failed");
        const finalizer = new Error("F2a lease cleanup failed");
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, binding.outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding);
          strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding);
          registerStrictSdrCandidateF2aFinalizer(pair, async () => {
            expect((await fixtureRootFdTargets(root)).some((target) => target.includes("/output.mp4"))).toBe(false);
            throw finalizer;
          });
        });
        const evidence = await output.writePrivateFile(bytes, { label: "strict-SDR F2a finalizer aggregate media", maxBytes: 256 * 1024 * 1024 });
        await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
        await commitStrictSdrCandidateHeldPair(pair);
        const error = await consumeStrictSdrCandidateHeldPair(pair, async () => { throw primary; }).then(() => undefined, (reason) => reason);
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([primary, finalizer]);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
      });
    });
  });

  it("refuses post-commit media mutation and closes the consumed retained descriptors", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const binding = strictSdrCandidateTerminalBinding(pair);
        const evidence = await output.writePrivateFile(bytes, {
          label: "strict-SDR candidate post-commit media mutation test",
          maxBytes: 256 * 1024 * 1024
        });
        await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
        await commitStrictSdrCandidateHeldPair(pair);

        expect(await fixtureRootFdTargets(root)).not.toEqual([]);
        await writeFile(binding.outputPath, Buffer.from("tampered held media"));
        await expect(consumeStrictSdrCandidateHeldPair(pair, async () => undefined)).rejects.toThrow(/exact single-link inode capture|retained bounded identity/i);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
        await expect(consumeStrictSdrCandidateHeldPair(pair, async () => undefined)).rejects.toThrow(/not available/i);
      });
    });
  });

  it("refuses post-commit receipt mutation and closes the consumed retained descriptors", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const binding = strictSdrCandidateTerminalBinding(pair);
        const evidence = await output.writePrivateFile(bytes, {
          label: "strict-SDR candidate post-commit receipt mutation test",
          maxBytes: 256 * 1024 * 1024
        });
        await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
        await commitStrictSdrCandidateHeldPair(pair);

        expect(await fixtureRootFdTargets(root)).not.toEqual([]);
        await writeFile(binding.receiptPath, Buffer.from("tampered held receipt"));
        await expect(consumeStrictSdrCandidateHeldPair(pair, async () => undefined)).rejects.toThrow(/exact single-link inode capture|retained bounded identity/i);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
        await expect(consumeStrictSdrCandidateHeldPair(pair, async () => undefined)).rejects.toThrow(/not available/i);
      });
    });
  });

  it("retains terminal and workspace-close failures together for consume and abort", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const evidence = await output.writePrivateFile(bytes, { label: "strict-SDR dual-error consume media", maxBytes: 256 * 1024 * 1024 });
        await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
        await commitStrictSdrCandidateHeldPair(pair);

        const state = strictSdrCandidateHeldWorkspaceState(workspace);
        const primary = new Error("evaluator failed");
        const cleanup = new Error("workspace close failed");
        const actualClose = state.handle.close.bind(state.handle);
        const closeSpy = vi.spyOn(state.handle, "close").mockRejectedValueOnce(cleanup);
        try {
          const error = await consumeStrictSdrCandidateHeldPair(pair, async () => { throw primary; }).then(() => undefined, (reason) => reason);
          expect(error).toBeInstanceOf(AggregateError);
          expect((error as AggregateError).errors).toEqual([primary, cleanup]);
          await expect(consumeStrictSdrCandidateHeldPair(pair, async () => undefined)).rejects.toThrow(/not available/i);
        } finally {
          closeSpy.mockRestore();
          await actualClose();
        }
      });

      const abortWorkspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(abortWorkspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(abortWorkspace);
        const workspaceState = strictSdrCandidateHeldWorkspaceState(abortWorkspace);
        const pairState = strictSdrCandidateHeldPairState(pair);
        const primary = new Error("publication abort failed");
        const cleanup = new Error("workspace close failed");
        const actualClose = workspaceState.handle.close.bind(workspaceState.handle);
        const abortSpy = vi.spyOn(pairState.publication, "abort").mockRejectedValueOnce(primary);
        const closeSpy = vi.spyOn(workspaceState.handle, "close").mockRejectedValueOnce(cleanup);
        try {
          const error = await abortStrictSdrCandidateHeldPair(pair).then(() => undefined, (reason) => reason);
          expect(error).toBeInstanceOf(AggregateError);
          expect((error as AggregateError).errors).toEqual([primary, cleanup]);
          await expect(abortStrictSdrCandidateHeldPair(pair)).resolves.toBeUndefined();
        } finally {
          abortSpy.mockRestore();
          closeSpy.mockRestore();
          await pairState.publication.abort();
          await actualClose();
        }
      });
    });
  });
});
