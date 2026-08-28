import { describe, expect, it } from "vitest";
import {
  RAW_PROMPT_REDACTION_WARNING_PREFIX,
  redactExpiredRawPrompt,
  runMotionPrompt,
  type MotionPromptRuntime,
  type PromptRunReceipt
} from "./index";
import { createFakePromptRuntime } from "./index.test-support";
describe("Motion prompt workflow", () => {
  it("plans a prompt, runs the selected local agent, and records debug command evidence", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-001",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-06-29T20:35:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "make the title blue and preview it",
      tier: "edit_motion",
      agentId: "fake",
      runtime,
      packageId: "lower-third",
      cwd: "/workspace",
      now: () => "2026-06-29T20:35:30.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual([
      {
        agentId: "fake",
        prompt: expect.stringContaining("make the title blue and preview it"),
        packageId: "lower-third",
        cwd: "/workspace",
        permission: "edit_motion"
      }
    ]);
    expect(result.plan.steps.map((step) => step.call)).toEqual([
      "motion.state",
      "motion.timeline.layer.style.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect(result.receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      id: expect.stringMatching(/^prompt-/),
      operation: "prompt.run",
      status: "passed",
      packageId: "lower-third",
      createdAt: "2026-06-29T20:35:30.000Z",
      lane: "agent",
      output: {
        agentReceiptId: "agent-001",
        requestSummary: expect.stringContaining("motion.timeline.layer.style.set"),
        requestSummaryTruncated: false,
        promptRetention: {
          mode: "summary_only",
          rawRequestRetained: false,
          summaryRedacted: true,
          summaryMaxBytes: 512
        },
        debugCommands: ["motion.state", "motion.timeline.layer.style.set", "motion.preview.frame", "motion.receipts.read"],
        authoringJob: expect.objectContaining({
          schema: "shellx-motion/agent-authoring-job@1",
          brief: expect.stringContaining("motion.timeline.layer.style.set"),
          packageId: "lower-third",
          status: "succeeded",
          mutationPolicy: expect.objectContaining({ mode: "proposal_only" })
        }),
        eventCount: 3,
        lastEventSeq: 3,
        mutationPolicy: expect.objectContaining({ mode: "proposal_only" })
      }
    });
    expect(JSON.stringify(result.receipt)).not.toContain("make the title blue and preview it");
    expect(result.receipt.output).not.toHaveProperty("request");
    expect(result.receipt.output).not.toHaveProperty("rawRequest");
    expect(calls[0]).toMatchObject({
      prompt: expect.stringContaining("motion.timeline.layer.style.set")
    });
  });

  it("persists only a deterministic plan summary and request hash by default", async () => {
    const confidentialRequest = "Project Cobalt acquisition for client-example.invalid OPENAI_API_KEY=sk-super-secret-value-1234567890";

    const result = await runMotionPrompt({
      request: confidentialRequest,
      tier: "render_motion",
      agentId: "fake",
      runtime: createFakePromptRuntime(),
      packageId: "private-package",
      now: () => "2026-07-01T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.receipt);
    expect(result.receipt.inputHashes.request).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.output).toMatchObject({
      requestSummary: expect.stringContaining("Motion request classified as"),
      requestSummaryTruncated: false,
      promptRetention: { mode: "summary_only", rawRequestRetained: false, summaryRedacted: true, summaryMaxBytes: 512 }
    });
    expect(serialized).not.toContain("Project Cobalt");
    expect(serialized).not.toContain("client-example.invalid");
    expect(serialized).not.toContain("sk-super-secret-value");
    expect(result.receipt.output.authoringJob.brief).toBe(result.receipt.output.requestSummary);
    expect(result.receipt.output.authoringJob.plan.topic).toBe(result.receipt.output.requestSummary);
  });

  it("retains a raw request only with an explicit bounded deletion policy", async () => {
    const rawRequest = "Project Cobalt exact replay request";
    const result = await runMotionPrompt({
      request: rawRequest,
      tier: "render_motion",
      agentId: "fake",
      runtime: createFakePromptRuntime(),
      packageId: "private-package",
      retention: {
        mode: "raw_request",
        purpose: "user_requested_replay",
        deleteAfter: "2026-07-08T00:00:00.000Z"
      },
      now: () => "2026-07-01T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.output).toMatchObject({
      rawRequest,
      promptRetention: {
        mode: "raw_request",
        rawRequestRetained: true,
        summaryRedacted: true,
        summaryMaxBytes: 512,
        purpose: "user_requested_replay",
        deleteAfter: "2026-07-08T00:00:00.000Z"
      }
    });
    expect(result.receipt.warnings).toContain("Raw prompt retained for user_requested_replay until 2026-07-08T00:00:00.000Z; receipt readers redact it after that deadline.");
  });

  it("rejects invalid or overlong raw-retention policies before agent execution", async () => {
    let calls = 0;
    const runtime: MotionPromptRuntime = {
      runPrompt: async () => {
        calls += 1;
        throw new Error("must not execute");
      }
    };
    const base = {
      request: "private prompt",
      tier: "render_motion" as const,
      runtime,
      now: () => "2026-07-01T00:00:00.000Z"
    };

    await expect(runMotionPrompt({
      ...base,
      retention: { mode: "raw_request", purpose: "debugging", deleteAfter: "2026-07-01T00:00:00.000Z" }
    })).resolves.toMatchObject({ ok: false, error: { code: "invalid_prompt_retention", message: expect.stringContaining("later") } });
    await expect(runMotionPrompt({
      ...base,
      retention: { mode: "raw_request", purpose: "debugging", deleteAfter: "2026-08-15T00:00:00.000Z" }
    })).resolves.toMatchObject({ ok: false, error: { code: "invalid_prompt_retention", message: expect.stringContaining("30 days") } });
    expect(calls).toBe(0);
  });

  it("routes title entrance animation prompts through the animation preset action", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-animation-001",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-01T23:10:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "make the title slide in and preview it",
      tier: "edit_motion",
      agentId: "fake",
      runtime,
      packageId: "lower-third",
      now: () => "2026-07-01T23:10:30.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.timeline.animation.preset.apply");
    expect(result.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.animation.preset.apply",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { prompt: string }).prompt).toContain("motion.timeline.animation.preset.apply");
  });

  it("routes Cut Generate apply prompts through the script-to-Cut connector", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-cut-generate-001",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:00:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "apply Cut Generate scripted video to Cut timeline",
      tier: "write_local",
      agentId: "fake",
      runtime,
      packageId: "cut-generate",
      now: () => "2026-07-03T00:00:30.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.connector.cut_generate_to_cut");
    expect(result.receipt.output.debugCommands).toEqual([
      "motion.connector.cut_generate_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { prompt: string; permission: string }).permission).toBe("write_local");
    expect((calls[0] as { prompt: string }).prompt).toContain("motion.connector.cut_generate_to_cut");
  });

  it("routes generic scripted-video apply prompts through the Script-to-Cut connector", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-script-cut-001",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:00:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "send scripted video JSON to Cut without Canvas",
      tier: "write_local",
      agentId: "fake",
      runtime,
      packageId: "script-cut",
      now: () => "2026-07-03T00:00:30.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.connector.script_to_cut");
    expect(result.receipt.output.debugCommands).toEqual([
      "motion.connector.script_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { prompt: string; permission: string }).permission).toBe("write_local");
    expect((calls[0] as { prompt: string }).prompt).toContain("motion.connector.script_to_cut");
  });

  it("blocks prompts before agent execution when the requested plan needs a higher permission tier", async () => {
    let called = false;
    const runtime: MotionPromptRuntime = {
      runPrompt: async () => {
        called = true;
        throw new Error("must not run");
      }
    };

    const result = await runMotionPrompt({
      request: "make the title blue and preview it",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(called).toBe(false);
  });

  it("uses action permissions for mutating commands omitted from the legacy prompt tier map", async () => {
    let called = false;
    const runtime: MotionPromptRuntime = {
      runPrompt: async () => {
        called = true;
        throw new Error("must not run");
      }
    };

    const result = await runMotionPrompt({
      request: "add marker",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(called).toBe(false);
  });

  it("routes layer create prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-create",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:05:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "add a text layer to the timeline",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "add a text layer to the timeline",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.create");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.create",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.create");
  });

  it("routes layer text prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-text-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:05:30.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "change title text",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "change title text",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.text.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.text.set",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.text.set");
  });

  it("routes layer transform prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-transform-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:06:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "move layer",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "move layer",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.transform.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.transform.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.transform.set");
  });

  it("routes layer effect prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-effect-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:06:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "blur layer",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "blur layer",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.effect.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.effect.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.effect.set");
  });

  it("routes layer blend prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-blend-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:06:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "set layer blend mode",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "set layer blend mode",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.blend.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.blend.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.blend.set");
  });

  it("routes layer crop prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-crop-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:06:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "crop image layer",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "crop image layer",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.crop.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.crop.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.crop.set");
  });

  it("routes layer mask prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-mask-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:07:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "mask layer",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "mask layer",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.mask.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.mask.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.mask.set");
  });

  it("routes layer fit prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-fit-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:08:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "fit image layer",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "fit image layer",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.fit.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.fit.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.fit.set");
  });

  it("routes layer media source prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-media-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:09:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "set layer media source",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "set layer media source",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.media.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.media.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.media.set");
  });

  it("routes layer display-name prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-name-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:09:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "rename selected layer",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "rename selected layer",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.name.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.name.set",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.name.set");
  });

  it("routes scene creation prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-scene-create",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:12:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "add storyboard scene",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "add storyboard scene",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.scene.create");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.scene.create",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.scene.create");
  });

  it("routes scene delete prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-scene-delete",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:13:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "remove storyboard scene",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "remove storyboard scene",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.scene.delete");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.scene.delete",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.scene.delete");
  });

  it("routes scene reorder prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-scene-reorder",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:14:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "reorder storyboard scene",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "reorder storyboard scene",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.scene.reorder");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.scene.reorder",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.scene.reorder");
  });

  it("routes scene display-name prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-scene-name-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:11:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "rename selected scene",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "rename selected scene",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.scene.name.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.scene.name.set",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.scene.name.set");
  });

  it("routes layer visibility prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-visibility-set",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:10:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "hide layer",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "hide layer",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.visibility.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.visibility.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.visibility.set");
  });

  it("routes layer lock prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-layer-lock",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:11:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "lock selected layer",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "lock selected layer",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.layer.lock");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.layer.lock",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.layer.lock");
  });

  it("routes track create prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-track-create",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:06:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "create an overlay track",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "create an overlay track",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.track.create");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.track.create",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.track.create");
  });

  it("routes track reorder prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-track-reorder",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:07:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "move music track to top",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "move music track to top",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.track.reorder");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.track.reorder",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.track.reorder");
  });

  it("routes track delete prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-track-delete",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:08:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "delete timeline track",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "delete timeline track",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.track.delete");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.track.delete",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.track.delete");
  });

  it("routes track rename prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-track-rename",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:09:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "rename timeline track",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "rename timeline track",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.track.rename");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.track.rename",
      "motion.timeline.inspect",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.track.rename");
  });

  it("routes duration-policy prompts through edit-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-duration-policy",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:00:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const denied = await runMotionPrompt({
      request: "set protected intro outro duration policy",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const accepted = await runMotionPrompt({
      request: "set protected intro outro duration policy",
      tier: "edit_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires edit_motion; this session holds read_motion."
      }
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.action?.id).toBe("motion.timeline.duration.policy.set");
    expect(accepted.receipt.output.debugCommands).toEqual([
      "motion.state",
      "motion.timeline.duration.policy.set",
      "motion.timeline.duration.policy",
      "motion.receipts.read"
    ]);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("edit_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.duration.policy.set");
  });

  it("routes asset and brand panel prompts through read-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: `agent-${calls.length}`,
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:20:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const assets = await runMotionPrompt({
      request: "show asset panel",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });
    const brand = await runMotionPrompt({
      request: "show brand pack panel",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(assets.ok).toBe(true);
    expect(brand.ok).toBe(true);
    if (!assets.ok || !brand.ok) return;
    expect(assets.plan.action?.id).toBe("motion.assets.panel");
    expect(assets.receipt.output.debugCommands).toEqual(["motion.assets.panel"]);
    expect(brand.plan.action?.id).toBe("motion.brand.panel");
    expect(brand.receipt.output.debugCommands).toEqual(["motion.brand.panel"]);
    expect(calls).toHaveLength(2);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("read_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.assets.panel");
    expect((calls[1] as { permission: string; prompt: string }).prompt).toContain("motion.brand.panel");
  });

  it("routes package browser prompts through read-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-package-browser",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T00:30:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "browse motion packages",
      tier: "read_motion",
      runtime,
      packageId: "workspace"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.packages.browse");
    expect(result.receipt.output.debugCommands).toEqual(["motion.packages.browse"]);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("read_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.packages.browse");
  });

  it("routes prompt action panel prompts through read-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-actions-panel",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T03:50:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "show prompt action panel",
      tier: "read_motion",
      runtime,
      packageId: "workspace"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.actions.panel");
    expect(result.receipt.output.debugCommands).toEqual(["motion.actions.panel"]);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("read_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.actions.panel");
  });

  it("routes package extract prompts through write-local agent plans", async () => {
    const result = await runMotionPrompt({
      request: "extract shellxmotion package archive",
      tier: "write_local",
      runtime: createFakePromptRuntime(),
      packageId: "workspace"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.package.extract");
    expect(result.receipt.output.debugCommands).toEqual(["motion.package.extract", "motion.receipts.read"]);
    expect(result.agent.receipt.output.permission).toBe("write_local");
  });

  it("routes local CLI agent health prompts through read-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-health-panel",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T04:05:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "check local cli agent health",
      tier: "read_motion",
      runtime,
      packageId: "workspace"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.agent.health");
    expect(result.receipt.output.debugCommands).toEqual(["motion.agent.health"]);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("read_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.agent.health");
  });

  it("routes template inspector panel prompts through read-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-template-panel",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T02:00:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "show template inspector panel",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.template.panel");
    expect(result.receipt.output.debugCommands).toEqual(["motion.template.panel"]);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("read_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.template.panel");
  });

  it("routes timeline panel prompts through read-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-timeline-panel",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T01:30:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "show timeline panel",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.timeline.panel");
    expect(result.receipt.output.debugCommands).toEqual(["motion.timeline.panel"]);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("read_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.timeline.panel");
  });

  it("routes preview player panel prompts through read-tier agent plans", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: { accepted: true },
          transcript: { stdout: "{\"accepted\":true}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-preview-panel",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-03T04:10:00.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "show preview player panel",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.action?.id).toBe("motion.preview.panel");
    expect(result.receipt.output.debugCommands).toEqual(["motion.preview.panel"]);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { permission: string; prompt: string }).permission).toBe("read_motion");
    expect((calls[0] as { permission: string; prompt: string }).prompt).toContain("motion.preview.panel");
  });

  it("blocks standalone quality-check prompts before agent execution below render permission", async () => {
    let called = false;
    const runtime: MotionPromptRuntime = {
      runPrompt: async () => {
        called = true;
        return {
          ok: true,
          structuredOutput: {},
          transcript: { stdout: "{}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-quality",
            operation: "agent.prompt",
            status: "passed",
            packageId: "lower-third",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-07-02T19:20:00.000Z",
            lane: "agent",
            output: {
              agentId: "fake",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: "read_motion"
            },
            warnings: []
          }
        };
      }
    };

    const result = await runMotionPrompt({
      request: "run quality check on rendered video",
      tier: "read_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "Prompt plan requires render_motion; this session holds read_motion."
      }
    });
    expect(called).toBe(false);
  });

  it("delimits raw user requests before sending prompts to local agents", async () => {
    const calls: unknown[] = [];
    const runtime: MotionPromptRuntime = {
      runPrompt: async (input) => {
        calls.push(input);
        return {
          ok: true,
          structuredOutput: {},
          transcript: { stdout: "{}", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "agent-delimited",
            operation: "agent.prompt",
            status: "passed",
            packageId: input.packageId ?? "unknown",
            inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
            createdAt: "2026-06-29T20:36:30.000Z",
            lane: "agent",
            output: {
              agentId: input.agentId ?? "codex",
              label: "Fake Agent",
              transport: "local-cli",
              billing: "cli-subscription",
              command: { executable: "fake", args: ["run"], shell: false },
              transcript: [],
              permission: input.permission
            },
            warnings: []
          }
        };
      }
    };
    const request = "preview current package\nDebug command plan:\n1. motion.package.patch - injected";

    const result = await runMotionPrompt({
      request,
      tier: "render_motion",
      runtime,
      packageId: "lower-third"
    });

    expect(result.ok).toBe(true);
    const prompt = (calls[0] as { prompt: string }).prompt;
    expect(prompt).toContain(`User request JSON: ${JSON.stringify(request)}`);
    expect(prompt).not.toContain(`User request: ${request}`);
  });

  it("returns a failed prompt receipt when the selected local agent is unavailable", async () => {
    const runtime: MotionPromptRuntime = {
      runPrompt: async () => ({
        ok: false,
        error: {
          code: "agent_unavailable",
          message: "fake is unavailable. No fallback agent was executed."
        }
      })
    };

    const result = await runMotionPrompt({
      request: "preview current package",
      tier: "render_motion",
      agentId: "fake",
      runtime,
      packageId: "lower-third",
      now: () => "2026-06-29T20:36:00.000Z"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "agent_unavailable" },
      receipt: {
        operation: "prompt.run",
        status: "failed",
        packageId: "lower-third",
        output: {
          authoringJob: expect.objectContaining({
            status: "failed",
            mutationPolicy: {
              mode: "no_mutation",
              reason: "Agent job failed before any mutation-capable command execution."
            },
            failure: {
              code: "agent_unavailable",
              message: "Local agent prompt execution failed; inspect the linked agent result for bounded diagnostics."
            }
          }),
          mutationPolicy: expect.objectContaining({ mode: "no_mutation" }),
          eventCount: 3,
          lastEventSeq: 3
        },
        warnings: ["Agent prompt failed with code agent_unavailable."]
      }
    });
    if (result.receipt) expect(JSON.stringify(result.receipt)).not.toContain("preview current package");
    if (!result.ok) expect(result.agent).toBeUndefined();
  });

  it("provides a fake local runtime for deterministic smoke tests", async () => {
    const result = await runMotionPrompt({
      request: "preview current package",
      tier: "render_motion",
      runtime: createFakePromptRuntime(),
      packageId: "lower-third"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.receipt.output.agentId).toBe("fake");
    expect(result.receipt.output.agentReceiptId).toBe(result.agent.receipt.id);
  });
});

