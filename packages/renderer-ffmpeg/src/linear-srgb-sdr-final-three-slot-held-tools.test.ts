import { afterEach, describe, expect, it } from "vitest";
import {
  borrowStrictSdrCandidateF2bScreenControlsThreeSlotTools,
  borrowStrictSdrCandidateF2bScreenThreeSlotTools,
  borrowStrictSdrCandidateThreeSlotF2aTools,
  closeStrictSdrCandidateThreeSlotHeldTools,
  markStrictSdrCandidateF2bScreenControlsThreeSlotToolsFailure,
  markStrictSdrCandidateF2bScreenThreeSlotToolsFailure,
  markStrictSdrCandidateThreeSlotF2aToolsFailure,
  openStrictSdrCandidateThreeSlotHeldTools,
  settleStrictSdrCandidateF2bScreenControlsThreeSlotTools,
  settleStrictSdrCandidateF2bScreenThreeSlotTools,
  settleStrictSdrCandidateThreeSlotF2aTools,
  type StrictSdrCandidateThreeSlotHeldTools,
} from "./linear-srgb-sdr-final-three-slot-held-tools.js";

const originalFfmpeg = process.env.SHELLX_MOTION_FFMPEG;
const originalFfprobe = process.env.SHELLX_MOTION_FFPROBE;
const opened: StrictSdrCandidateThreeSlotHeldTools[] = [];

afterEach(async () => {
  if (originalFfmpeg === undefined) delete process.env.SHELLX_MOTION_FFMPEG;
  else process.env.SHELLX_MOTION_FFMPEG = originalFfmpeg;
  if (originalFfprobe === undefined) delete process.env.SHELLX_MOTION_FFPROBE;
  else process.env.SHELLX_MOTION_FFPROBE = originalFfprobe;
  while (opened.length > 0) {
    const tools = opened.pop()!;
    await closeOrRefuse(tools);
  }
});

describe.skipIf(process.platform !== "linux")("three-slot shared held-tool owner", () => {
  it("permits only the literal serial borrower sequence and reports completion once", async () => {
    const tools = await openTools();
    await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).rejects.toThrow(/all slots complete or a refused slot settles/i);

    const f2a = await borrowStrictSdrCandidateThreeSlotF2aTools(tools);
    await expect(borrowStrictSdrCandidateF2bScreenThreeSlotTools(tools)).rejects.toThrow(/out-of-order/i);
    settleStrictSdrCandidateThreeSlotF2aTools(tools, true);

    const screen = await borrowStrictSdrCandidateF2bScreenThreeSlotTools(tools);
    expect(screen.ffmpeg.handle.fd).toBe(f2a.ffmpeg.handle.fd);
    expect(screen.ffprobe.handle.fd).toBe(f2a.ffprobe.handle.fd);
    settleStrictSdrCandidateF2bScreenThreeSlotTools(tools, true);
    await borrowStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools);
    settleStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools, true);

    await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).resolves.toMatchObject({
      state: "complete", descriptorsClosed: true,
    });
    opened.pop();
  });

  it("reserves a borrow before asynchronous descriptor validation", async () => {
    const tools = await openTools();
    const first = borrowStrictSdrCandidateThreeSlotF2aTools(tools);
    await expect(borrowStrictSdrCandidateThreeSlotF2aTools(tools)).rejects.toThrow(/out-of-order|duplicate/i);
    await expect(first).resolves.toMatchObject({ ffmpeg: expect.any(Object), ffprobe: expect.any(Object) });
    markStrictSdrCandidateThreeSlotF2aToolsFailure(tools);
    settleStrictSdrCandidateThreeSlotF2aTools(tools, false);
    await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).resolves.toMatchObject({ state: "closed-after-refusal" });
    opened.pop();
  });

  it("latches a failed tool revalidation before any later borrow", async () => {
    const tools = await openTools();
    process.env.SHELLX_MOTION_FFMPEG = "/bin/true";
    await expect(borrowStrictSdrCandidateThreeSlotF2aTools(tools)).rejects.toThrow(/no longer resolves/i);
    process.env.SHELLX_MOTION_FFMPEG = process.execPath;
    await expect(borrowStrictSdrCandidateF2bScreenThreeSlotTools(tools)).rejects.toThrow(/out-of-order|failed/i);
    await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).resolves.toMatchObject({ state: "closed-after-refusal" });
    opened.pop();
  });

  it("latches a failed slot until outer cleanup and refuses every later slot", async () => {
    const tools = await openTools();
    await borrowStrictSdrCandidateThreeSlotF2aTools(tools);
    markStrictSdrCandidateThreeSlotF2aToolsFailure(tools);
    settleStrictSdrCandidateThreeSlotF2aTools(tools, true);

    await expect(borrowStrictSdrCandidateF2bScreenThreeSlotTools(tools)).rejects.toThrow(/out-of-order|failed/i);
    await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).resolves.toMatchObject({
      state: "closed-after-refusal", descriptorsClosed: true,
    });
    opened.pop();
  });

  it("reserves terminal closure before asynchronous descriptor teardown", async () => {
    const tools = await openTools();
    await borrowStrictSdrCandidateThreeSlotF2aTools(tools);
    settleStrictSdrCandidateThreeSlotF2aTools(tools, true);
    await borrowStrictSdrCandidateF2bScreenThreeSlotTools(tools);
    settleStrictSdrCandidateF2bScreenThreeSlotTools(tools, true);
    await borrowStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools);
    settleStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools, true);
    const first = closeStrictSdrCandidateThreeSlotHeldTools(tools);
    await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).rejects.toThrow(/close is already in progress/i);
    await expect(first).resolves.toMatchObject({ state: "complete" });
    opened.pop();
  });
});

async function openTools(): Promise<StrictSdrCandidateThreeSlotHeldTools> {
  process.env.SHELLX_MOTION_FFMPEG = process.execPath;
  process.env.SHELLX_MOTION_FFPROBE = process.execPath;
  const tools = await openStrictSdrCandidateThreeSlotHeldTools();
  opened.push(tools);
  return tools;
}

async function closeOrRefuse(tools: StrictSdrCandidateThreeSlotHeldTools): Promise<void> {
  for (const fail of [markStrictSdrCandidateThreeSlotF2aToolsFailure, markStrictSdrCandidateF2bScreenThreeSlotToolsFailure, markStrictSdrCandidateF2bScreenControlsThreeSlotToolsFailure]) {
    try {
      fail(tools);
      if (fail === markStrictSdrCandidateThreeSlotF2aToolsFailure) settleStrictSdrCandidateThreeSlotF2aTools(tools, false);
      else if (fail === markStrictSdrCandidateF2bScreenThreeSlotToolsFailure) settleStrictSdrCandidateF2bScreenThreeSlotTools(tools, false);
      else settleStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools, false);
      break;
    } catch { /* This literal slot is not the active test borrow. */ }
  }
  await closeStrictSdrCandidateThreeSlotHeldTools(tools).catch(() => undefined);
}
