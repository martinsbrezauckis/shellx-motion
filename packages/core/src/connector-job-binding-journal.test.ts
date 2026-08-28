import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMotionConnectorJobBinding,
  MOTION_CONNECTOR_JOB_BINDING_MAX_BYTES,
  MotionConnectorJobBindingJournal,
  motionConnectorJobBindingFileName,
  motionConnectorJobOwnerBindingFileName,
  parseMotionConnectorJobBinding,
  type MotionConnectorJobBindingInput
} from "./connector-job-binding-journal";
import { canonicalJson } from "./canonical-json";
import { motionJobFileKey } from "./job-id-file";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function createJournal(): Promise<{ root: string; journal: MotionConnectorJobBindingJournal }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-binding-"));
  roots.push(root);
  return { root, journal: new MotionConnectorJobBindingJournal({ bindingRoot: root }) };
}

function binding(overrides: Partial<MotionConnectorJobBindingInput> = {}): MotionConnectorJobBindingInput {
  return {
    jobId: "cut:connector-render-1",
    callerId: "cut:workspace-a",
    capabilityId: "connector.future-render@1",
    descriptorRevision: 3,
    descriptorFingerprint: "a".repeat(64),
    requestSchemaId: "shellx-motion/connector-request/future-render@1",
    catalogFingerprint: "b".repeat(64),
    request: { input: "opaque-source-1", output: "opaque-output-1", quality: "cinematic", durationms: 5000, includeaudio: false },
    ...overrides
  };
}

function bindingPath(root: string, callerId: string, jobId: string): string {
  return join(root, motionConnectorJobOwnerBindingFileName(callerId, jobId));
}

