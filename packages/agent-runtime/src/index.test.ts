import { access, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgentRuntime,
  claudeCodeCliCommand,
  codexCliCommand,
  createCliAgentAdapters,
  DEFAULT_AGENT_OUTPUT_MAX_BYTES,
  grokCliCommand,
  type AgentAdapter,
  type AgentCommand,
  type AgentRunner
} from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fakeAdapter: AgentAdapter = {
  id: "fake",
  label: "Fake Agent",
  transport: "local-cli",
  billing: "cli-subscription",
  probeCommand: () => ({ executable: "fake-agent", args: ["--version"], shell: false }),
  promptCommand: (input) => ({ executable: "fake-agent", args: ["run", "--json"], cwd: input.cwd, stdin: input.prompt, shell: false })
};

function agentWithProbe(id: string, executable: string): AgentAdapter {
  return {
    ...fakeAdapter,
    id,
    label: `${id} Agent`,
    probeCommand: () => ({ executable, args: ["--version"], shell: false }),
    promptCommand: (input) => ({ executable, args: ["run"], stdin: input.prompt, shell: false })
  };
}

describe("local CLI agent runtime", () => {
  it("defaults to subscription-backed local CLI agents with Codex first", () => {
    const agents = createCliAgentAdapters();

    expect(agents.map((agent) => agent.id)).toEqual(["codex", "claude-code", "grok", "antigravity"]);
    expect(agents.every((agent) => agent.transport === "local-cli")).toBe(true);
    expect(agents.every((agent) => agent.billing === "cli-subscription")).toBe(true);
  });

  it("builds Codex commands as argv without shell interpolation", () => {
    const command = codexCliCommand({ prompt: "preview current package", cwd: "/workspace" });

    expect(command).toMatchObject({
      executable: "codex",
      cwd: "/workspace",
      shell: false
    });
    expect(command.args).toEqual([
      "exec", "--json", "--sandbox", "read-only", "--ask-for-approval", "never",
      "--ephemeral"
    ]);
    expect(command.stdin).toBe("preview current package");
  });

  it("forces every stdin provider into a proposal-only, non-persistent command contract", () => {
    const claude = claudeCodeCliCommand({ prompt: "plan only", cwd: "/workspace" });
    expect(claude.args).toEqual([
      "--print", "--output-format", "json", "--permission-mode", "plan", "--safe-mode",
      "--no-chrome", "--no-session-persistence", "--disallowedTools",
      "Bash,Edit,Write,NotebookEdit,Agent,Task,WebFetch,WebSearch"
    ]);
    expect(claude.stdin).toBe("plan only");

    const grok = grokCliCommand({ prompt: "plan only", cwd: "/workspace" });
    expect(grok.args).toEqual([
      "--output-format", "json", "--permission-mode", "plan", "--no-subagents",
      "--disable-web-search", "--tools=", "--no-memory", "--prompt-file", "<prompt-file>"
    ]);
    expect(grok.stdin).toBe("plan only");
    expect(grok.promptFileArg).toBe("<prompt-file>");
  });

  it("materializes prompt-file transports only for the child lifetime", async () => {
    const promptFileAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "prompt-file",
      probeCommand: () => ({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"], shell: false }),
      promptCommand: (input) => ({
        executable: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs');const p=process.argv[1];process.stdout.write(JSON.stringify({prompt:fs.readFileSync(p,'utf8'),path:p}))",
          "<prompt-file>"
        ],
        stdin: input.prompt,
        promptFileArg: "<prompt-file>",
        shell: false
      })
    };
    const runtime = buildAgentRuntime({ adapters: [promptFileAdapter] });
    const result = await runtime.runPrompt({
      agentId: "prompt-file",
      prompt: "private plan request",
      packageId: "fixture",
      permission: "draft_motion"
    });

    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { prompt: "private plan request" },
      receipt: { output: { command: { args: ["-e", expect.any(String), "<prompt-file>"] } } }
    });
    if (!result.ok) return;
    const promptPath = (result.structuredOutput as { path: string }).path;
    await expect(access(promptPath)).rejects.toThrow();
  }, 45_000);

  it("reports agent health by probing each configured CLI", async () => {
    const commands: AgentCommand[] = [];
    const runner: AgentRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "fake-agent 1.0.0", stderr: "" };
    };
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner });

    await expect(runtime.health()).resolves.toEqual([
      {
        agentId: "fake",
        available: true,
        command: "fake-agent",
        transport: "local-cli",
        billing: "cli-subscription",
        detail: "fake-agent 1.0.0",
        status: "ready",
        version: "fake-agent 1.0.0",
        setup: {
          checkCommand: "fake-agent --version",
          installHint: "Install Fake Agent CLI and ensure fake-agent is on PATH.",
          authHint: "Authenticate Fake Agent CLI with its local login command before running Motion prompts.",
          quotaHint: "Check Fake Agent CLI subscription quota or retry after the provider limit resets."
        },
        probe: { executable: "fake-agent", args: ["--version"], shell: false }
      }
    ]);
    expect(commands).toEqual([{
      executable: "fake-agent",
      args: ["--version"],
      maxOutputBytes: DEFAULT_AGENT_OUTPUT_MAX_BYTES,
      shell: false
    }]);
  });

  it("classifies missing agent binaries with setup hints", async () => {
    const runner: AgentRunner = async () => ({ exitCode: 127, stdout: "", stderr: "spawn fake-agent ENOENT" });
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner });

    await expect(runtime.health()).resolves.toEqual([
      expect.objectContaining({
        agentId: "fake",
        available: false,
        status: "missing_binary",
        detail: "spawn fake-agent ENOENT",
        setup: expect.objectContaining({
          checkCommand: "fake-agent --version",
          installHint: "Install Fake Agent CLI and ensure fake-agent is on PATH."
        }),
        failure: {
          exitCode: 127,
          stderr: "spawn fake-agent ENOENT"
        }
      })
    ]);
  });

  it("classifies auth, quota, timeout, and generic probe failures without leaking secrets", async () => {
    const adapters: AgentAdapter[] = [
      agentWithProbe("auth", "auth-agent"),
      agentWithProbe("quota", "quota-agent"),
      agentWithProbe("timeout", "timeout-agent"),
      agentWithProbe("failed", "failed-agent")
    ];
    const runtime = buildAgentRuntime({
      adapters,
      runner: async (command) => {
        if (command.executable === "auth-agent") return { exitCode: 1, stdout: "", stderr: "OPENAI_API_KEY=sk-local not logged in; run auth-agent login" };
        if (command.executable === "quota-agent") return { exitCode: 1, stdout: "", stderr: "Too many requests for the user" };
        if (command.executable === "timeout-agent") return { exitCode: 124, stdout: "", stderr: "Agent command timed out after 50ms." };
        return { exitCode: 2, stdout: "", stderr: "unexpected provider failure" };
      }
    });

    const health = await runtime.health();

    expect(health[0]).toMatchObject({
      agentId: "auth",
      available: false,
      status: "auth_required",
      detail: "OPENAI_API_KEY=[redacted] not logged in; run auth-agent login",
      failure: { exitCode: 1, stderr: "OPENAI_API_KEY=[redacted] not logged in; run auth-agent login" }
    });
    expect(health[1]).toMatchObject({
      agentId: "quota",
      available: false,
      status: "quota_limited",
      detail: "Too many requests for the user"
    });
    expect(health[2]).toMatchObject({
      agentId: "timeout",
      available: false,
      status: "timeout",
      detail: "Agent command timed out after 50ms."
    });
    expect(health[3]).toMatchObject({
      agentId: "failed",
      available: false,
      status: "failed",
      detail: "unexpected provider failure"
    });
  });

  it("runs the selected agent and returns a receipt-grade transcript", async () => {
    const runner: AgentRunner = async (command) => {
      if (command.args.includes("--version")) {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
      return { exitCode: 0, stdout: JSON.stringify({ calls: ["motion.preview.frame"] }), stderr: "" };
    };
    const runtime = buildAgentRuntime({
      adapters: [fakeAdapter],
      runner,
      now: () => "2026-06-29T20:31:00.000Z"
    });

    const result = await runtime.runPrompt({
      agentId: "fake",
      prompt: "preview current package",
      cwd: "/workspace",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "agent.prompt",
      status: "passed",
      packageId: "lower-third",
      lane: "agent",
      createdAt: "2026-06-29T20:31:00.000Z",
      output: {
        agentId: "fake",
        command: { executable: "fake-agent", args: ["run", "--json"], cwd: "/workspace", shell: false }
      }
    });
    expect(result.receipt.inputHashes.prompt).toHaveLength(64);
    expect(result.structuredOutput).toEqual({ calls: ["motion.preview.frame"] });
    expect(result.transcript).toEqual({
      stdout: JSON.stringify({ calls: ["motion.preview.frame"] }),
      stderr: "",
      redacted: true,
      truncated: false,
      maxBytes: 64 * 1024
    });
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
    expect(result.receipt.output).toMatchObject({
      transcript: [
        { role: "user", contentSha256: result.receipt.inputHashes.prompt },
        { role: "agent", content: JSON.stringify({ calls: ["motion.preview.frame"] }) }
      ]
    });
  });

  it("kills prompt commands that exceed their timeout", async () => {
    const slowAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "slow",
      probeCommand: () => ({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"], shell: false }),
      promptCommand: (input) => ({
        executable: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('late'), 200)"],
        stdin: input.prompt,
        shell: false,
        timeoutMs: 50
      } as AgentCommand)
    };
    const runtime = buildAgentRuntime({ adapters: [slowAdapter] });

    const result = await runtime.runPrompt({
      agentId: "slow",
      prompt: "render a timed out agent response",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "agent_failed",
        message: "slow exited with code 124.",
        detail: "Agent command timed out after 50ms."
      },
      receipt: {
        output: {
          resources: {
            schema: "shellx-motion/local-job-resources@1",
            lane: "agent",
            operation: "agent.prompt",
            state: "passed",
            watchedProcessCount: 1,
          },
        },
      },
    });
  }, 45_000);

  it("preserves prompt stdin and structured stdout through the contained local process boundary", async () => {
    const nativeAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "native-stdio",
      probeCommand: () => ({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"], shell: false }),
      promptCommand: (input) => ({
        executable: process.execPath,
        args: [
          "-e",
          "let value=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ prompt: value })))",
        ],
        stdin: input.prompt,
        shell: false,
      }),
    };
    const runtime = buildAgentRuntime({ adapters: [nativeAdapter] });

    const result = await runtime.runPrompt({
      agentId: "native-stdio",
      prompt: "contained prompt with spaces and a quote: \"yes\"",
      packageId: "lower-third",
      permission: "render_motion",
    });

    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { prompt: "contained prompt with spaces and a quote: \"yes\"" },
      receipt: {
        output: {
          resources: {
            processContainment: process.platform === "win32"
              ? { mode: "windows-job-object", status: "enforced", killTree: true }
              : { mode: "unix-process-group", status: "enforced", killTree: true },
          },
        },
      },
    });
  }, 45_000);

  it("terminates agent descendants through the enforced platform containment primitive", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-agent-process-tree-"));
    tempDirs.push(outDir);
    const grandchildPidPath = join(outDir, "grandchild.pid");
    const parentCode = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])",
      "writeFileSync(process.argv[1], String(child.pid))",
      "setInterval(() => {}, 1000)"
    ].join("; ");
    const containedAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "contained",
      probeCommand: () => ({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"], shell: false }),
      promptCommand: (input) => ({
        executable: process.execPath,
        args: ["-e", parentCode, grandchildPidPath],
        stdin: input.prompt,
        timeoutMs: process.platform === "win32" ? 1_000 : 300,
        shell: false,
      }),
    };
    const runtime = buildAgentRuntime({ adapters: [containedAdapter] });

    const result = await runtime.runPrompt({
      agentId: "contained",
      prompt: "prove descendant teardown",
      packageId: "lower-third",
      permission: "render_motion",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "agent_failed", message: "contained exited with code 124." },
      receipt: {
        output: {
          resources: process.platform === "win32"
            ? {
                processContainment: {
                  mode: "windows-job-object",
                  status: "enforced",
                  killTree: true,
                  memoryLimit: "job-commit",
                  launcher: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
                },
              }
            : {
                processContainment: {
                  mode: "unix-process-group",
                  status: "enforced",
                  killTree: true,
                  memoryLimit: "rss-monitor",
                },
              },
        },
      },
    });
    const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    await expectProcessToExit(grandchildPid);
  }, 45_000);

  it.skipIf(process.platform !== "win32")("resolves a bare native agent executable from the trusted Windows PATH in strict mode", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-agent-native-path-"));
    tempDirs.push(outDir);
    const binDir = join(outDir, "bin");
    await mkdir(binDir);
    await copyFile(process.execPath, join(binDir, "path-agent.exe"));
    const originalRequireNative = process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
    process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT = "1";
    const nativePath = `${binDir};${process.env.PATH ?? process.env.Path ?? ""}`;
    const pathAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "native-path",
      probeCommand: () => ({
        executable: "path-agent",
        args: ["-e", "process.stdout.write('path-agent 1.0.0')"],
        env: { PATH: nativePath },
        shell: false,
      }),
      promptCommand: () => ({ executable: "path-agent", args: [], env: { PATH: nativePath }, shell: false }),
    };
    try {
      const [health] = await buildAgentRuntime({ adapters: [pathAdapter] }).health();
      expect(health).toMatchObject({ agentId: "native-path", available: true, status: "ready", version: "path-agent 1.0.0" });
    } finally {
      if (originalRequireNative === undefined) delete process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT;
      else process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT = originalRequireNative;
    }
  }, 45_000);

  it("redacts secret-looking stdout and stderr before writing agent receipts", async () => {
    const runner: AgentRunner = async (command) => {
      if (command.args.includes("--version")) {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ message: "result OPENAI_API_KEY=sk-local token=abc" }),
        stderr: "AWS_SECRET_ACCESS_KEY=abc123 failed"
      };
    };
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner });

    const result = await runtime.runPrompt({
      agentId: "fake",
      prompt: "preview current package",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.warnings).toEqual(["AWS_SECRET_ACCESS_KEY=[redacted] failed"]);
    expect(result.receipt.output.transcript).toEqual([
      { role: "user", contentSha256: result.receipt.inputHashes.prompt },
      { role: "agent", content: JSON.stringify({ message: "result OPENAI_API_KEY=[redacted] token=[redacted]" }) },
      { role: "stderr", content: "AWS_SECRET_ACCESS_KEY=[redacted] failed" }
    ]);
    expect(result.structuredOutput).toEqual({ message: "result OPENAI_API_KEY=[redacted] token=[redacted]" });
  });

  it("redacts JSON-style secret fields before writing agent receipts", async () => {
    const runner: AgentRunner = async (command) => {
      if (command.args.includes("--version")) {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: "{\"apiKey\":\"sk-json\",\"refresh_token\":\"rt-json\",\"password\":\"pw-json\"}",
        stderr: "plain secretKey: sk-colon"
      };
    };
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner });

    const result = await runtime.runPrompt({
      agentId: "fake",
      prompt: "preview current package",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.warnings).toEqual(["plain secretKey: [redacted]"]);
    expect(result.receipt.output.transcript).toEqual([
      { role: "user", contentSha256: result.receipt.inputHashes.prompt },
      { role: "agent", content: "{\"apiKey\":\"[redacted]\",\"refresh_token\":\"[redacted]\",\"password\":\"[redacted]\"}" },
      { role: "stderr", content: "plain secretKey: [redacted]" }
    ]);
  });

  it("redacts bare provider token patterns before writing agent receipts", async () => {
    const openAiToken = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"].join("-");
    const githubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz012345"].join("_");
    const npmToken = ["npm", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"].join("_");
    const runner: AgentRunner = async (command) => {
      if (command.args.includes("--version")) {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ message: `agent returned ${openAiToken} and ${githubToken}` }),
        stderr: `npm token ${npmToken}`
      };
    };
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner });

    const result = await runtime.runPrompt({
      agentId: "fake",
      prompt: "preview current package",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.warnings).toEqual(["npm token [redacted]"]);
    expect(result.receipt.output.transcript).toEqual([
      { role: "user", contentSha256: result.receipt.inputHashes.prompt },
      { role: "agent", content: JSON.stringify({ message: "agent returned [redacted] and [redacted]" }) },
      { role: "stderr", content: "npm token [redacted]" }
    ]);
  });

  it("redacts authorization bearer tokens before writing agent receipts", async () => {
    const stdoutBearer = "stdout-bearer-token-abcdefghijklmnopqrstuvwxyz012345";
    const stderrBearer = "stderr-bearer-token-abcdefghijklmnopqrstuvwxyz012345";
    const runner: AgentRunner = async (command) => {
      if (command.args.includes("--version")) {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ message: `Authorization: Bearer ${stdoutBearer}` }),
        stderr: `authorization: bearer ${stderrBearer}`
      };
    };
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner });

    const result = await runtime.runPrompt({
      agentId: "fake",
      prompt: "preview current package",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.warnings).toEqual(["authorization: bearer [redacted]"]);
    expect(result.receipt.output.transcript).toEqual([
      { role: "user", contentSha256: result.receipt.inputHashes.prompt },
      { role: "agent", content: JSON.stringify({ message: "Authorization: Bearer [redacted]" }) },
      { role: "stderr", content: "authorization: bearer [redacted]" }
    ]);
  });

  it("parses JSONL transport events and redacts the structured result", async () => {
    const runner: AgentRunner = async (command) => command.args.includes("--version")
      ? { exitCode: 0, stdout: "ok", stderr: "" }
      : {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "started" }),
            JSON.stringify({ type: "item.completed", item: { text: JSON.stringify({ ok: true, apiKey: "sk-json-secret" }) } })
          ].join("\n"),
          stderr: ""
        };
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner });

    const result = await runtime.runPrompt({
      agentId: "fake",
      prompt: "return JSONL",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structuredOutput).toEqual({ ok: true, apiKey: "[redacted]" });
  });

  it("unwraps a direct JSON transport envelope before exposing structured output", async () => {
    const runner: AgentRunner = async (command) => command.args.includes("--version")
      ? { exitCode: 0, stdout: "ok", stderr: "" }
      : {
          exitCode: 0,
          stdout: JSON.stringify({ type: "result", result: JSON.stringify({ accepted: true, token: "secret-value" }) }),
          stderr: ""
        };
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner });

    const result = await runtime.runPrompt({
      agentId: "fake",
      prompt: "return an enveloped result",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structuredOutput).toEqual({ accepted: true, token: "[redacted]" });
  });

  it("fails closed when successful process output is not structured JSON", async () => {
    const runner: AgentRunner = async (command) => command.args.includes("--version")
      ? { exitCode: 0, stdout: "ok", stderr: "" }
      : { exitCode: 0, stdout: "not JSON OPENAI_API_KEY=sk-secret", stderr: "" };
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner });

    const result = await runtime.runPrompt({
      agentId: "fake",
      prompt: "return invalid output",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "agent_invalid_output", detail: "not JSON OPENAI_API_KEY=[redacted]" },
      receipt: { status: "failed" }
    });
    expect(result).not.toHaveProperty("stdout");
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("bounds oversized custom-runner probe output before publishing health", async () => {
    const runner: AgentRunner = async () => ({ exitCode: 0, stdout: "v".repeat(4096), stderr: "" });
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter], runner, maxOutputBytes: 128 });

    const [health] = await runtime.health();

    expect(health).toMatchObject({ available: false, status: "failed", failure: { exitCode: 125 } });
    expect(Buffer.byteLength(health.detail)).toBeLessThanOrEqual(128);
    expect(health.probe).not.toHaveProperty("maxOutputBytes");
  });

  it("terminates a noisy agent at the output ceiling and returns only a bounded transcript", async () => {
    const noisyAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "noisy",
      probeCommand: () => ({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"], shell: false }),
      promptCommand: (input) => ({
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(200000)); setTimeout(() => {}, 1000)"],
        stdin: input.prompt,
        shell: false
      })
    };
    const runtime = buildAgentRuntime({ adapters: [noisyAdapter], maxOutputBytes: 1024, maxTranscriptBytes: 256 });

    const result = await runtime.runPrompt({
      agentId: "noisy",
      prompt: "be noisy",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "agent_failed", message: "noisy exited with code 125." },
      receipt: { status: "failed" }
    });
    if (!result.receipt) return;
    const transcript = result.receipt.output.transcript.map((entry) => "content" in entry ? entry.content : "").join("");
    expect(Buffer.byteLength(transcript)).toBeLessThanOrEqual(256);
    expect(JSON.stringify(result)).not.toContain("x".repeat(1025));
  }, 45_000);

  it("does not fall back to another CLI when the selected agent is unavailable", async () => {
    const commands: AgentCommand[] = [];
    const fallbackAdapter: AgentAdapter = {
      ...fakeAdapter,
      id: "fallback",
      probeCommand: () => ({ executable: "fallback-agent", args: ["--version"], shell: false }),
      promptCommand: (input) => ({ executable: "fallback-agent", args: ["run"], stdin: input.prompt, shell: false })
    };
    const runner: AgentRunner = async (command) => {
      commands.push(command);
      return command.executable === "fake-agent"
        ? { exitCode: 127, stdout: "", stderr: "command not found" }
        : { exitCode: 0, stdout: "fallback should not run", stderr: "" };
    };
    const runtime = buildAgentRuntime({ adapters: [fakeAdapter, fallbackAdapter], runner });

    const result = await runtime.runPrompt({
      agentId: "fake",
      prompt: "make a lower third",
      packageId: "lower-third",
      permission: "draft_motion"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "agent_unavailable",
        message: "fake is unavailable. No fallback agent was executed."
      }
    });
    expect(commands).toEqual([{
      executable: "fake-agent",
      args: ["--version"],
      maxOutputBytes: DEFAULT_AGENT_OUTPUT_MAX_BYTES,
      shell: false
    }]);
  });
});

async function expectProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Agent descendant ${pid} remained alive after contained termination.`);
}
