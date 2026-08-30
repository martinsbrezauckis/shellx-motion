import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHILD_RESULT_SCHEMA_VERSION,
  PUBLIC_TEST_SUITE,
  assertNoRunnerArguments,
  assertSafeChildResultPath,
  formatChildResultSummary,
  runPublicTestChildren,
  writeChildResultEnvelope,
  type PublicTestChild,
  type PublicTestChildEnvelope,
} from "./run-public-test-children";

const fixture = fileURLToPath(new URL("./fixtures/public-test-child.mjs", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-public-test-children-"));
  temporaryRoots.push(root);
  return root;
}

function fixtureChild(id: string, outcome: "pass" | "fail", logPath: string): PublicTestChild {
  return {
    id,
    command: `fixture ${outcome} ${id}`,
    executable: process.execPath,
    args: [fixture, outcome, logPath, id],
  };
}

describe("public test child runner", () => {
  it("collects every ordinary failure and continues in declaration order", async () => {
    const root = await temporaryRoot();
    const logPath = join(root, "children.log");
    const envelope = await runPublicTestChildren([
      fixtureChild("first", "pass", logPath),
      fixtureChild("broken", "fail", logPath),
      fixtureChild("last", "pass", logPath),
    ]);

    expect(envelope.status).toBe("fail");
    expect(envelope.children.map((child) => [child.id, child.status, child.exitCode, child.signal])).toEqual([
      ["first", "pass", 0, null],
      ["broken", "fail", 23, null],
      ["last", "pass", 0, null],
    ]);
    expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual(["first", "broken", "last"]);
  });

  it("records a missing executable as failed and still runs later children", async () => {
    const root = await temporaryRoot();
    const logPath = join(root, "children.log");
    const envelope = await runPublicTestChildren([
      fixtureChild("first", "pass", logPath),
      { id: "missing", command: "missing executable", executable: join(root, "not-present"), args: [] },
      fixtureChild("last", "pass", logPath),
    ]);

    expect(envelope.status).toBe("fail");
    expect(envelope.children.map((child) => [child.id, child.status, child.exitCode, child.signal])).toEqual([
      ["first", "pass", 0, null],
      ["missing", "fail", null, null],
      ["last", "pass", 0, null],
    ]);
    expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual(["first", "last"]);
  });

  it("writes one create-only envelope for an all-pass run", async () => {
    const root = await temporaryRoot();
    const logPath = join(root, "children.log");
    const receiptPath = join(root, "public-test-children.json");
    const envelope = await runPublicTestChildren([
      fixtureChild("first", "pass", logPath),
      fixtureChild("last", "pass", logPath),
    ]);

    expect(envelope.status).toBe("pass");
    writeChildResultEnvelope(receiptPath, envelope);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(Object.keys(receipt)).toEqual(["schemaVersion", "suite", "status", "children"]);
    expect(Object.keys(receipt.children[0])).toEqual(["id", "command", "status", "exitCode", "signal", "durationMs"]);
    expect(receipt).toMatchObject({
      schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
      suite: PUBLIC_TEST_SUITE,
      status: "pass",
      children: [
        { id: "first", command: "fixture pass first", status: "pass", exitCode: 0, signal: null },
        { id: "last", command: "fixture pass last", status: "pass", exitCode: 0, signal: null },
      ],
    });
    const deterministicEnvelope = {
      schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
      suite: PUBLIC_TEST_SUITE,
      status: "pass",
      children: [{ id: "fixture", command: "node fixture", status: "pass", exitCode: 0, signal: null, durationMs: 7 }],
    } satisfies PublicTestChildEnvelope;
    expect(formatChildResultSummary(deterministicEnvelope)).toBe(
      '{"schemaVersion":"release-studio.gate-child-results.v1","suite":"shellx-motion/test-public","status":"pass","children":[{"id":"fixture","command":"node fixture","status":"pass","exitCode":0,"signal":null,"durationMs":7}]}',
    );
    await expect(readdir(root)).resolves.not.toContain(expect.stringContaining(".tmp-"));
    expect(() => writeChildResultEnvelope(receiptPath, envelope)).toThrow(/destination already exists/);
  });

  it("rejects unknown arguments and unsafe receipt destinations before execution", async () => {
    const root = await temporaryRoot();
    const existingPath = join(root, "existing.json");
    const directoryPath = join(root, "directory-target");
    const symlinkPath = join(root, "symlink-target.json");
    await writeFile(existingPath, "already here\n", "utf8");
    await mkdir(directoryPath);
    await symlink(existingPath, symlinkPath);

    expect(() => assertNoRunnerArguments(["--unrecognised"])).toThrow(/accepts no arguments/);
    expect(() => assertSafeChildResultPath("relative-result.json")).toThrow(/normalized absolute path/);
    expect(() => assertSafeChildResultPath(existingPath)).toThrow(/destination already exists/);
    expect(() => assertSafeChildResultPath(directoryPath)).toThrow(/destination is not a regular file/);
    expect(() => assertSafeChildResultPath(symlinkPath)).toThrow(/destination is a symlink/);
  });
});
