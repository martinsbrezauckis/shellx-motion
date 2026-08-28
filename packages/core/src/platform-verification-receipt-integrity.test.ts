import { describe, expect, it } from "vitest";
import {
  platformVerificationCommandContract,
  platformVerificationReceiptSemanticProblems
} from "./platform-verification-receipt-integrity";

function passedHostReceipt(): Record<string, unknown> {
  const commands = platformVerificationCommandContract().map((declared) => ({
    id: declared.id,
    command: declared.command,
    required: declared.required,
    status: "passed",
    durationMs: 1,
    exitCode: 0,
    signal: null
  }));
  for (const id of ["render-hevc:smoke", "render-av1:smoke"]) {
    const command = commands.find((candidate) => candidate.id === id)!;
    command.status = "skipped";
    delete (command as { exitCode?: number }).exitCode;
    Object.assign(command, {
      skipKind: "capability-absent",
      skipReason: `Host encoder inventory reports ${id} unavailable.`
    });
  }
  return {
    schema: "shellx-motion/platform-verification@1",
    status: "passed",
    dryRun: false,
    host: { id: "linux", platform: "linux" },
    toolchain: {
      encoders: {
        status: "passed",
        capabilities: { h264: true, vp9: true, prores: true, hevc: false, av1: false }
      }
    },
    commandSummary: {
      total: commands.length,
      passed: commands.length - 2,
      failed: 0,
      skipped: 2,
      skippedByKind: { "capability-absent": 2 }
    },
    commands
  };
}

function passedAggregateReceipt(): Record<string, unknown> {
  const requiredCommands = platformVerificationCommandContract()
    .filter((command) => command.required)
    .map((command) => command.id);
  return {
    schema: "shellx-motion/platform-verification-aggregate@1",
    status: "passed",
    dryRun: false,
    requiredHosts: ["linux"],
    requiredCommands,
    receipts: [{
      hostId: "linux",
      schemaOk: true,
      ok: true,
      status: "passed",
      dryRun: false,
      requiredCommands: {
        total: requiredCommands.length,
        passed: requiredCommands.length,
        missing: [],
        failed: [],
        capabilitySkipped: [],
        platformInapplicableSkipped: []
      }
    }],
    summary: {
      requiredHostCount: 1,
      satisfiedHostCount: 1,
      missingHosts: [],
      failedHosts: [],
      invalidReceiptCount: 0
    }
  };
}

describe("platform verification receipt semantic integrity", () => {
  it("accepts capability skips only from a successful encoder inventory", () => {
    const receipt = passedHostReceipt();
    expect(platformVerificationReceiptSemanticProblems(receipt)).toEqual([]);

    const encoders = (receipt.toolchain as { encoders: Record<string, unknown> }).encoders;
    encoders.status = "failed";
    encoders.reason = "FFmpeg binary is unavailable";
    expect(platformVerificationReceiptSemanticProblems(receipt)).toContainEqual({
      path: "/commands/render-hevc:smoke/status",
      message: "cannot support a passed platform claim"
    });
  });

  it("does not admit a passed receipt with a failed optional command or incomplete exit facts", () => {
    const receipt = passedHostReceipt();
    const commands = receipt.commands as Array<Record<string, unknown>>;
    const optional = commands.find((command) => command.required === false)!;
    optional.status = "failed";
    optional.exitCode = 1;
    const summary = receipt.commandSummary as Record<string, unknown>;
    summary.passed = (summary.passed as number) - 1;
    summary.failed = 1;
    expect(platformVerificationReceiptSemanticProblems(receipt)).toContainEqual({
      path: "/status",
      message: "cannot pass while a planned command failed"
    });

    optional.status = "passed";
    optional.exitCode = 0;
    delete optional.signal;
    summary.passed = (summary.passed as number) + 1;
    summary.failed = 0;
    expect(platformVerificationReceiptSemanticProblems(receipt)).toContainEqual({
      path: `/commands/${commands.indexOf(optional)}/exitCode`,
      message: "must be zero for a passed command"
    });
  });

  it("requires every aggregate host summary to reconcile the declared command plan", () => {
    const receipt = passedAggregateReceipt();
    expect(platformVerificationReceiptSemanticProblems(receipt)).toEqual([]);

    const entry = (receipt.receipts as Array<Record<string, unknown>>)[0]!;
    entry.requiredCommands = {
      total: 1,
      passed: 1,
      missing: [],
      failed: [],
      capabilitySkipped: [],
      platformInapplicableSkipped: []
    };
    expect(platformVerificationReceiptSemanticProblems(receipt)).toContainEqual({
      path: "/receipts/linux/requiredCommands",
      message: "must reconcile required command evidence"
    });
  });

  it("does not treat a passed aggregate over an empty host set as evidence", () => {
    const receipt = passedAggregateReceipt();
    receipt.requiredHosts = [];
    receipt.receipts = [];
    receipt.summary = {
      requiredHostCount: 0,
      satisfiedHostCount: 0,
      missingHosts: [],
      failedHosts: [],
      invalidReceiptCount: 0
    };
    expect(platformVerificationReceiptSemanticProblems(receipt)).toContainEqual({
      path: "/requiredHosts",
      message: "must identify at least one host for a passed aggregate"
    });
  });

  it("does not let an aggregate misclassify an ordinary command as an allowed skip", () => {
    const receipt = passedAggregateReceipt();
    const requiredIds = receipt.requiredCommands as string[];
    const entry = (receipt.receipts as Array<Record<string, unknown>>)[0]!;
    entry.requiredCommands = {
      total: requiredIds.length,
      passed: requiredIds.length - 1,
      missing: [],
      failed: [],
      capabilitySkipped: [{ id: "install" }],
      platformInapplicableSkipped: []
    };
    expect(platformVerificationReceiptSemanticProblems(receipt)).toContainEqual({
      path: "/receipts/linux/requiredCommands",
      message: "must reconcile required command evidence"
    });
  });
});
