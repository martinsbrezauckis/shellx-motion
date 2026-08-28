import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeAgentPromptFile } from "./agent-prompt-file";
import type { AgentCommand } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("agent prompt-file materialization", () => {
  it("refuses a symlinked or junction prompt root without writing outside admitted scratch", async ({ skip }) => {
    const root = await scratch("root-link");
    const scratchRoot = join(root, "scratch");
    const foreignPromptRoot = join(root, "foreign-prompts");
    await Promise.all([mkdir(scratchRoot, { mode: 0o700 }), mkdir(foreignPromptRoot, { mode: 0o700 })]);
    try {
      await symlink(foreignPromptRoot, join(scratchRoot, "agent-prompts"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create a junction.");
        return;
      }
      throw error;
    }

    await expect(materializeAgentPromptFile(command(), scratchRoot)).rejects.toThrow(/private directory or absent/i);
    await expect(readdir(foreignPromptRoot)).resolves.toEqual([]);
  });

  it("does not unlink a prompt path replaced after materialization", async () => {
    const root = await scratch("replacement");
    const scratchRoot = join(root, "scratch");
    await mkdir(scratchRoot, { mode: 0o700 });
    const prepared = await materializeAgentPromptFile(command(), scratchRoot);
    const promptPath = prepared.command.args[0];
    await rename(promptPath, `${promptPath}.moved`);
    await writeFile(promptPath, "competitor", "utf8");

    await prepared.cleanup();

    await expect(readFile(promptPath, "utf8")).resolves.toBe("competitor");
  });
});

function command(): AgentCommand {
  return {
    executable: "fixture-agent",
    args: ["<prompt-file>"],
    stdin: "private plan request",
    promptFileArg: "<prompt-file>",
    shell: false
  };
}

async function scratch(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-agent-prompt-${label}-`));
  tempDirs.push(root);
  return root;
}