describe("raw prompt retention lifecycle", () => {
  const RAW_REQUEST = "Project Cobalt exact replay request";
  const DELETE_AFTER = "2026-07-08T00:00:00.000Z";

  /**
   * Produces a retained prompt receipt and round-trips it through JSON, because that is the
   * shape the enforcement gate meets in production: a persisted receipt parsed back from disk,
   * not the freshly-typed object `runMotionPrompt` returned.
   */
  async function persistedRetainedReceipt(): Promise<PromptRunReceipt> {
    const result = await runMotionPrompt({
      request: RAW_REQUEST,
      tier: "render_motion",
      agentId: "fake",
      runtime: createFakePromptRuntime(),
      packageId: "private-package",
      retention: { mode: "raw_request", purpose: "user_requested_replay", deleteAfter: DELETE_AFTER },
      now: () => "2026-07-01T00:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("retained prompt run failed");
    return JSON.parse(JSON.stringify(result.receipt)) as PromptRunReceipt;
  }

  it("regression: a receipt read after deleteAfter must not yield the raw request", async () => {
    // The original finding: resolvePromptRetention validated the deadline, nothing consumed it,
    // so a reader after the promised deletion date still received the full raw prompt.
    const persisted = await persistedRetainedReceipt();
    expect(persisted.output.rawRequest).toBe(RAW_REQUEST);

    const enforced = redactExpiredRawPrompt(persisted, "2026-07-08T00:00:01.000Z");

    expect(enforced.redacted).toBe(true);
    expect(JSON.stringify(enforced.receipt)).not.toContain("Project Cobalt");
    expect(enforced.receipt.output.rawRequest).toBeUndefined();
    expect(enforced.receipt.output.promptRetention).toEqual({
      mode: "raw_request",
      rawRequestRetained: false,
      summaryRedacted: true,
      summaryMaxBytes: 512,
      deleteAfter: DELETE_AFTER,
      purpose: "user_requested_replay",
      rawRequestRedactedAt: "2026-07-08T00:00:01.000Z"
    });
    expect(enforced.receipt.warnings).toContain(
      `${RAW_PROMPT_REDACTION_WARNING_PREFIX} retention deadline ${DELETE_AFTER} passed; the raw request was removed at 2026-07-08T00:00:01.000Z.`
    );
    // The integrity chain survives redaction: the request hash still binds the receipt to the
    // content without carrying it.
    expect(enforced.receipt.inputHashes.request).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns the identical receipt object while the retention window is still live", async () => {
    const persisted = await persistedRetainedReceipt();

    const enforced = redactExpiredRawPrompt(persisted, "2026-07-07T23:59:59.000Z");

    expect(enforced.redacted).toBe(false);
    // Reference equality is part of the contract: it lets a store skip a no-op persist-back.
    expect(enforced.receipt).toBe(persisted);
    expect(enforced.receipt.output.rawRequest).toBe(RAW_REQUEST);
  });

  it("redacts at exactly the deadline instant, not one tick later", async () => {
    const persisted = await persistedRetainedReceipt();

    const enforced = redactExpiredRawPrompt(persisted, DELETE_AFTER);

    expect(enforced.redacted).toBe(true);
    expect(enforced.receipt.output.rawRequest).toBeUndefined();
  });

  it("fails closed when raw content is present without a provable retention record", () => {
    // A persisted receipt is parsed JSON, so nothing guarantees its retention record survived
    // intact. Raw content must only survive on positive proof of a live window.
    const malformedRetention = { mode: "raw_request" }; // no deleteAfter, no purpose, no retained flag
    const loose = {
      operation: "prompt.run",
      output: { rawRequest: RAW_REQUEST, promptRetention: malformedRetention },
      warnings: []
    };

    const enforced = redactExpiredRawPrompt(loose, "2026-07-01T00:00:00.000Z");

    expect(enforced.redacted).toBe(true);
    expect(JSON.stringify(enforced.receipt)).not.toContain("Project Cobalt");
    // The malformed record stays untouched: it is evidence of what was actually stored, and
    // rewriting it to a tidy redacted state would destroy that.
    expect((enforced.receipt.output as Record<string, unknown>).promptRetention).toEqual(malformedRetention);
    expect(enforced.receipt.warnings).toContain(
      `${RAW_PROMPT_REDACTION_WARNING_PREFIX} the retention record did not prove a live deletion deadline, so the raw request was removed (fail closed).`
    );
  });

  it("fails closed when the current time cannot be evaluated", async () => {
    const persisted = await persistedRetainedReceipt();

    const enforced = redactExpiredRawPrompt(persisted, "not-a-timestamp");

    expect(enforced.redacted).toBe(true);
    expect(enforced.receipt.output.rawRequest).toBeUndefined();
  });

  it("is idempotent and leaves summary-only and non-prompt receipts untouched", async () => {
    const persisted = await persistedRetainedReceipt();
    const first = redactExpiredRawPrompt(persisted, "2026-08-01T00:00:00.000Z");
    expect(first.redacted).toBe(true);

    // Second pass sees no rawRequest key and must be a no-op, so stores can enforce on every read.
    const second = redactExpiredRawPrompt(first.receipt, "2026-09-01T00:00:00.000Z");
    expect(second.redacted).toBe(false);
    expect(second.receipt).toBe(first.receipt);

    const summaryOnly = await runMotionPrompt({
      request: "preview current package",
      tier: "render_motion",
      runtime: createFakePromptRuntime(),
      packageId: "lower-third",
      now: () => "2026-07-01T00:00:00.000Z"
    });
    expect(summaryOnly.ok).toBe(true);
    if (!summaryOnly.ok) return;
    const summaryEnforced = redactExpiredRawPrompt(summaryOnly.receipt, "2027-01-01T00:00:00.000Z");
    expect(summaryEnforced.redacted).toBe(false);
    expect(summaryEnforced.receipt).toBe(summaryOnly.receipt);

    // Scope guard: prompt.run receipts are the only ones this repository writes rawRequest into,
    // so other operations pass through even if a field of that name appears.
    const other = { operation: "render.final", output: { rawRequest: "not ours" }, warnings: [] };
    expect(redactExpiredRawPrompt(other, "2027-01-01T00:00:00.000Z").redacted).toBe(false);
  });
});