describe("MotionConnectorJobBindingJournal", () => {
  it("keeps the one-argument public filename helper on its legacy contract", () => {
    const jobId = "cut:connector-render-1";
    expect(motionConnectorJobBindingFileName(jobId)).toBe(`${motionJobFileKey(jobId)}.connector-binding.json`);
  });

  it("atomically stores one immutable binding and accepts an identical canonical replay", async () => {
    const { journal } = await createJournal();
    const [first, concurrentReplay] = await Promise.all([journal.write(binding()), journal.write(binding())]);
    const accepted = [first, concurrentReplay].filter((result): result is Extract<typeof result, { ok: true }> => result.ok);
    expect(accepted).toHaveLength(2);
    expect(accepted.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(accepted[0]).toMatchObject({ binding: { schema: "shellx-motion/connector-job-binding@1", jobId: "cut:connector-render-1" } });

    const replay = await journal.write(binding({ request: { includeaudio: false, durationms: 5000, quality: "cinematic", output: "opaque-output-1", input: "opaque-source-1" } }));
    expect(replay).toMatchObject({ ok: true, replayed: true, binding: { fingerprint: accepted[0]!.binding.fingerprint } });
  });

  it("refuses a different binding for the same job without overwriting the original", async () => {
    const { journal } = await createJournal();
    await expect(journal.write(binding())).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(journal.write(binding({ request: { input: "opaque-source-2", output: "opaque-output-1", quality: "cinematic", durationms: 5000, includeaudio: false } })))
      .resolves.toEqual({ ok: false, code: "binding_conflict" });
    await expect(journal.read({ jobId: "cut:connector-render-1", callerId: "cut:workspace-a" }))
      .resolves.toMatchObject({ ok: true, binding: { request: { input: "opaque-source-1" } } });
  });

  it("never discloses a binding to another caller", async () => {
    const { journal } = await createJournal();
    await journal.write(binding());
    await expect(journal.read({ jobId: "cut:connector-render-1", callerId: "design-studio:workspace-a" }))
      .resolves.toEqual({ ok: false, code: "binding_unknown" });
  });

  it("isolates same external ids by owner while preserving exact same-owner replay", async () => {
    const { root, journal } = await createJournal();
    const jobId = "host:shared-external-id";
    const ownerA = "cut:workspace-a";
    const ownerB = "design-studio:workspace-b";
    const first = await journal.write(binding({ jobId, callerId: ownerA, request: { input: "opaque-source-a" } }));
    const second = await journal.write(binding({ jobId, callerId: ownerB, request: { input: "opaque-source-b" } }));
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: false });
    await expect(journal.write(binding({ jobId, callerId: ownerA, request: { input: "opaque-source-a" } })))
      .resolves.toMatchObject({ ok: true, replayed: true });
    await expect(journal.write(binding({ jobId, callerId: ownerA, request: { input: "opaque-source-a-replacement" } })))
      .resolves.toEqual({ ok: false, code: "binding_conflict" });
    await expect(journal.read({ jobId, callerId: ownerA })).resolves.toMatchObject({ ok: true, binding: { request: { input: "opaque-source-a" } } });
    await expect(journal.read({ jobId, callerId: ownerB })).resolves.toMatchObject({ ok: true, binding: { request: { input: "opaque-source-b" } } });
    const files = await readdir(root);
    expect(files).toHaveLength(2);
    expect(files.some((name) => name.includes(ownerA) || name.includes(ownerB))).toBe(false);
  });

  it("accepts a canonical legacy binding only for its stored owner", async () => {
    const { root, journal } = await createJournal();
    const legacy = createMotionConnectorJobBinding(binding({ jobId: "legacy:connector-id", callerId: "cut:legacy-owner" }));
    await writeFile(join(root, `${motionJobFileKey(legacy.jobId)}.connector-binding.json`), canonicalJson(legacy));

    await expect(journal.read({ jobId: legacy.jobId, callerId: legacy.callerId })).resolves.toMatchObject({ ok: true, binding: { fingerprint: legacy.fingerprint } });
    await expect(journal.read({ jobId: legacy.jobId, callerId: "design-studio:other" })).resolves.toEqual({ ok: false, code: "binding_unknown" });
    await expect(journal.write(binding({ jobId: legacy.jobId, callerId: legacy.callerId }))).resolves.toMatchObject({ ok: true, replayed: true });
  });

  it("fails closed when a stored binding is tampered or non-canonical", async () => {
    const { root, journal } = await createJournal();
    const written = await journal.write(binding());
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("Fixture binding did not persist.");
    expect(() => parseMotionConnectorJobBinding({ ...written.binding, executor: "never-persisted" })).toThrow("unknown field");
    await writeFile(bindingPath(root, "cut:workspace-a", "cut:connector-render-1"), JSON.stringify({ ...written.binding, catalogFingerprint: "c".repeat(64) }));
    await expect(journal.read({ jobId: "cut:connector-render-1", callerId: "cut:workspace-a" }))
      .resolves.toEqual({ ok: false, code: "binding_invalid" });
    await writeFile(bindingPath(root, "cut:workspace-a", "cut:connector-render-1"), JSON.stringify(written.binding));
    await expect(journal.read({ jobId: "cut:connector-render-1", callerId: "cut:workspace-a" }))
      .resolves.toEqual({ ok: false, code: "binding_invalid" });
  });

  it("fails closed on an oversized stored binding", async () => {
    const { root, journal } = await createJournal();
    await writeFile(bindingPath(root, "cut:workspace-a", "cut:connector-render-1"), "x".repeat(MOTION_CONNECTOR_JOB_BINDING_MAX_BYTES + 1));
    await expect(journal.read({ jobId: "cut:connector-render-1", callerId: "cut:workspace-a" }))
      .resolves.toEqual({ ok: false, code: "binding_invalid" });
  });

  it("refuses resolved path and URL values before they can enter persistent request state", () => {
    for (const unsafe of ["/host-approved/source.motion", "relative/path.motion", "C:\\output\\render.mp4", "C:relative-output.mp4", "https://example.test/render.mp4", "file:///tmp/output.mp4", "data:text/plain,unsafe"]) {
      expect(() => createMotionConnectorJobBinding(binding({ request: { input: unsafe } }))).toThrow(/path or URL/);
    }
  });
});
