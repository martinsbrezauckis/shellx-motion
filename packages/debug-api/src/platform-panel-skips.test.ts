/**
 * A deliberately SKIPPED platform command must not sink an otherwise passing host.
 *
 * Role: pins `motion.platform.verification.panel` to the vocabulary
 * `scripts/platform-verify.mjs` actually writes. That script records a host whose FFmpeg does not
 * advertise a modern encoder as:
 *
 *     status: "skipped", skipKind: "capability-absent"
 *
 * and deliberately leaves the host receipt `passed`, because the host never claimed the codec.
 * `--require-modern-codecs` upgrades the same condition to `status: "failed"` for a release that
 * demands it. Both behaviours are intentional.
 *
 * The panel must not classify every command that is not `passed` as a
 * failure, so an intentional capability skip produced `visible status: failed` and
 * `satisfiedHosts: []` from a schema-valid PASSING receipt. That is the same `!== "passed"` shape as
 * the batch-resume and receipt-status defects fixed in this release -- a binary test applied to a
 * vocabulary with six values.
 *
 * Dependencies: `dispatchDebugCommand` from this package. Primary caller: `pnpm test` in
 * `packages/debug-api`.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

/** A host receipt that PASSES, with one required command skipped for an absent capability. */
function hostReceiptWithCapabilitySkip(): Record<string, unknown> {
  return {
    schema: "shellx-motion/platform-verification@1",
    status: "passed",
    dryRun: false,
    host: { id: "linux", platform: "linux", arch: "x64" },
    hostMatrix: { status: "satisfied", required: ["linux"], satisfied: ["linux"], missing: [] },
    commands: [
      { id: "typecheck", required: true, status: "passed" },
      {
        id: "render-hevc-smoke",
        required: true,
        status: "skipped",
        skipKind: "capability-absent",
        skipReason: "Host FFmpeg does not advertise encoder capability: hevc_nvenc.",
        missingEncoders: ["hevc_nvenc"]
      }
    ]
  };
}

async function panelFor(receipt: Record<string, unknown>): Promise<Record<string, any>> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-platform-panel-"));
  const receiptsRoot = join(root, "receipts");
  await mkdir(receiptsRoot, { recursive: true });
  await writeFile(join(receiptsRoot, "linux.platform.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  try {
    const result = await dispatchDebugCommand(
      "motion.platform.verification.panel",
      { receiptsRoot, requiredHosts: ["linux"] },
      { tier: "read_motion" }
    );
    expect(result.ok, `panel failed: ${JSON.stringify(result, null, 2)}`).toBe(true);
    return (result as { result: Record<string, any> }).result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("platform verification panel", () => {
  it("keeps a passing host satisfied when a required command is skipped for an absent capability", async () => {
    const panel = await panelFor(hostReceiptWithCapabilitySkip());

    expect(panel.satisfiedHosts, "an intentional capability skip must not unsatisfy the host").toContain("linux");
    expect(panel.failedHosts, "a skip must not show the operator a failed platform").toEqual([]);
    expect(panel.failedHosts ?? [], "a skip is not a failure").not.toContain("linux");
    expect(panel.missingHosts ?? [], "the host reported; it is not missing").not.toContain("linux");

    const summary = (panel.hostReceipts as Array<Record<string, any>>).find((entry) => entry.hostId === "linux");
    expect(summary?.failedCommandCount, "the skipped command must not be counted as failed").toBe(0);
    expect(summary?.requiredFailedCommandCount).toBe(0);
    // Reported rather than hidden: an operator must still be able to see WHAT was skipped.
    expect(summary?.skippedCommandCount).toBe(1);
    expect(summary?.skippedCommandIds).toEqual(["render-hevc-smoke"]);
  });

  it("still fails the host when the same capability gap is recorded as a failure", async () => {
    // `--require-modern-codecs` writes `status: "failed"` for the identical condition. The panel must
    // distinguish the two, or the flag that exists to make codecs mandatory would mean nothing.
    const receipt = hostReceiptWithCapabilitySkip();
    const commands = receipt.commands as Array<Record<string, unknown>>;
    commands[1] = { ...commands[1], status: "failed", skipKind: "capability-absent" };
    receipt.status = "failed";

    const panel = await panelFor(receipt);

    expect(panel.satisfiedHosts ?? []).not.toContain("linux");
    const summary = (panel.hostReceipts as Array<Record<string, any>>).find((entry) => entry.hostId === "linux");
    expect(summary?.requiredFailedCommandCount).toBe(1);
    expect(summary?.skippedCommandCount).toBe(0);
  });

  it("treats an unrecognised command status as a failure rather than a pass", async () => {
    // Fail-closed on purpose: enumerating only the failure statuses would make any status added later
    // count silently as success, which is the dangerous direction for a gate that decides whether a
    // platform is verified.
    const receipt = hostReceiptWithCapabilitySkip();
    const commands = receipt.commands as Array<Record<string, unknown>>;
    commands[1] = { id: "render-hevc-smoke", required: true, status: "something-new" };

    const panel = await panelFor(receipt);

    const summary = (panel.hostReceipts as Array<Record<string, any>>).find((entry) => entry.hostId === "linux");
    expect(summary?.failedCommandCount).toBe(1);
    expect(summary?.skippedCommandCount).toBe(0);
  });
});
