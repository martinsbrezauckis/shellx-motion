/**
 * A caller may not choose where host receipts land.
 *
 * The host receipt writer is `mkdir(receiptsRoot, { recursive: true })` followed by a
 * `<id>.receipt.json` write. `receiptsRoot` is a declared argument on `motion.prompt.run` and on
 * the three timeline control commands, all of which sit at `draft_motion` — tier 2 of 6, below
 * every tier that grants writes. Unfenced, that argument is a `mkdir -p` of any path plus a file
 * drop whose body embeds caller-influenced text, outside every declared artifact root.
 *
 * `motion.prompt.run` reaches the writer even on its FAILURE path (`agent_unavailable`), so the
 * primitive does not need a working agent CLI; that is the case exercised here.
 *
 * The assertions are on the writer spy, not on the refusal wording: "no write was attempted
 * outside the host's receipts root" is the property, and it must survive message rewrites.
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { dispatchAgentPromptRunCommand } from "./agent-prompt-run.js";
import { dispatchTimelineControlCommand, readTimelineControlState, writeTimelineControlState } from "./timeline-controls.js";

const HOST_RECEIPTS_ROOT = "/host/receipts";
const ATTACKER_RECEIPTS_ROOT = "/home/victim/.config/autostart";

interface ReceiptWrite { root: string; id: string }

function recordingReceiptWriter(writes: ReceiptWrite[]): (root: string, receipt: OperationReceipt) => Promise<string> {
  return async (root, receipt) => {
    writes.push({ root, id: receipt.id });
    return join(root, `${receipt.id}.receipt.json`);
  };
}

/** Containment stub with the same contract as the host's realpath-based check in index.ts. */
async function isPathInsideTrustedRoot(root: string, candidate: string): Promise<boolean> {
  return candidate === root || candidate.startsWith(`${root}/`);
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A throwaway copy of a real package: the control-state ports below hash files off disk. */
async function clonedPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-receipts-root-trust-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await cp("../../fixtures/packages/keyframed-lower-third", root, { recursive: true });
  return root;
}

/**
 * The real control-state ports, so only the receipts destination is under test. `writeReceipt` is
 * the spy: it stands in for the host writer that does `mkdir -p` on whatever root it is handed.
 */
function timelineServices(writes: ReceiptWrite[]): Parameters<typeof dispatchTimelineControlCommand>[2] {
  return {
    receiptsRoot: HOST_RECEIPTS_ROOT,
    isPathInsideTrustedRoot,
    packageLoader: loadMotionPackage,
    readTimelineControls: readTimelineControlState,
    writeTimelineControls: writeTimelineControlState,
    writeReceipt: recordingReceiptWriter(writes)
  };
}

describe("caller-supplied receipts roots", () => {
  it("refuses motion.prompt.run receiptsRoot outside the host receipts root, including on the agent-unavailable path", async () => {
    const writes: ReceiptWrite[] = [];

    const result = await dispatchAgentPromptRunCommand(
      "motion.prompt.run",
      { request: "hello", receiptsRoot: ATTACKER_RECEIPTS_ROOT },
      {
        tier: "draft_motion",
        receiptsRoot: HOST_RECEIPTS_ROOT,
        isPathInsideTrustedRoot,
        writeReceipt: recordingReceiptWriter(writes)
      }
    );

    expect(writes).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_args", detail: { argument: "receiptsRoot", resolvedBy: "host_operator" } }
    });
  });

  it("refuses motion.timeline.playhead.set receiptsRoot outside the host receipts root", async () => {
    const writes: ReceiptWrite[] = [];
    const packageRoot = await clonedPackage();

    const result = await dispatchTimelineControlCommand(
      "motion.timeline.playhead.set",
      { packageRoot, playheadMs: 100, receiptsRoot: ATTACKER_RECEIPTS_ROOT },
      timelineServices(writes)
    );

    expect(writes).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_args", detail: { argument: "receiptsRoot", resolvedBy: "host_operator" } }
    });
  });

  it("refuses a caller receiptsRoot when the host configured none", async () => {
    // No host receipts root means the host never nominated a receipts location, so there is nothing
    // for the argument to be inside. Failing closed keeps "unconfigured" from meaning "anywhere".
    const writes: ReceiptWrite[] = [];

    const result = await dispatchAgentPromptRunCommand(
      "motion.prompt.run",
      { request: "hello", receiptsRoot: ATTACKER_RECEIPTS_ROOT },
      { tier: "draft_motion", isPathInsideTrustedRoot, writeReceipt: recordingReceiptWriter(writes) }
    );

    expect(writes).toEqual([]);
    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
  });

  it.runIf(process.platform === "linux")("still accepts a caller receiptsRoot nested inside the host receipts root", async () => {
    // The fence bounds the argument instead of removing it: sub-roots stay usable, which is what
    // the batch and quality lanes rely on when they group receipts per job.
    const writes: ReceiptWrite[] = [];
    const nested = `${HOST_RECEIPTS_ROOT}/prompt-run`;
    const packageRoot = await clonedPackage();

    const result = await dispatchTimelineControlCommand(
      "motion.timeline.playhead.set",
      { packageRoot, playheadMs: 100, receiptsRoot: nested },
      timelineServices(writes)
    );

    expect(result).toMatchObject({ ok: true });
    expect(writes).toEqual([{ root: nested, id: expect.stringContaining("timeline-playhead-") }]);
  });

  it.runIf(process.platform === "linux")("keeps writing to the host receipts root when the caller names none", async () => {
    const writes: ReceiptWrite[] = [];
    const packageRoot = await clonedPackage();

    const result = await dispatchTimelineControlCommand(
      "motion.timeline.playhead.set",
      { packageRoot, playheadMs: 100 },
      timelineServices(writes)
    );

    expect(result).toMatchObject({ ok: true });
    expect(writes).toEqual([{ root: HOST_RECEIPTS_ROOT, id: expect.stringContaining("timeline-playhead-") }]);
  });
});
