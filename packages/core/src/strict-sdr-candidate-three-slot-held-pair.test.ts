import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor, type TrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import {
  abortStrictSdrCandidateHeldPair,
  claimCurrentStrictSdrCandidateHeldPairRendererBinding,
  commitStrictSdrCandidateHeldPair,
  consumeCurrentStrictSdrCandidateHeldPairRendererBinding,
  consumeStrictSdrCandidateHeldPair,
  createStrictSdrCandidateHeldWorkspace,
  matchesCurrentStrictSdrCandidateHeldPairObservation,
  openStrictSdrCandidateHeldPair,
  registerStrictSdrCandidateF2bScreenControlsFinalizer,
  registerStrictSdrCandidateF2bScreenFinalizer,
  registerStrictSdrCandidateThreeSlotF2aFinalizer,
  stageStrictSdrCandidateFinalReceipt,
  strictSdrCandidateHeldPairForConsumedF2bScreenControlsRendererBinding,
  strictSdrCandidateHeldPairForConsumedF2bScreenRendererBinding,
  strictSdrCandidateHeldPairForConsumedThreeSlotF2aRendererBinding,
  strictSdrCandidateOutputPublication,
  strictSdrCandidateTerminalBinding,
  withStrictSdrCandidateHeldPairRendering,
  withStrictSdrCandidateHeldWorkspace,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldPairObservation,
  type StrictSdrCandidateHeldPairRendererBinding,
} from "./strict-sdr-candidate-held-pair";
import { strictSdrCandidateHeldWorkspaceState } from "./strict-sdr-candidate-held-workspace";
import { strictSdrCandidateHeldPairState } from "./strict-sdr-candidate-held-workspace";
import type { OperationReceipt } from "./types";

const PREPARATION = "c".repeat(64);
const media = Buffer.from("three literal strict-SDR slots");
const sha256 = createHash("sha256").update(media).digest("hex");

type Slot = Readonly<{
  name: string;
  resolve(binding: StrictSdrCandidateHeldPairRendererBinding): StrictSdrCandidateHeldPair;
  register(pair: StrictSdrCandidateHeldPair, finalizer: () => Promise<void>): void;
}>;

const slots: readonly Slot[] = Object.freeze([
  Object.freeze({
    name: "three-slot F2a",
    resolve: strictSdrCandidateHeldPairForConsumedThreeSlotF2aRendererBinding,
    register: registerStrictSdrCandidateThreeSlotF2aFinalizer,
  }),
  Object.freeze({
    name: "F2b screen",
    resolve: strictSdrCandidateHeldPairForConsumedF2bScreenRendererBinding,
    register: registerStrictSdrCandidateF2bScreenFinalizer,
  }),
  Object.freeze({
    name: "F2b screen controls",
    resolve: strictSdrCandidateHeldPairForConsumedF2bScreenControlsRendererBinding,
    register: registerStrictSdrCandidateF2bScreenControlsFinalizer,
  }),
]);

function deferred<T = void>(): Readonly<{ promise: Promise<T>; resolve(value?: T): void; reject(error: unknown): void }> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return Object.freeze({ promise, resolve: (value?: T) => resolvePromise!(value as T), reject: (error) => rejectPromise!(error) });
}

async function withFixture<T>(operation: (root: string, anchor: TrustedWorkspaceAnchor) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-three-slot-core-"));
  try {
    const anchor = await createTrustedWorkspaceAnchor(root);
    return await withTrustedWorkspaceAnchor(anchor, async () => await operation(root, anchor));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function receipt(path: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: "three-slot-held-pair",
    operation: "render.final",
    status: "passed",
    packageId: "pkg_three_slot",
    inputHashes: {
      motion: "a".repeat(64),
      "linear-srgb-sdr-route": "b".repeat(64),
      "linear-srgb-sdr-preparation": PREPARATION,
      "linear-srgb-sdr-ffmpeg-contract": "d".repeat(64),
      "linear-srgb-sdr-webgpu-producer": "e".repeat(64),
      "linear-srgb-sdr-producer-frame": "f".repeat(64),
      "linear-srgb-sdr-comparison-policy": "0".repeat(64),
      "linear-srgb-sdr-execution": "1".repeat(64),
    },
    createdAt: "2026-09-08T00:00:00.000Z",
    lane: "ffmpeg",
    output: {
      path,
      sha256,
      byteLength: media.byteLength,
      frameTransport: {
        schema: "shellx-motion/linear-srgb-sdr-final-transport@2",
        privateOutputAdoption: {
          schema: "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1",
          verifiedOutput: { sha256, byteLength: media.byteLength },
          privatePublicationStage: { sha256, byteLength: media.byteLength },
        },
      },
    },
    warnings: [],
  };
}

async function commit(pair: StrictSdrCandidateHeldPair): Promise<void> {
  const output = strictSdrCandidateOutputPublication(pair);
  const evidence = await output.writePrivateFile(media, { label: "three-slot named Core descriptor test media", maxBytes: 256 * 1024 * 1024 });
  if (strictSdrCandidateHeldPairState(pair).rendererClaimed) strictSdrCandidateHeldPairState(pair).adoptedStage = evidence;
  await stageStrictSdrCandidateFinalReceipt(pair, receipt(output.stagingPath), evidence);
  await commitStrictSdrCandidateHeldPair(pair);
}

async function resolveAndRegister(
  pair: StrictSdrCandidateHeldPair,
  slot: Slot,
  finalizer: () => Promise<void>,
): Promise<void> {
  const output = strictSdrCandidateOutputPublication(pair);
  const binding = strictSdrCandidateTerminalBinding(pair);
  await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
    const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, binding.outputPath)!;
    consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding);
    expect(slot.resolve(rendererBinding)).toBe(pair);
    slot.register(pair, finalizer);
  });
}

