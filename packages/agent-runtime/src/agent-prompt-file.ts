import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  OutputDirectoryReservation,
  assertOutputLeafIdentity,
  captureOutputLeaf,
  writeVerifiedBoundedFile
} from "@shellx-motion/core";
import {
  createTrustedWorkspaceAnchor,
  withTrustedWorkspaceAnchor
} from "@shellx-motion/core/internal/trusted-host-workspace";
import type { AgentCommand } from "./index";

export async function materializeAgentPromptFile(
  command: AgentCommand,
  scratchRoot: string
): Promise<{ command: AgentCommand; cleanup: () => Promise<void> }> {
  if (!command.promptFileArg) return { command, cleanup: async () => undefined };
  if (command.stdin === undefined) throw new Error("Agent prompt-file transport requires prompt stdin.");
  const occurrences = command.args.filter((arg) => arg === command.promptFileArg).length;
  if (occurrences !== 1) throw new Error(`Agent prompt-file argv must contain its marker exactly once; found ${occurrences}.`);

  const promptRoot = resolve(scratchRoot, "agent-prompts");
  const scratchAnchor = process.platform === "win32" ? undefined : await createTrustedWorkspaceAnchor(scratchRoot);
  const withinScratchRoot = async <T>(operation: () => Promise<T>): Promise<T> => scratchAnchor
    ? await withTrustedWorkspaceAnchor(scratchAnchor, operation)
    : await operation();
  const promptDirectory = await withinScratchRoot(async () => await OutputDirectoryReservation.acquire(promptRoot, {
    allowExistingContents: true,
    requireExclusiveChildAuthority: true
  }));
  await withinScratchRoot(async () => await promptDirectory.assertCurrent());
  const promptPath = join(promptDirectory.path, `${randomUUID()}.txt`);
  const promptBytes = Buffer.from(command.stdin, "utf8");
  await withinScratchRoot(async () => await writeVerifiedBoundedFile(promptPath, promptBytes, {
    label: "Agent prompt file",
    maxBytes: promptBytes.byteLength,
    withinRoot: promptDirectory.path
  }));
  const promptIdentity = await captureOutputLeaf(promptPath);
  if (promptIdentity.kind !== "file") {
    throw new Error("Agent prompt file did not materialize as a regular non-symlink file.");
  }
  await withinScratchRoot(async () => {
    await promptDirectory.assertCurrent();
    await assertOutputLeafIdentity(promptPath, promptIdentity, "Agent prompt file");
  });
  return {
    command: {
      ...command,
      args: command.args.map((arg) => arg === command.promptFileArg ? promptPath : arg),
      stdin: undefined,
      promptFileArg: undefined
    },
    cleanup: async () => {
      try {
        await withinScratchRoot(async () => {
          await promptDirectory.assertCurrent();
          await assertOutputLeafIdentity(promptPath, promptIdentity, "Agent prompt file");
          await unlink(promptPath);
        });
      } catch {
        // The directory or leaf changed after admission; leave it untouched.
      }
    }
  };
}
