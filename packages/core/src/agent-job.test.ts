import { describe, expect, it } from "vitest";
import {
  createAgentAuthoringJob,
  createAgentRevisionPlan,
  withAgentAuthoringJobOutputPaths
} from "./agent-job";

const PLAN = {
  topic: "Template launch video",
  actionId: "motion.template.plan",
  debugCommands: ["motion.template.plan", "motion.template.apply", "motion.render.final"],
  verify: ["render MP4", "read receipts"],
  cautions: ["review before mutation"]
};

describe("agent authoring jobs", () => {
  it("records brief-to-plan state with asset routes, approvals, outputs, and event replay data", () => {
    const job = createAgentAuthoringJob({
      jobId: "prompt-001",
      packageId: "pkg_launch",
      brief: "Create a product launch video with generated hero image",
      status: "succeeded",
      agentId: "codex",
      createdAt: "2026-07-06T12:00:00.000Z",
      plan: PLAN,
      executeAgentCommands: true,
      outputPaths: {
        receiptsRoot: "/tmp/receipts",
        promptReceiptPath: "/tmp/receipts/prompt.receipt.json",
        packageRoot: "/tmp/pkg_launch"
      },
      executedCommands: [
        { command: "motion.template.apply", ok: true, receiptId: "template-apply-1" },
        { command: "motion.render.final", ok: true, receiptId: "render-1" }
      ]
    });

    expect(job).toMatchObject({
      schema: "shellx-motion/agent-authoring-job@1",
      jobId: "prompt-001",
      packageId: "pkg_launch",
      brief: "Create a product launch video with generated hero image",
      status: "succeeded",
      agentId: "codex",
      plan: PLAN,
      mutationPolicy: {
        mode: "debug_commands_allowed",
        reason: "User enabled execution of agent-proposed debug commands."
      },
      outputPaths: {
        receiptsRoot: "/tmp/receipts",
        promptReceiptPath: "/tmp/receipts/prompt.receipt.json",
        packageRoot: "/tmp/pkg_launch"
      }
    });
    expect(job.assetRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex-authoring", route: "codex-subscription-cli", role: "authoring", status: "used" }),
      expect.objectContaining({ id: "grok-generated-assets", route: "grok-build-cli", role: "image", status: "planned" })
    ]));
    expect(job.proposedFileChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "motion.template.apply", mutation: "planned" }),
      expect.objectContaining({ command: "motion.render.final", mutation: "output" })
    ]));
    expect(job.requiredApprovals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "review-agent-plan", status: "satisfied" }),
      expect.objectContaining({ id: "execute-debug-commands", status: "satisfied" })
    ]));
    expect(job.eventLog.map((event) => event.type)).toEqual([
      "brief.received",
      "plan.created",
      "agent.completed",
      "commands.completed"
    ]);
  });

  it("marks unavailable agent jobs as failed no-mutation work", () => {
    const job = createAgentAuthoringJob({
      jobId: "prompt-failed",
      packageId: "pkg_launch",
      brief: "Render this package",
      status: "failed",
      agentId: "codex",
      createdAt: "2026-07-06T12:05:00.000Z",
      plan: PLAN,
      error: {
        code: "agent_unavailable",
        message: "codex is unavailable. No fallback agent was executed."
      }
    });

    expect(job).toMatchObject({
      status: "failed",
      mutationPolicy: {
        mode: "no_mutation",
        reason: "Agent job failed before any mutation-capable command execution."
      },
      failure: {
        code: "agent_unavailable",
        message: "codex is unavailable. No fallback agent was executed."
      }
    });
    expect(job.requiredApprovals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agent-availability", status: "blocked" })
    ]));
    expect(job.eventLog.at(-1)).toMatchObject({
      seq: 3,
      type: "agent.failed",
      message: "codex is unavailable. No fallback agent was executed."
    });
  });

  it("can add host output paths after the prompt receipt is written", () => {
    const job = createAgentAuthoringJob({
      jobId: "prompt-paths",
      packageId: "pkg_launch",
      brief: "Preview package",
      status: "running",
      createdAt: "2026-07-06T12:10:00.000Z",
      plan: PLAN
    });

    expect(withAgentAuthoringJobOutputPaths(job, {
      promptReceiptPath: "/tmp/prompt.receipt.json",
      agentReceiptPath: "/tmp/agent.receipt.json"
    })).toMatchObject({
      outputPaths: {
        promptReceiptPath: "/tmp/prompt.receipt.json",
        agentReceiptPath: "/tmp/agent.receipt.json"
      }
    });
  });

  it("creates a critique/revise plan from failed quality and contact-sheet evidence before mutation", () => {
    const plan = createAgentRevisionPlan({
      planId: "revision-001",
      packageId: "pkg_launch",
      templateId: "template_launch",
      sourceJobId: "prompt-001",
      createdAt: "2026-07-06T12:15:00.000Z",
      qualityReceipts: [
        {
          schema: "shellx-motion/receipt@1",
          id: "quality-blank",
          operation: "quality.check",
          status: "failed",
          packageId: "pkg_launch",
          inputHashes: { media: "a".repeat(64) },
          createdAt: "2026-07-06T12:14:00.000Z",
          lane: "quality",
          output: {
            quality: { blankFrames: 2, minEdgePixels: 0 },
            checks: [{ id: "mid", status: "failed", message: "Frame is blank." }]
          },
          warnings: ["Extracted frame is blank or visually empty."]
        }
      ],
      contactSheet: {
        path: "/tmp/contact-sheet.png",
        status: "needs_revision",
        notes: ["Headline is too close to safe-area edge."]
      }
    });

    expect(plan).toMatchObject({
      schema: "shellx-motion/agent-revision-plan@1",
      planId: "revision-001",
      packageId: "pkg_launch",
      templateId: "template_launch",
      sourceJobId: "prompt-001",
      status: "needs_revision",
      mutationPolicy: {
        mode: "proposal_only",
        reason: "Revision plan must be reviewed before mutating packages or host projects."
      },
      evidence: {
        contactSheet: {
          path: "/tmp/contact-sheet.png",
          status: "needs_revision"
        },
        qualityReceiptIds: ["quality-blank"]
      }
    });
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "quality_failed", receiptId: "quality-blank" }),
      expect.objectContaining({ code: "blank_frames", receiptId: "quality-blank" }),
      expect.objectContaining({ code: "contact_sheet_needs_revision", message: "Headline is too close to safe-area edge." })
    ]));
    expect(plan.proposedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: "motion.prompt.run",
        target: { packageId: "pkg_launch", templateId: "template_launch" },
        reason: expect.stringContaining("quality")
      })
    ]));
  });

  it("accepts clean critique evidence without proposing mutation", () => {
    const plan = createAgentRevisionPlan({
      planId: "revision-clean",
      packageId: "pkg_launch",
      createdAt: "2026-07-06T12:20:00.000Z",
      qualityReceipts: [
        {
          schema: "shellx-motion/receipt@1",
          id: "quality-pass",
          operation: "quality.check",
          status: "passed",
          packageId: "pkg_launch",
          inputHashes: { media: "b".repeat(64) },
          createdAt: "2026-07-06T12:19:00.000Z",
          lane: "quality",
          output: { quality: { blankFrames: 0, minEdgePixels: 150 } },
          warnings: []
        }
      ],
      contactSheet: { path: "/tmp/contact-sheet.png", status: "approved" }
    });

    expect(plan).toMatchObject({
      status: "accepted",
      findings: [],
      proposedActions: []
    });
  });
});