describe.runIf(process.platform === "linux")("strict-SDR three-slot named Core pair adapters", () => {
  it("runs each literal finalizer before its workspace closes", async () => {
    await withFixture(async (root, anchor) => {
      for (const slot of slots) {
        const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
        await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
          const pair = await openStrictSdrCandidateHeldPair(workspace);
          let calls = 0;
          await resolveAndRegister(pair, slot, async () => {
            calls += 1;
            expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(false);
          });
          await abortStrictSdrCandidateHeldPair(pair);
          expect(calls).toBe(1);
          expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
        });
      }
    });
  });

  it("gives only the matching active named observation one descriptor callback", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        await resolveAndRegister(pair, slots[0]!, async () => undefined);
        await commit(pair);
        let expired: StrictSdrCandidateHeldPairObservation | undefined;
        await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          expired = observation;
          expect(matchesCurrentStrictSdrCandidateHeldPairObservation(pair, observation)).toBe(true);
          await expect(observation.withF2bScreenCommittedMediaDescriptor(async () => undefined)).rejects.toThrow(/does not match/i);
          await observation.withThreeSlotF2aCommittedMediaDescriptor(async (input) => {
            expect(input.fd).toBeGreaterThan(2);
            expect(input.media).toEqual({ sha256, byteLength: media.byteLength });
          });
        });
        await expect(expired!.withThreeSlotF2aCommittedMediaDescriptor(async () => undefined)).rejects.toThrow(/expired/i);
      });
    });
  });

  it("drains an unawaited rejected F2b descriptor callback before finalizer and workspace closure", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const entered = deferred(), release = deferred(), failure = new Error("deferred F2b descriptor failure");
        let finalizerCalls = 0;
        await resolveAndRegister(pair, slots[1]!, async () => { finalizerCalls += 1; });
        await commit(pair);
        const consumed = consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          void observation.withF2bScreenCommittedMediaDescriptor(async () => {
            entered.resolve();
            await release.promise;
            throw failure;
          });
        });
        await entered.promise;
        expect(finalizerCalls).toBe(0);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(false);
        release.resolve();
        await expect(consumed).rejects.toBe(failure);
        expect(finalizerCalls).toBe(1);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
      });
    });
  });

  it("refuses forged, wrong-pair, and expired literal binding resolution", async () => {
    await withFixture(async (root, anchor) => {
      const otherWorkspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      let otherPair: StrictSdrCandidateHeldPair | undefined;
      let otherBinding: StrictSdrCandidateHeldPairRendererBinding | undefined;
      await withStrictSdrCandidateHeldWorkspace(otherWorkspace, PREPARATION, async () => {
        otherPair = await openStrictSdrCandidateHeldPair(otherWorkspace);
        await withStrictSdrCandidateHeldPairRendering(otherPair, PREPARATION, async () => {
          const binding = strictSdrCandidateTerminalBinding(otherPair!);
          otherBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(strictSdrCandidateOutputPublication(otherPair!), PREPARATION, binding.outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(otherBinding);
        });
      });

      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          expect(() => strictSdrCandidateHeldPairForConsumedF2bScreenRendererBinding(Object.freeze({}) as StrictSdrCandidateHeldPairRendererBinding)).toThrow(/forged/i);
          expect(() => strictSdrCandidateHeldPairForConsumedF2bScreenRendererBinding(otherBinding!)).toThrow(/mismatched/i);
        });
        await abortStrictSdrCandidateHeldPair(pair);
      });
      await withStrictSdrCandidateHeldWorkspace(otherWorkspace, PREPARATION, async () => {
        await expect(Promise.resolve().then(() => strictSdrCandidateHeldPairForConsumedF2bScreenRendererBinding(otherBinding!))).rejects.toThrow(/expired/i);
        await abortStrictSdrCandidateHeldPair(otherPair!);
      });
    });
  });
});
