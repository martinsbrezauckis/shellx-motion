import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildAgentRuntime, createCliAgentAdapters, type AgentAdapter } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("POSIX provider identity", () => {
  it.skipIf(process.platform === "win32")("pins trusted providers past relative and empty PATH shadows in the prompt cwd", async () => {
    for (const [name, leadingPathEntry] of [["relative", "."], ["empty", ""]] as const) {
      const outDir = await mkdtemp(join(tmpdir(), `shellx-motion-agent-posix-${name}-`));
      tempDirs.push(outDir);
      const trustedDir = join(outDir, "trusted");
      const safeCwd = join(outDir, "safe");
      const untrustedCwd = join(outDir, "package");
      await Promise.all([mkdir(trustedDir), mkdir(safeCwd), mkdir(untrustedCwd)]);
      const pathValue = `${leadingPathEntry}${delimiter}${trustedDir}`;
      for (const adapterId of ["claude-code", "grok"] as const) {
        const providerName = adapterId === "claude-code" ? "claude" : "grok";
        const builtIn = createCliAgentAdapters().find((candidate) => candidate.id === adapterId);
        if (!builtIn) throw new Error(`Missing built-in ${adapterId} adapter.`);
        await writePosixAgentProvider(join(trustedDir, providerName), "trusted");
        await writePosixAgentProvider(join(untrustedCwd, providerName), "shadow");
        const adapter: AgentAdapter = {
          ...builtIn,
          probeCommand: () => ({ ...builtIn.probeCommand(), cwd: safeCwd, env: { PATH: pathValue } }),
          promptCommand: (input) => ({ ...builtIn.promptCommand(input), cwd: input.cwd, env: { PATH: pathValue } }),
        };

        const result = await buildAgentRuntime({ adapters: [adapter] }).runPrompt({
          agentId: adapter.id,
          prompt: "use the trusted provider",
          cwd: untrustedCwd,
          packageId: "lower-third",
          permission: "draft_motion",
        });

        expect(result).toMatchObject({
          ok: true,
          structuredOutput: { provider: "trusted" },
          receipt: { output: { command: { executable: providerName } } },
        });
      }
    }
  }, 45_000);

  it.skipIf(process.platform === "win32")("accepts a provider selected from an absolute trusted POSIX PATH entry", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-agent-posix-absolute-"));
    tempDirs.push(outDir);
    const trustedDir = join(outDir, "trusted");
    const untrustedCwd = join(outDir, "package");
    const providerName = "claude";
    await Promise.all([mkdir(trustedDir), mkdir(untrustedCwd)]);
    await writePosixAgentProvider(join(trustedDir, providerName), "trusted");
    await writePosixAgentProvider(join(untrustedCwd, providerName), "shadow");
    const builtIn = createCliAgentAdapters().find((candidate) => candidate.id === "claude-code");
    if (!builtIn) throw new Error("Missing built-in claude-code adapter.");
    const adapter: AgentAdapter = {
      ...builtIn,
      probeCommand: () => ({ ...builtIn.probeCommand(), env: { PATH: trustedDir } }),
      promptCommand: (input) => ({ ...builtIn.promptCommand(input), env: { PATH: trustedDir } }),
    };

    const result = await buildAgentRuntime({ adapters: [adapter] }).runPrompt({
      agentId: adapter.id,
      prompt: "use the trusted provider",
      cwd: untrustedCwd,
      packageId: "lower-third",
      permission: "draft_motion",
    });

    expect(result).toMatchObject({ ok: true, structuredOutput: { provider: "trusted" } });
  }, 45_000);

  it.skipIf(process.platform === "win32")("refuses a provider replaced after successful POSIX health", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-agent-posix-replacement-"));
    tempDirs.push(outDir);
    const trustedDir = join(outDir, "trusted");
    const providerName = "claude";
    const providerPath = join(trustedDir, providerName);
    const replacementPath = `${providerPath}.replacement`;
    await mkdir(trustedDir);
    await writeFile(providerPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then",
      `  /bin/mv \"$TEST_REPLACE_PATH.replacement\" \"$TEST_REPLACE_PATH\"`,
      "  printf 'trusted 1.0.0\\n'",
      "else",
      "  printf '{\"provider\":\"trusted\"}\\n'",
      "fi",
      "",
    ].join("\n"), "utf8");
    await writePosixAgentProvider(replacementPath, "replacement");
    await chmod(providerPath, 0o700);
    const builtIn = createCliAgentAdapters().find((candidate) => candidate.id === "claude-code");
    if (!builtIn) throw new Error("Missing built-in claude-code adapter.");
    const adapter: AgentAdapter = {
      ...builtIn,
      probeCommand: () => ({ ...builtIn.probeCommand(), env: { PATH: trustedDir, TEST_REPLACE_PATH: providerPath } }),
      promptCommand: (input) => ({ ...builtIn.promptCommand(input), env: { PATH: trustedDir, TEST_REPLACE_PATH: providerPath } }),
    };

    const result = await buildAgentRuntime({ adapters: [adapter] }).runPrompt({
      agentId: adapter.id,
      prompt: "do not run the replacement",
      packageId: "lower-third",
      permission: "draft_motion",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "agent_failed",
        message: "claude-code exited with code 127.",
        detail: "Motion POSIX agent provider identity changed before execution.",
      },
      receipt: { status: "failed" },
    });
    await expect(readFile(providerPath, "utf8")).resolves.toContain('"replacement"');
  }, 45_000);
});

async function writePosixAgentProvider(path: string, provider: string): Promise<void> {
  await writeFile(path, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    `  printf '${provider} 1.0.0\\n'`,
    "else",
    `  printf '{\"provider\":\"${provider}\"}\\n'`,
    "fi",
    "",
  ].join("\n"), "utf8");
  await chmod(path, 0o700);
}
