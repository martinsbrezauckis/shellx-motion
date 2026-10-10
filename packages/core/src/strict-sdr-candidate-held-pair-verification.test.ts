import { createHash } from "node:crypto";
import { mkdtemp, open, readlink, readdir, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor, type TrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import {
  abortStrictSdrCandidateHeldPair,
  claimCurrentStrictSdrCandidateHeldPairRendererBinding,
  commitStrictSdrCandidateHeldPair,
  consumeStrictSdrCandidateHeldPairCompletion,
  consumeCurrentStrictSdrCandidateHeldPairRendererBinding,
  consumeStrictSdrCandidateHeldPair,
  createStrictSdrCandidateHeldWorkspace,
  openStrictSdrCandidateHeldPair,
  recordStrictSdrCandidateHeldMediaStage,
  registerStrictSdrCandidateF2aFinalizer,
  stageStrictSdrCandidateFinalReceipt,
  strictSdrCandidateHeldPairForConsumedRendererBinding,
  strictSdrCandidateOutputPublication,
  strictSdrCandidateTerminalBinding,
  takeStrictSdrCandidateHeldPairCompletion,
  withStrictSdrCandidateHeldPairRendering,
  withStrictSdrCandidateHeldWorkspace,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldPairObservation,
} from "./strict-sdr-candidate-held-pair";
import { strictSdrCandidateHeldPairState, strictSdrCandidateHeldWorkspaceState } from "./strict-sdr-candidate-held-workspace";
import type { OperationReceipt } from "./types";

const PREPARATION = "a".repeat(64);
const bytes = Buffer.from("strict SDR held pair bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");

async function withFixture<T>(operation: (root: string, anchor: TrustedWorkspaceAnchor) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-strict-sdr-verification-"));
  try {
    const anchor = await createTrustedWorkspaceAnchor(root);
    return await withTrustedWorkspaceAnchor(anchor, async () => await operation(root, anchor));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function fixtureRootFdTargets(root: string): Promise<readonly string[]> {
  const entries = await readdir("/proc/self/fd");
  const targets = await Promise.all(entries.filter((entry) => /^\d+$/u.test(entry)).map(async (entry) => {
    const target = await readlink(`/proc/self/fd/${entry}`).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    return target === root || target?.startsWith(`${root}/`) ? `${entry}:${target}` : undefined;
  }));
  return targets.filter((target): target is string => target !== undefined).sort();
}

function strictReceipt(path: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: "strict-sdr-candidate-pair-verification", operation: "render.final", status: "passed", packageId: "pkg_strict_sdr",
    inputHashes: {
      motion: "b".repeat(64), "linear-srgb-sdr-route": "c".repeat(64), "linear-srgb-sdr-preparation": PREPARATION,
      "linear-srgb-sdr-ffmpeg-contract": "d".repeat(64), "linear-srgb-sdr-webgpu-producer": "e".repeat(64), "linear-srgb-sdr-producer-frame": "f".repeat(64),
      "linear-srgb-sdr-comparison-policy": "0".repeat(64), "linear-srgb-sdr-execution": "1".repeat(64)
    },
    createdAt: "2026-09-08T00:00:00.000Z", lane: "ffmpeg",
    output: {
      path, sha256, byteLength: bytes.byteLength,
      frameTransport: { schema: "shellx-motion/linear-srgb-sdr-final-transport@2", privateOutputAdoption: { schema: "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1", verifiedOutput: { sha256, byteLength: bytes.byteLength }, privatePublicationStage: { sha256, byteLength: bytes.byteLength } } }
    },
    warnings: []
  };
}

async function commit(pair: StrictSdrCandidateHeldPair): Promise<Readonly<{ outputPath: string; receiptPath: string }>> {
  const output = strictSdrCandidateOutputPublication(pair);
  const binding = strictSdrCandidateTerminalBinding(pair);
  const evidence = await output.writePrivateFile(bytes, { label: "strict-SDR fresh pair verification media", maxBytes: 256 * 1024 * 1024 });
  if (strictSdrCandidateHeldPairState(pair).rendererClaimed) strictSdrCandidateHeldPairState(pair).adoptedStage = evidence;
  await stageStrictSdrCandidateFinalReceipt(pair, strictReceipt(output.stagingPath), evidence);
  await commitStrictSdrCandidateHeldPair(pair);
  return binding;
}

function changedBytes(value: Buffer): Buffer {
  const changed = Buffer.from(value), first = changed.at(0);
  if (first === undefined) throw new Error("strict-SDR verification test bytes unexpectedly empty");
  changed[0] = first === 0x7b ? 0x5b : 0x7b;
  return changed;
}

function expectRetainedMutation(error: unknown): void {
  const reasons = error instanceof AggregateError ? error.errors : [error];
  expect(reasons.some((reason) => reason instanceof Error && /retained bounded identity|retained pair changed|exact single-link inode capture/i.test(reason.message))).toBe(true);
}

function errorReasons(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors : [error];
}

describe.runIf(process.platform === "linux")("strict-SDR candidate held pair fresh verification", () => {
  it("issues one opaque Core completion only after successful retained capture and cleanup", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        expect(() => takeStrictSdrCandidateHeldPairCompletion(pair)).toThrow(/no unclaimed Core completion/i);
        await commit(pair);
        await consumeStrictSdrCandidateHeldPair(pair, async () => "evaluated");
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
        const token = takeStrictSdrCandidateHeldPairCompletion(pair);
        expect(() => takeStrictSdrCandidateHeldPairCompletion(pair)).toThrow(/no unclaimed Core completion/i);
        expect(() => consumeStrictSdrCandidateHeldPairCompletion(pair, JSON.parse(JSON.stringify(token)))).toThrow(/forged/i);
        consumeStrictSdrCandidateHeldPairCompletion(pair, token);
        expect(() => consumeStrictSdrCandidateHeldPairCompletion(pair, token)).toThrow(/already consumed/i);
      });
    });
  });

  it("withholds Core completion after an evaluator refusal", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        await commit(pair);
        await expect(consumeStrictSdrCandidateHeldPair(pair, async () => { throw new Error("evaluator refused"); })).rejects.toThrow(/evaluator refused/i);
        expect(() => takeStrictSdrCandidateHeldPairCompletion(pair)).toThrow(/no unclaimed Core completion/i);
      });
    });
  });

  it("withholds Core completion when the named finalizer fails after evaluation", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, strictSdrCandidateTerminalBinding(pair).outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
          expect(strictSdrCandidateHeldPairForConsumedRendererBinding(binding)).toBe(pair);
          registerStrictSdrCandidateF2aFinalizer(pair, async () => { throw new Error("finalizer refused"); });
        });
        await commit(pair);
        await expect(consumeStrictSdrCandidateHeldPair(pair, async () => "evaluated")).rejects.toThrow(/finalizer refused/i);
        expect(() => takeStrictSdrCandidateHeldPairCompletion(pair)).toThrow(/no unclaimed Core completion/i);
      });
    });
  });

  it("refuses a stage verification that finishes after its renderer scope expires", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const verified = await output.writePrivateFile(bytes, { label: "expired renderer stage", maxBytes: 256 * 1024 * 1024 });
        const spy = vi.spyOn(output, "verifyPrivateFile").mockImplementation(async () => { await barrier; return verified; });
        let pending!: Promise<unknown>;
        try {
          await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, () => {
            const binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, strictSdrCandidateTerminalBinding(pair).outputPath)!;
            consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
            pending = recordStrictSdrCandidateHeldMediaStage(binding, output);
          });
          release();
          await expect(pending).rejects.toThrow(/outlived its renderer scope/i);
          expect(strictSdrCandidateHeldPairState(pair).adoptedStage).toBeUndefined();
        } finally {
          release();
          spy.mockRestore();
          await abortStrictSdrCandidateHeldPair(pair);
        }
      });
    });
  });
  it.each(["output", "receipt"] as const)("refuses %s mutation after evaluator return without an evaluator recheck", async (member) => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const binding = await commit(pair);
        const error = await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          if (member === "output") {
            await writeFile(binding.outputPath, changedBytes(bytes));
          } else {
            await writeFile(binding.receiptPath, changedBytes(await observation.readReceipt()));
          }
          return "should refuse";
        }).then(() => undefined, (reason) => reason);
        expectRetainedMutation(error);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
        await expect(consumeStrictSdrCandidateHeldPair(pair, async () => undefined)).rejects.toThrow(/not available/i);
      });
    });
  });

  it("compares final media bytes even when the retained stat facts appear unchanged", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const binding = await commit(pair);
        const frozenStat = await stat(binding.outputPath);
        const probe = await open(binding.outputPath, "r");
        const prototype = Object.getPrototypeOf(probe) as { stat: FileHandle["stat"] };
        const actualStat = prototype.stat;
        await probe.close();
        const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (this: FileHandle) {
          const target = await readlink(`/proc/self/fd/${this.fd}`);
          return target === binding.outputPath ? frozenStat : await actualStat.call(this);
        });
        try {
          const error = await consumeStrictSdrCandidateHeldPair(pair, async () => {
            await writeFile(binding.outputPath, changedBytes(bytes));
          }).then(() => undefined, (reason) => reason);
          expect(errorReasons(error).some((reason) => reason instanceof Error && /public pair bytes changed after the consumer callback/i.test(reason.message))).toBe(true);
          await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
          expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  it("drains a late descriptor callback before the final pair read and closure", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const binding = strictSdrCandidateTerminalBinding(pair);
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, binding.outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding);
          expect(strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding)).toBe(pair);
          registerStrictSdrCandidateF2aFinalizer(pair, async () => undefined);
        });
        await commit(pair);
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        let settled = false;
        const consuming = consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          void observation.withF2aCommittedMediaDescriptor(async () => {
            enter();
            await barrier;
            await writeFile(binding.outputPath, changedBytes(bytes));
          });
        }).then(() => { settled = true; return undefined; }, (reason) => { settled = true; return reason; });
        await entered;
        expect(settled).toBe(false);
        release();
        expectRetainedMutation(await consuming);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
      });
    });
  });

  it("freshly verifies the current retained pair once without exposing receipt bytes", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        await commit(pair);
        let expired: StrictSdrCandidateHeldPairObservation | undefined;
        await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          expired = observation;
          await expect(observation.verifyCurrentPair()).resolves.toBeUndefined();
        });
        await expect(expired!.verifyCurrentPair()).rejects.toThrow(/expired/i);
      });
    });
  });

  it("latches caught and ignored active duplicate verification after the first fresh read", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        await commit(pair);
        const error = await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          const first = observation.verifyCurrentPair();
          await expect(observation.verifyCurrentPair()).rejects.toThrow(/one-shot/i);
          void observation.verifyCurrentPair();
          await first;
        }).then(() => undefined, (reason) => reason);
        expect(errorReasons(error).some((reason) => reason instanceof Error && /one-shot/i.test(reason.message))).toBe(true);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
      });
    });
  });

  it("drains a fresh verification that detects receipt mutation after the cached read", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const binding = await commit(pair);
        const error = await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          await writeFile(binding.receiptPath, changedBytes(await observation.readReceipt()));
          void observation.verifyCurrentPair();
        }).then(() => undefined, (reason) => reason);
        expectRetainedMutation(error);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
      });
    });
  });

  it("drains a fresh verification that detects output mutation after the cached hash", async () => {
    await withFixture(async (root, anchor) => {
      const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
      await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
        const pair = await openStrictSdrCandidateHeldPair(workspace);
        const output = strictSdrCandidateOutputPublication(pair);
        const terminal = strictSdrCandidateTerminalBinding(pair);
        let finalizerCalls = 0;
        let finalizerFdTargets: readonly string[] | undefined;
        await withStrictSdrCandidateHeldPairRendering(pair, PREPARATION, async () => {
          const rendererBinding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(output, PREPARATION, terminal.outputPath)!;
          consumeCurrentStrictSdrCandidateHeldPairRendererBinding(rendererBinding);
          expect(strictSdrCandidateHeldPairForConsumedRendererBinding(rendererBinding)).toBe(pair);
          registerStrictSdrCandidateF2aFinalizer(pair, async () => {
            finalizerCalls += 1;
            finalizerFdTargets = await fixtureRootFdTargets(root);
          });
        });
        const binding = await commit(pair);
        const error = await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
          await expect(observation.hashMedia()).resolves.toEqual({ sha256, byteLength: bytes.byteLength });
          await writeFile(binding.outputPath, changedBytes(bytes));
          void observation.verifyCurrentPair();
        }).then(() => undefined, (reason) => reason);
        expectRetainedMutation(error);
        await expect(fixtureRootFdTargets(root)).resolves.toEqual([]);
        expect(finalizerCalls).toBe(1);
        expect(finalizerFdTargets).toBeDefined();
        expect(finalizerFdTargets!.some((target) => target.includes("/output.mp4"))).toBe(false);
        expect(strictSdrCandidateHeldWorkspaceState(workspace).closed).toBe(true);
      });
    });
  });
});
