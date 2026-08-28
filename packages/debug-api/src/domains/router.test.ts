import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMotionPackage } from "@shellx-motion/core";
import { readMotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import { dispatchDomainCommand } from "./router.js";
import { DEBUG_COMMANDS, debugCommandDefinition } from "../command-registry.js";

describe("debug API domain router", () => {
  it("has a declared-domain handler for every registered debug command", async () => {
    const missing: string[] = [];
    for (const command of DEBUG_COMMANDS) {
      const definition = debugCommandDefinition(command);
      if (!definition) {
        missing.push(`${command}:missing-definition`);
        continue;
      }
      const result = await dispatchDomainCommand(definition.domain, command, {}, {
        agentRuntime: { health: async () => [] }
      });
      if (result === null) missing.push(`${command}:${definition.domain}`);
    }
    expect(missing).toEqual([]);
  });

  it("keeps command-specific authority out of the central dispatcher", async () => {
    const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    expect(source.match(/if\s*\(\s*command\s*===\s*["']motion\./g) ?? []).toEqual([]);
  });

  it("routes only through the registry-selected domain", async () => {
    expect(await dispatchDomainCommand("surface", "motion.open", { panel: "timeline" })).toMatchObject({ ok: true, visibleState: { panel: "timeline" } });
    expect(await dispatchDomainCommand("agent", "motion.open", { panel: "timeline" })).toBeNull();
    expect(await dispatchDomainCommand("render", "motion.actions.find", { request: "render final" })).toBeNull();
  });

  it("keeps quality execution inside the render domain and behind analysis capabilities", async () => {
    let probeCalls = 0;
    expect(await dispatchDomainCommand("render", "motion.quality.check", { inputPath: "/trusted/final.mp4" })).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    expect(await dispatchDomainCommand(
      "surface",
      "motion.quality.check",
      { inputPath: "/trusted/final.mp4" },
      {
        probeQualityMedia: async () => {
          probeCalls += 1;
          return { width: 1920, height: 1080, audio: { present: false } };
        }
      }
    )).toBeNull();
    expect(probeCalls).toBe(0);

    const inherited = Object.create({ inputPath: "/trusted/inherited.mp4" }) as Record<string, unknown>;
    expect(await dispatchDomainCommand("render", "motion.quality.check", inherited)).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.quality.check requires inputPath." }
    });
    expect(await dispatchDomainCommand("render", "motion.quality.check", {
      inputPath: "/trusted/final.mp4",
      minAudioLoudnessLufs: -16,
      maxAudioLoudnessLufs: -24
    })).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "minAudioLoudnessLufs must be less than or equal to maxAudioLoudnessLufs." }
    });
    expect(await dispatchDomainCommand("render", "motion.quality.check", {
      inputPath: "/trusted/final.mp4",
      maxAudioLoudnessRangeLu: -1
    })).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "maxAudioLoudnessRangeLu must be a non-negative number." }
    });
  });

  it("keeps final rendering behind the render-domain executor and strips inherited arguments", async () => {
    let calls = 0;
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-router-render-final-"));
    const packageRoot = join(root, "package");
    const outputPath = join(root, "final.mp4");
    await mkdir(packageRoot, { mode: 0o700 });
    const executeFfmpegFinalRender = async (request: { packageRoot: string; outputPath: string }) => {
      calls += 1;
      expect(request).toMatchObject({
        packageRoot,
        outputPath,
        frameLane: "browser",
        preset: "mp4-h264",
        dryRun: false
      });
      return { ok: true as const, result: { ok: true }, warnings: [] };
    };
    const validArgs = { packageRoot, outputPath };
    try {
      expect(await dispatchDomainCommand("render", "motion.render.final", validArgs)).toMatchObject({
        ok: false,
        error: { code: "capability_unavailable" }
      });
      expect(await dispatchDomainCommand(
        "surface",
        "motion.render.final",
        validArgs,
        { executeFfmpegFinalRender }
      )).toBeNull();
      expect(calls).toBe(0);

      const inherited = Object.create({ packageRoot: "/untrusted/inherited" }) as Record<string, unknown>;
      inherited.outputPath = outputPath;
      expect(await dispatchDomainCommand("render", "motion.render.final", inherited, { executeFfmpegFinalRender })).toMatchObject({
        ok: false,
        error: { code: "invalid_args", message: "motion.render.final requires packageRoot." }
      });
      expect(calls).toBe(0);
      expect(await dispatchDomainCommand(
        "render",
        "motion.render.final",
        { ...validArgs, workflowPath: "/outside/workflow.json" },
        { executeFfmpegFinalRender, renderRootPolicy: { enforce: true, packageRoots: [packageRoot], inputRoots: [root], outputRoots: [root] } }
      )).toMatchObject({
        ok: false,
        error: { code: "invalid_args", message: "motion.render.final workflowPath must be a regular file inside an approved render input root and may not traverse symbolic links." }
      });
      expect(calls).toBe(0);
      expect(await dispatchDomainCommand("render", "motion.render.final", validArgs, { executeFfmpegFinalRender })).toMatchObject({ ok: true });
      expect(calls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("grants final rendering only the executor for the selected output lane", async () => {
    const calls: string[] = [];
    const services = {
      executeStillFinalRender: async () => { calls.push("still"); return { ok: true as const, warnings: [] }; },
      executeSequenceFinalRender: async () => { calls.push("sequence"); return { ok: true as const, warnings: [] }; },
      executeFfmpegFinalRender: async () => { calls.push("ffmpeg"); return { ok: true as const, warnings: [] }; }
    };
    const base = { packageRoot: "/trusted/package", outputPath: "/trusted/output" };
    expect(await dispatchDomainCommand("render", "motion.render.final", { ...base, outputPath: "/trusted/frame.png", preset: "png-frame" }, services)).toMatchObject({ ok: true });
    expect(await dispatchDomainCommand("render", "motion.render.final", { ...base, preset: "png-sequence" }, services)).toMatchObject({ ok: true });
    expect(await dispatchDomainCommand("render", "motion.render.final", { ...base, outputPath: "/trusted/final.mp4", preset: "mp4-h264" }, services)).toMatchObject({ ok: true });
    expect(calls).toEqual(["still", "sequence", "ffmpeg"]);
  });

  it("keeps batch rendering behind the render-domain executor and strips inherited arguments", async () => {
    let calls = 0;
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-router-render-batch-"));
    const packageRoot = join(root, "package");
    const outDir = join(root, "batch");
    await mkdir(packageRoot, { mode: 0o700 });
    const executeBatchPlan = async (request: { packageRoot: string; outDir: string }) => {
      calls += 1;
      expect(request).toMatchObject({
        packageRoot,
        outDir,
        rowIds: [],
        preset: "mp4-h264",
        forcePreset: false,
        dryRun: true,
        resume: false
      });
      return { ok: true as const, result: { ok: true }, warnings: [] };
    };
    const validArgs = { packageRoot, outDir };
    try {
      expect(await dispatchDomainCommand("render", "motion.render.batch", validArgs)).toMatchObject({
        ok: false,
        error: { code: "capability_unavailable" }
      });
      expect(await dispatchDomainCommand(
        "workspace",
        "motion.render.batch",
        validArgs,
        { executeBatchPlan }
      )).toBeNull();
      expect(calls).toBe(0);

      const inherited = Object.create({ packageRoot: "/untrusted/inherited" }) as Record<string, unknown>;
      inherited.outDir = outDir;
      expect(await dispatchDomainCommand("render", "motion.render.batch", inherited, { executeBatchPlan })).toMatchObject({
        ok: false,
        error: { code: "invalid_args", message: "motion.render.batch requires packageRoot." }
      });
      expect(calls).toBe(0);
      expect(await dispatchDomainCommand(
        "render",
        "motion.render.batch",
        { ...validArgs, rowsPath: "/outside/rows.json" },
        { executeBatchPlan, renderRootPolicy: { enforce: true, packageRoots: [packageRoot], inputRoots: [root], outputRoots: [root] } }
      )).toMatchObject({
        ok: false,
        error: { code: "invalid_args", message: "motion.render.batch rowsPath must be a regular file inside an approved render input root and may not traverse symbolic links." }
      });
      expect(calls).toBe(0);
      expect(await dispatchDomainCommand("render", "motion.render.batch", validArgs, { executeBatchPlan })).toMatchObject({ ok: true });
      expect(calls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("grants batch rendering only the planner or executor selected by dryRun", async () => {
    const calls: string[] = [];
    const services = {
      executeBatchPlan: async () => { calls.push("plan"); return { ok: true as const, warnings: [] }; },
      executeBatchRun: async () => { calls.push("run"); return { ok: true as const, warnings: [] }; }
    };
    const args = { packageRoot: "/trusted/package", outDir: "/trusted/batch" };
    expect(await dispatchDomainCommand("render", "motion.render.batch", args, services)).toMatchObject({ ok: true });
    expect(await dispatchDomainCommand("render", "motion.render.batch", { ...args, dryRun: false }, services)).toMatchObject({ ok: true });
    expect(calls).toEqual(["plan", "run"]);
  });

  it("passes GPU rows only to a capable fresh streamed-video batch executor", async () => {
    const calls: unknown[] = [], base = { packageRoot: "/trusted/package", outDir: "/trusted/gpu-batch", frameLane: "gpu" };
    const services = { gpuFinalExecutionAvailable: true, executeBatchPlan: async (request: unknown) => { calls.push(request); return { ok: true as const, warnings: [] }; } };
    expect(await dispatchDomainCommand("render", "motion.render.batch", base, services)).toMatchObject({ ok: true });
    expect(calls).toMatchObject([{ frameLane: "gpu", resume: false, preset: "mp4-h264" }]);
    for (const args of [{ ...base, preset: "gif" }, { ...base, resume: true }]) {
      expect(await dispatchDomainCommand("render", "motion.render.batch", args, services)).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    }
    expect(await dispatchDomainCommand("render", "motion.render.batch", base, { ...services, gpuFinalExecutionAvailable: false })).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(calls).toHaveLength(1);
  });

  it("keeps inherited and malformed argument fields outside handler authority", async () => {
    const inherited = Object.create({ panel: "admin", layerId: "inherited-layer" }) as Record<string, unknown>;
    expect(await dispatchDomainCommand("surface", "motion.open", inherited)).toMatchObject({ visibleState: { panel: "preview" } });
    expect(await dispatchDomainCommand("surface", "motion.select", inherited)).toMatchObject({
      ok: false,
      error: { code: "invalid_args" }
    });
    // The render domain's contribution to this case was motion.screenshot, the only read-tier
    // command there; it was removed for faking success. Every remaining render command needs
    // render_motion, so it would fail on capability before argument authority is reached — which
    // would test the wrong thing. The surface-domain assertions above still cover the behaviour.
  });

  it("returns structured action results without granting other agent-domain commands", async () => {
    expect(await dispatchDomainCommand("agent", "motion.actions.find", { request: "render final" })).toMatchObject({ ok: true });
    expect(await dispatchDomainCommand("agent", "motion.prompt.run", { request: "render final" })).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    expect(await dispatchDomainCommand(
      "surface",
      "motion.prompt.run",
      { request: "render final" },
      { tier: "render_motion" }
    )).toBeNull();
    expect(await dispatchDomainCommand(
      "agent",
      "motion.prompt.run",
      { request: "render final", cwd: "/outside" },
      { tier: "render_motion", promptCwdRoots: ["/trusted"], isPathInsideTrustedRoot: async () => false }
    )).toMatchObject({
      ok: false,
      error: {
        code: "invalid_args",
        // The roots in force are named in the message, and the suggestedAction names who can add
        // one: without both, a refused agent can only guess paths. See permission-refusal.ts.
        message: "motion.prompt.run cwd must be inside a trusted prompt working root. Trusted roots for this session: /trusted.",
        suggestedAction: expect.stringContaining("the host operator must"),
        detail: { argument: "cwd", trustedRoots: ["/trusted"], resolvedBy: "host_operator" }
      }
    });
  });

  it("keeps capability inspection inside the surface domain", async () => {
    const result = await dispatchDomainCommand("surface", "motion.capabilities.match", { output: "mp4-h264", target: "final" });
    expect(result).toMatchObject({
      ok: true,
      visibleState: { panel: "capabilities", operation: "capabilities.match" },
      result: { ok: true, matches: [] }
    });
    expect(await dispatchDomainCommand("integration", "motion.capabilities.match", {})).toBeNull();
  });

  it("injects only the narrow agent health capability into the agent domain", async () => {
    let calls = 0;
    const result = await dispatchDomainCommand("agent", "motion.agent.health", {}, {
      agentRuntime: {
        health: async () => {
          calls += 1;
          return [{
            agentId: "fake",
            available: true,
            command: "fake-agent",
            transport: "local-cli",
            billing: "cli-subscription",
            detail: "fake-agent 1.0.0",
            status: "ready",
            version: "1.0.0",
            setup: { checkCommand: "fake-agent --version", installHint: "install", authHint: "auth", quotaHint: "quota" },
            probe: { executable: "fake-agent", args: ["--version"], shell: false }
          }];
        }
      }
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      visibleState: { operation: "agent.health", agentCount: 1, availableCount: 1 }
    });
  });

  it("keeps transcript receipt reads inside bounded agent capabilities", async () => {
    const args = { receiptsRoot: "/receipts", limit: 1 };
    expect(await dispatchDomainCommand("agent", "motion.agent.transcript", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    const readAgentTranscript = async () => {
      calls += 1;
      return { targetFound: true, sessions: [{ transcript: { messageCount: 2 } }, { transcript: { messageCount: 4 } }] };
    };
    expect(await dispatchDomainCommand("workspace", "motion.agent.transcript", args, { readAgentTranscript })).toBeNull();
    expect(calls).toBe(0);
    expect(await dispatchDomainCommand(
      "agent",
      "motion.agent.transcript",
      { receiptsRoot: "/receipts", receiptPath: "/outside/receipt.json" },
      { readAgentTranscript, isAgentReceiptPathInsideRoot: async () => false }
    )).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.agent.transcript receiptPath must be inside receiptsRoot." }
    });
    expect(calls).toBe(0);
    expect(await dispatchDomainCommand("agent", "motion.agent.transcript", args, { readAgentTranscript })).toMatchObject({
      ok: true,
      visibleState: { sessionCount: 1, messageCount: 2 },
      result: { sessionCount: 1, messageCount: 2 }
    });
    expect(calls).toBe(1);
  });

  it("keeps revision evidence and plan writes inside bounded agent capabilities", async () => {
    const args = { packageId: "pkg_revision" };
    expect(await dispatchDomainCommand("agent", "motion.agent.revision.plan", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let reads = 0;
    const readAgentRevisionEvidence = async () => {
      reads += 1;
      return { ok: true as const, evidence: { qualityReceipts: [] } };
    };
    expect(await dispatchDomainCommand("workspace", "motion.agent.revision.plan", args, { readAgentRevisionEvidence })).toBeNull();
    expect(reads).toBe(0);
    expect(await dispatchDomainCommand(
      "agent",
      "motion.agent.revision.plan",
      { ...args, planPath: "/outside/plan.json" },
      { readAgentRevisionEvidence, isPathInsideTrustedRoot: async () => false, writeJson: async () => {} }
    )).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.agent.revision.plan planPath must be inside a trusted debug output root." }
    });
    expect(reads).toBe(0);
    expect(await dispatchDomainCommand(
      "agent",
      "motion.agent.revision.plan",
      { ...args, contactSheetPath: "/outside/contact-sheet.json" },
      { readAgentRevisionEvidence, isPathInsideTrustedRoot: async () => false }
    )).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "contactSheetPath must be inside a trusted debug input root." }
    });
    expect(await dispatchDomainCommand(
      "agent",
      "motion.agent.revision.plan",
      { ...args, receiptsRoot: "/receipts", qualityReceiptPath: "/outside/quality.json" },
      { readAgentRevisionEvidence, isAgentReceiptPathInsideRoot: async () => false, writeReceipt: async () => "/receipts/plan.json" }
    )).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "qualityReceiptPath must be inside receiptsRoot." }
    });
    expect(reads).toBe(0);
    expect(await dispatchDomainCommand("agent", "motion.agent.revision.plan", args, { readAgentRevisionEvidence })).toMatchObject({
      ok: true,
      visibleState: { operation: "agent.revision.plan", packageId: "pkg_revision" },
      result: { plan: { packageId: "pkg_revision" } }
    });
    expect(reads).toBe(1);
  });

  it("keeps prompt queue and control receipts inside bounded agent capabilities", async () => {
    const promptLifecycleServices = { receiptCallerId: "test-prompt" };
    expect(await dispatchDomainCommand("agent", "motion.prompt.queue", {}, promptLifecycleServices)).toMatchObject({
      ok: true,
      result: { jobCount: 0 }
    });
    expect(await dispatchDomainCommand("agent", "motion.prompt.queue", { receiptsRoot: "/receipts" }, promptLifecycleServices)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let reads = 0;
    const readPromptLifecycleState = async () => {
      reads += 1;
      return {
        jobs: [{ state: "failed", availableActions: ["retry"], warnings: ["failed prompt"] }],
        stateCounts: { queued: 0, running: 0, succeeded: 0, failed: 1, cancelled: 0 }
      };
    };
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.prompt.queue",
      { receiptsRoot: "/receipts" },
      { readPromptLifecycleState }
    )).toBeNull();
    expect(reads).toBe(0);
    expect(await dispatchDomainCommand(
      "agent",
      "motion.prompt.queue",
      { receiptsRoot: "/receipts" },
      { ...promptLifecycleServices, readPromptLifecycleState }
    )).toMatchObject({
      ok: true,
      visibleState: { jobCount: 1, actionableCount: 1, failedCount: 1 }
    });
    expect(reads).toBe(1);
    expect(await dispatchDomainCommand(
      "agent",
      "motion.prompt.cancel",
      { receiptsRoot: "/receipts", receiptId: "prompt-1" },
      promptLifecycleServices
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
  });

  it("keeps browser workflow execution behind the integration renderer and persistence ports", async () => {
    let calls = 0;
    expect(await dispatchDomainCommand(
      "integration",
      "motion.browser.workflow.capture",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third" }
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(await dispatchDomainCommand(
      "integration",
      "motion.browser.workflow.capture",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third" },
      {
        browserFrameRenderer: async () => { calls += 1; throw new Error("must not run without persistence"); },
        packageLoader: loadMotionPackage,
        ensureDirectory: async () => {}
      }
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: "Browser capture receipt persistence is unavailable." } });
    expect(calls).toBe(0);
    expect(await dispatchDomainCommand(
      "surface",
      "motion.browser.workflow.capture",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third" },
      { browserFrameRenderer: async () => { throw new Error("must not run"); } }
    )).toBeNull();
    const inheritedWorkflow = Object.create({
      schema: "shellx-motion/browser-workflow@1",
      steps: []
    }) as Record<string, unknown>;
    expect(await dispatchDomainCommand(
      "integration",
      "motion.browser.workflow.capture",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third", workflow: inheritedWorkflow },
      {
        browserFrameRenderer: async () => { calls += 1; throw new Error("must not run for inherited workflow fields"); },
        packageLoader: loadMotionPackage,
        ensureDirectory: async () => {},
        publishJsonSidecar: async () => {}
      }
    )).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(calls).toBe(0);
    expect(await dispatchDomainCommand(
      "integration",
      "motion.browser.workflow.capture",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third", catalogPath: "/tmp/catalog.json" },
      {
        browserFrameRenderer: async () => { calls += 1; throw new Error("must not run without catalog persistence"); },
        packageLoader: loadMotionPackage,
        ensureDirectory: async () => {},
        publishJsonSidecar: async () => {},
        isPathInsideTrustedRoot: async () => true
      }
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: "Browser workflow catalog persistence is unavailable." } });
    expect(calls).toBe(0);

    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-domain-"));
    const writes: string[] = [];
    try {
      const result = await dispatchDomainCommand(
        "integration",
        "motion.browser.workflow.capture",
        { packageRoot: "../../fixtures/packages/keyframed-lower-third", outDir },
        {
          packageLoader: loadMotionPackage,
          ensureDirectory: async () => {},
          browserFrameRenderer: async (pkg, options) => {
            calls += 1;
            return {
              ok: true,
              output: {
                path: join(outDir, "frame.png"),
                sha256: "a".repeat(64),
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: "browser-domain-receipt",
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "b".repeat(64) },
                createdAt: "2026-07-11T00:00:00.000Z",
                lane: "browser",
                output: {},
                warnings: []
              }
            };
          },
          publishJsonSidecar: async (path) => { writes.push(path); },
          isPathInsideTrustedRoot: async () => true
        }
      );
      expect(calls).toBe(1);
      expect(result).toMatchObject({
        ok: true,
        receiptId: "browser-domain-receipt",
        visibleState: { operation: "browser.workflow.capture" }
      });
      expect(writes).toEqual([join(outDir, "pkg_keyframed_lower_third-browser-capture.receipt.json")]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("keeps package discovery behind the workspace browser capability", async () => {
    let calls = 0;
    expect(await dispatchDomainCommand("workspace", "motion.packages.browse", { root: "." })).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    expect(await dispatchDomainCommand(
      "surface",
      "motion.packages.browse",
      { root: "." },
      { browsePackages: async () => { calls += 1; throw new Error("must not run outside workspace"); } }
    )).toBeNull();
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.packages.browse",
      { root: ".", packageRoots: "not-an-array" },
      { browsePackages: async () => { calls += 1; throw new Error("must not run for malformed roots"); } }
    )).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const inherited = Object.create({ packageRoots: ["/inherited"] }) as Record<string, unknown>;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.packages.browse",
      inherited,
      { browsePackages: async () => { calls += 1; throw new Error("must not run for inherited roots"); } }
    )).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(calls).toBe(0);

    const result = await dispatchDomainCommand(
      "workspace",
      "motion.packages.browse",
      { root: ".", packageRoots: ["."] },
      {
        browsePackages: async (roots) => {
          calls += 1;
          expect(roots).toHaveLength(1);
          expect(roots[0]).toBe(process.cwd());
          return { roots, packageCount: 2, templateCount: 1, warnings: ["one broken package"] };
        }
      }
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      visibleState: { operation: "packages.browse", rootCount: 1, packageCount: 2, templateCount: 1, warningCount: 1 },
      warnings: ["one broken package"]
    });
  });

  it("keeps receipt browsing and direct reads behind workspace capabilities", async () => {
    let listCalls = 0;
    expect(await dispatchDomainCommand("workspace", "motion.receipts.list", { receiptsRoot: "/receipts" })).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    expect(await dispatchDomainCommand(
      "surface",
      "motion.receipts.list",
      { receiptsRoot: "/receipts" },
      { listReceiptEntries: async () => { listCalls += 1; return []; } }
    )).toBeNull();
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.receipts.panel",
      { receiptsRoot: "/receipts", limit: 1.5 },
      {
        listReceiptEntries: async () => { listCalls += 1; return []; },
        summarizeReceiptsPanel: () => ({})
      }
    )).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(listCalls).toBe(0);

    const receipt = {
      schema: "shellx-motion/receipt@1" as const,
      id: "workspace-receipt",
      operation: "preview.frame",
      status: "passed" as const,
      packageId: "pkg_workspace",
      inputHashes: { motion: "a".repeat(64) },
      createdAt: "2026-07-11T00:00:00.000Z",
      lane: "browser",
      output: {},
      warnings: []
    };
    const listed = await dispatchDomainCommand(
      "workspace",
      "motion.receipts.list",
      { receiptsRoot: "/receipts" },
      {
        listReceiptEntries: async () => { listCalls += 1; return [{ path: "/receipts/one.json", receipt }]; },
        summarizeReceipt: (entry) => ({ id: entry.receipt.id, path: entry.path })
      }
    );
    expect(listCalls).toBe(1);
    expect(listed).toMatchObject({ ok: true, visibleState: { receiptCount: 1 }, result: { receiptCount: 1 } });

    const outside = await dispatchDomainCommand(
      "workspace",
      "motion.receipts.read",
      { receiptsRoot: "/receipts", receiptPath: "/outside/one.json" },
      { readReceiptEntryInsideRoot: async () => ({ insideRoot: false, entry: null }) }
    );
    expect(outside).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const direct = await dispatchDomainCommand(
      "workspace",
      "motion.receipts.read",
      { receiptsRoot: "/receipts", receiptPath: "/receipts/one.json" },
      { readReceiptEntryInsideRoot: async () => ({ insideRoot: true, entry: { path: "/receipts/one.json", receipt } }) }
    );
    expect(direct).toMatchObject({
      ok: true,
      receiptId: "workspace-receipt",
      visibleState: { operation: "preview.frame", status: "passed" }
    });
  });

  it("keeps package archive, extraction, and review writes inside workspace ports", async () => {
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.package.archive",
      { packageRoot: "/pkg", archivePath: "/out/pkg.sxmotion" }
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(await dispatchDomainCommand(
      "authoring",
      "motion.package.archive",
      { packageRoot: "/pkg", archivePath: "/out/pkg.sxmotion" },
      { archivePackage: async () => { calls += 1; throw new Error("must not run cross-domain"); } }
    )).toBeNull();
    const receipt = {
      schema: "shellx-motion/receipt@1" as const,
      id: "workspace-write-receipt",
      operation: "package.archive",
      status: "passed" as const,
      packageId: "pkg_workspace",
      inputHashes: { package: "a".repeat(64) },
      createdAt: "2026-07-11T00:00:00.000Z",
      lane: "workspace",
      output: {},
      warnings: []
    };
    const archived = await dispatchDomainCommand(
      "workspace",
      "motion.package.archive",
      { packageRoot: "/pkg", out: "/out/pkg.sxmotion", receiptPath: "/out/archive.json" },
      {
        archivePackage: async (input) => {
          calls += 1;
          expect(input).toEqual({ packageRoot: "/pkg", archivePath: "/out/pkg.sxmotion", receiptPath: "/out/archive.json" });
          return { packageId: "pkg_workspace", archivePath: input.archivePath, receiptPath: input.receiptPath!, fileCount: 3, receipt };
        }
      }
    );
    const extracted = await dispatchDomainCommand(
      "workspace",
      "motion.package.extract",
      { archive: "/out/pkg.sxmotion", outDir: "/restored" },
      {
        extractPackage: async (input) => {
          calls += 1;
          return {
            packageId: "pkg_workspace",
            archivePath: input.archivePath,
            packageRoot: input.packageRoot,
            receiptPath: "/restored/extract.json",
            fileCount: 3,
            receipt: { ...receipt, operation: "package.archive.extract" }
          };
        }
      }
    );
    const reviewed = await dispatchDomainCommand(
      "workspace",
      "motion.review.html.bundle",
      { outDir: "/review", title: "Review" },
      {
        receiptsRoot: "/receipts",
        writeReviewBundle: async (input) => {
          calls += 1;
          expect(input).toMatchObject({ outDir: "/review", receiptsRoot: "/receipts", title: "Review" });
          return {
            packageId: "workspace",
            htmlPath: "/review/index.html",
            receiptPath: "/review/review.json",
            receiptCount: 2,
            copiedArtifactCount: 1,
            omittedArtifactCount: 0,
            qualityGateCount: 1,
            failedQualityGateCount: 0,
            receipt: { ...receipt, operation: "review.html.bundle" }
          };
        }
      }
    );
    expect(calls).toBe(3);
    expect(archived).toMatchObject({ ok: true, visibleState: { operation: "package.archive", fileCount: 3 } });
    expect(extracted).toMatchObject({ ok: true, visibleState: { operation: "package.archive.extract", packageRoot: "/restored" } });
    expect(reviewed).toMatchObject({ ok: true, visibleState: { operation: "review.html.bundle", receiptCount: 2 } });
  });

  it("keeps bounded package patching inside workspace capabilities", async () => {
    let calls = 0;
    const validArgs = {
      packageRoot: "/pkg",
      outDir: "/out",
      patch: [{ op: "replace", path: "/name", value: "Updated" }]
    };
    expect(await dispatchDomainCommand("workspace", "motion.package.patch", validArgs)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    expect(await dispatchDomainCommand(
      "surface",
      "motion.package.patch",
      validArgs,
      { packageLoader: async () => { calls += 1; throw new Error("must not run cross-domain"); } }
    )).toBeNull();
    const inheritedOperation = Object.create({ op: "replace", path: "/name", value: "Inherited" });
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.package.patch",
      { packageRoot: "/pkg", outDir: "/out", patch: [inheritedOperation] },
      { packageLoader: async () => { calls += 1; throw new Error("must not run for inherited patch fields"); } }
    )).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.package.patch",
      { packageRoot: "/pkg", outDir: "/out", patch: Array.from({ length: 1_001 }, () => ({ op: "remove", path: "/name" })) },
      { packageLoader: async () => { calls += 1; throw new Error("must not run for oversized patches"); } }
    )).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(calls).toBe(0);
  });

  it("keeps redacted support-bundle assembly inside the workspace domain and trusted scratch authority", async () => {
    const scratchRoot = resolve("/scratch");
    const outDir = join(scratchRoot, "bundle");
    const args = { outDir };
    expect(await dispatchDomainCommand("workspace", "motion.support.bundle", args)).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.support.bundle requires a trusted debug scratch root." }
    });

    let calls = 0;
    expect(await dispatchDomainCommand(
      "surface",
      "motion.support.bundle",
      args,
      {
        scratchRoot,
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; },
        isPathInsideTrustedRoot: async () => { calls += 1; return true; },
        ensureDirectory: async () => { calls += 1; },
        writeJson: async () => { calls += 1; }
      }
    )).toBeNull();
    expect(calls).toBe(0);

    expect(await dispatchDomainCommand(
      "workspace",
      "motion.support.bundle",
      args,
      { scratchRoot }
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: "Support bundle filesystem capabilities are unavailable." } });
  });

  it("keeps HTML and OTIO interchange behind authoring operation ports", async () => {
    const cases = [
      ["motion.html.snippet.export", { packageRoot: "/pkg", outDir: "/html" }],
      ["motion.html.snippet.import", { htmlPath: "/input/index.html", packageDir: "/pkg" }],
      ["motion.otio.export", { packageRoot: "/pkg", outPath: "/out/timeline.otio" }],
      ["motion.otio.import", { otioPath: "/input/timeline.otio", packageDir: "/pkg" }]
    ] as const;
    for (const [command, args] of cases) {
      expect(await dispatchDomainCommand("authoring", command, args)).toMatchObject({
        ok: false,
        error: { code: "capability_unavailable" }
      });
    }
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.html.snippet.export",
      { packageRoot: "/pkg", outDir: "/html" },
      { htmlSnippetExporter: async () => { calls += 1; throw new Error("must not run cross-domain"); } }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps secure source import and storyboard lowering behind authoring I/O ports", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-router-source-"));
    const sourcePath = join(sourceRoot, "source.md");
    const importOutDir = join(sourceRoot, "source-import");
    const storyboardOutDir = join(sourceRoot, "storyboard");
    let writes = 0;
    expect(await dispatchDomainCommand(
      "authoring",
      "motion.source.import",
      { url: "https://example.com/article", outDir: "/source", markdown: "# Source" }
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(await dispatchDomainCommand(
      "authoring",
      "motion.source.import",
      { url: "https://example.com/article", outDir: "/source" },
      { isEmptyOrAbsentDirectory: async () => true, writeText: async () => {}, writeJson: async () => {} }
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: "Secure source fetching is unavailable." } });
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.source.import",
      { url: "https://example.com/article", outDir: "/source", markdown: "# Source" },
      { writeText: async () => { writes += 1; } }
    )).toBeNull();

    let importedMarkdown = "";
    const imported = await dispatchDomainCommand(
      "authoring",
      "motion.source.import",
      {
        url: "https://example.com/article",
        outDir: importOutDir,
        markdown: "# Source\n\nA deterministic source.",
        kind: "article",
        title: "Source"
      },
      {
        authoringOutputRoots: [sourceRoot],
        isEmptyOrAbsentDirectory: async () => true,
        writeText: async (_path, value) => { writes += 1; importedMarkdown = value; },
        writeJson: async () => { writes += 1; }
      }
    );
    expect(imported).toMatchObject({ ok: true, visibleState: { operation: "source.import", kind: "article" } });
    expect(importedMarkdown).toContain("A deterministic source.");

    await writeFile(sourcePath, importedMarkdown, "utf8");
    const storyboard = await dispatchDomainCommand(
      "authoring",
      "motion.source.to_scripted_video",
      { sourcePath, outDir: storyboardOutDir, maxFrames: 2 },
      {
        isEmptyOrAbsentDirectory: async () => true,
        authoringInputRoots: [sourceRoot],
        authoringOutputRoots: [sourceRoot],
        readSourceMarkdown: async () => ({ text: importedMarkdown, sha256: "a".repeat(64) }),
        writeJson: async () => { writes += 1; }
      }
    );
    expect(storyboard).toMatchObject({
      ok: true,
      visibleState: { operation: "source.to_scripted_video", sourcePath }
    });
    expect(writes).toBe(4);
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it("keeps timeline inspection and preset catalogs inside the timeline domain", async () => {
    expect(await dispatchDomainCommand(
      "timeline",
      "motion.timeline.inspect",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third" }
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.inspect",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third" },
      { packageLoader: loadMotionPackage }
    )).toBeNull();
    const inspected = await dispatchDomainCommand(
      "timeline",
      "motion.timeline.inspect",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third" },
      { packageLoader: loadMotionPackage }
    );
    expect(inspected).toMatchObject({
      ok: true,
      visibleState: { panel: "timeline", packageId: "pkg_keyframed_lower_third" },
      result: { motionId: "motion_keyframed_lower_third" }
    });
    expect(await dispatchDomainCommand("timeline", "motion.timeline.easing.presets", {})).toMatchObject({
      ok: true,
      visibleState: { operation: "timeline.easing.presets" }
    });
    expect(await dispatchDomainCommand("timeline", "motion.timeline.animation.presets", {})).toMatchObject({
      ok: true,
      visibleState: { operation: "timeline.animation.presets" }
    });
    expect(await dispatchDomainCommand("surface", "motion.timeline.easing.presets", {})).toBeNull();
    for (const command of [
      "motion.timeline.panel",
      "motion.timeline.keyframes.panel",
      "motion.timeline.transitions.panel",
      "motion.timeline.easing.panel"
    ] as const) {
      expect(await dispatchDomainCommand(
        "timeline",
        command,
        { packageRoot: "../../fixtures/packages/keyframed-lower-third" },
        { packageLoader: loadMotionPackage }
      )).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    }
    expect(await dispatchDomainCommand(
      "timeline",
      "motion.timeline.transitions.panel",
      { packageRoot: "/pkg", edge: "sideways" }
    )).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(await dispatchDomainCommand(
      "timeline",
      "motion.timeline.easing.panel",
      { packageRoot: "/pkg", sampleCount: 1 }
    )).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(await dispatchDomainCommand(
      "timeline",
      "motion.timeline.duration.policy",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third" },
      { packageLoader: loadMotionPackage }
    )).toMatchObject({ ok: true, result: { policy: null, protectedRegions: [] } });
  });

  it("keeps atomic duration-policy edits inside timeline capabilities and own fields", async () => {
    const args = {
      packageRoot: "../../fixtures/packages/keyframed-lower-third",
      outDir: "/out",
      policy: { protectedRegions: [] }
    };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.duration.policy.set", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });

    let packageLoads = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.duration.policy.set",
      args,
      {
        packageLoader: async (path) => { packageLoads += 1; return loadMotionPackage(path); },
        isUnsafePackageOutputDirectory: async () => false,
        isEmptyOrAbsentDirectory: async () => true
      }
    )).toBeNull();
    expect(packageLoads).toBe(0);

    const inheritedRegion = Object.assign(Object.create({ id: "inherited-id" }), { startMs: 0, durationMs: 100 });
    let outputChecks = 0;
    const inherited = await dispatchDomainCommand(
      "timeline",
      "motion.timeline.duration.policy.set",
      { ...args, policy: { protectedRegions: [inheritedRegion] } },
      {
        packageLoader: async (path) => { packageLoads += 1; return loadMotionPackage(path); },
        isUnsafePackageOutputDirectory: async () => { outputChecks += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { outputChecks += 1; return true; }
      }
    );
    expect(inherited).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "protectedRegions[0].id must be a non-empty string." }
    });
    expect(packageLoads).toBe(1);
    expect(outputChecks).toBe(0);
  });

  it("keeps timeline control writes behind timeline-only persistence ports", async () => {
    const args = { packageRoot: "/pkg", atMs: 100 };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.playhead.set", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.playhead.set",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        readTimelineControls: async () => { calls += 1; throw new Error("must not read cross-domain"); },
        writeTimelineControls: async () => { calls += 1; throw new Error("must not write cross-domain"); }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps scene and marker package edits inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", sceneId: "intro" };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.scene.delete", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.scene.delete",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps structural layer edits inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", layerId: "title" };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.layer.delete", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.layer.delete",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps layer property edits inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", layerId: "title", text: "Updated" };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.layer.text.set", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.layer.text.set",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps timeline cleanup inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out" };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.cleanup", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.cleanup",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps track edits inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", trackId: "audio", muted: true };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.track.mute", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.track.mute",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps layer relationship edits inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", layerId: "voice", trackId: "audio" };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.layer.track.assign", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.layer.track.assign",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps transition edits inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", layerId: "title", edge: "in" };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.transition.delete", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.transition.delete",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps caption edits and source reads inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", captionsPath: "/captions.srt" };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.caption.import", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.caption.import",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; },
        readCaptionSource: async () => { calls += 1; throw new Error("must not read cross-domain"); }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps template reads inside authoring-only capabilities", async () => {
    const args = { packageRoot: "/pkg" };
    expect(await dispatchDomainCommand("authoring", "motion.template.panel", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.template.panel",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        templatePanelBuilder: () => { calls += 1; throw new Error("must not build cross-domain"); }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps atomic template mutations inside authoring-only capabilities and own fields", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", values: { title: "Updated" } };
    expect(await dispatchDomainCommand("authoring", "motion.template.apply", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    const capabilities = {
      packageLoader: async () => { calls += 1; throw new Error("must not load"); },
      isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
      isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
    };
    expect(await dispatchDomainCommand("workspace", "motion.template.apply", args, capabilities)).toBeNull();
    expect(calls).toBe(0);

    const inheritedValues = Object.assign(Object.create({ values: { title: "inherited" } }), {
      packageRoot: "/pkg",
      outDir: "/out"
    });
    expect(await dispatchDomainCommand("authoring", "motion.template.apply", inheritedValues, capabilities)).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.template.apply requires values." }
    });
    expect(calls).toBe(0);
  });

  it("keeps package-derived panels inside surface-only capabilities", async () => {
    const args = { packageRoot: "/pkg" };
    expect(await dispatchDomainCommand("surface", "motion.assets.panel", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.assets.panel",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        buildAssetsPanel: async () => { calls += 1; throw new Error("must not build cross-domain"); }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps export and platform verification reads inside surface-only capabilities", async () => {
    expect(await dispatchDomainCommand("surface", "motion.export.panel", {})).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.export.panel",
      {},
      { buildExportPanel: () => { calls += 1; throw new Error("must not build cross-domain"); } }
    )).toBeNull();
    expect(calls).toBe(0);

    const inheritedHosts = Object.assign(Object.create({ requiredHosts: ["linux"] }), {});
    expect(await dispatchDomainCommand(
      "surface",
      "motion.export.panel",
      inheritedHosts,
      { buildExportPanel: () => ({ cards: [], groups: [], defaultPreset: "mp4-h264", recommendedPresets: [] }) }
    )).toMatchObject({ ok: true, result: { ok: true, defaultPreset: "mp4-h264" } });

    const preset = readMotionExportPreset("mp4-h264");
    expect(preset).not.toBeNull();
    expect(await dispatchDomainCommand(
      "surface",
      "motion.export.plan",
      { requiredHosts: ["linux"] },
      {
        chooseExportPreset: () => preset!,
        missingPlatformVerification: (requiredHosts) => ({
          status: "missing",
          platformReceiptCount: 0,
          hostReceiptCount: 0,
          aggregateReceiptCount: 0,
          missingHosts: requiredHosts ?? [],
          failedHosts: []
        }),
        buildExportPlan: ({ platformVerification }) => ({
          preset: "mp4-h264",
          target: "delivery",
          preflight: [],
          warningCount: 1,
          recommendedLane: "browser",
          warnings: [String(platformVerification?.status)]
        })
      }
    )).toMatchObject({ ok: true, result: { warnings: ["missing"] } });
  });

  it("keeps storyboard file reads and builders inside surface-only capabilities", async () => {
    const args = { scriptPath: "/storyboard.json" };
    expect(await dispatchDomainCommand("surface", "motion.storyboard.panel", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.storyboard.panel",
      args,
      {
        readJson: async () => { calls += 1; throw new Error("must not read cross-domain"); },
        buildStoryboardPanel: () => { calls += 1; throw new Error("must not build cross-domain"); }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps aggregate state reads inside surface-only capabilities", async () => {
    const args = { packageRoot: "/pkg" };
    expect(await dispatchDomainCommand("surface", "motion.state", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.state",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        hashPackageIdentity: async () => { calls += 1; throw new Error("must not hash cross-domain"); },
        readTimelineState: async () => { calls += 1; throw new Error("must not read cross-domain"); },
        readReceiptRenderState: async () => { calls += 1; throw new Error("must not summarize cross-domain"); }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps render lifecycle reads inside render-only capabilities", async () => {
    expect(await dispatchDomainCommand("render", "motion.render.status", {})).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.render.status",
      {},
      { readRenderLifecycleState: async () => { calls += 1; throw new Error("must not read cross-domain"); } }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps render lifecycle control writes inside render-only capabilities", async () => {
    const args = { receiptsRoot: "/receipts", receiptId: "render-1" };
    expect(await dispatchDomainCommand("render", "motion.render.cancel", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.render.cancel",
      args,
      {
        readRenderControlTarget: async () => { calls += 1; throw new Error("must not read cross-domain"); },
        writeReceipt: async () => { calls += 1; throw new Error("must not write cross-domain"); }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps preview package reads and browser rendering inside render-only capabilities", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out" };
    expect(await dispatchDomainCommand("render", "motion.preview.frame", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.preview.frame",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        browserFrameRenderer: async () => { calls += 1; throw new Error("must not render cross-domain"); }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps playhead and strip artifact writes inside render-only capabilities", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out" };
    expect(await dispatchDomainCommand("render", "motion.preview.strip", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.preview.strip",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        browserFrameRenderer: async () => { calls += 1; throw new Error("must not render cross-domain"); },
        ensureDirectory: async () => { calls += 1; throw new Error("must not write cross-domain"); },
        hashPackageIdentity: async () => { calls += 1; throw new Error("must not hash cross-domain"); }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps quality manifest analysis inside render-only capabilities", async () => {
    const args = { qualityManifestPath: "/quality.json" };
    expect(await dispatchDomainCommand("render", "motion.quality.panel", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.quality.panel",
      args,
      { readQualityPanel: async () => { calls += 1; throw new Error("must not analyze cross-domain"); } }
    )).toBeNull();
    expect(calls).toBe(0);
    expect(await dispatchDomainCommand(
      "render",
      "motion.quality.panel",
      args,
      {
        readQualityPanel: async () => { calls += 1; throw new Error("must not analyze untrusted paths"); },
        isPathInsideTrustedRoot: async () => false
      }
    )).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.quality.panel qualityManifestPath must be inside packageRoot or a trusted debug input root." }
    });
    expect(calls).toBe(0);
  });

  it("keeps basic keyframe edits inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", layerId: "title", target: "opacity", atMs: 0 };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.keyframe.delete", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.keyframe.delete",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps bulk keyframe and animation edits inside timeline-only atomic ports", async () => {
    const args = { packageRoot: "/pkg", outDir: "/out", layerId: "title", target: "opacity", deltaMs: 100 };
    expect(await dispatchDomainCommand("timeline", "motion.timeline.keyframe.shift", args)).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" }
    });
    let calls = 0;
    expect(await dispatchDomainCommand(
      "workspace",
      "motion.timeline.keyframe.shift",
      args,
      {
        packageLoader: async () => { calls += 1; throw new Error("must not load cross-domain"); },
        isUnsafePackageOutputDirectory: async () => { calls += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { calls += 1; return true; }
      }
    )).toBeNull();
    expect(calls).toBe(0);
  });
});
