import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectRetainedTemplateProofScratch,
  prepareTemplateProofScratch,
  TEMPLATE_PROOF_SCRATCH_MARKER,
  TEMPLATE_PROOF_SCRATCH_SCHEMA
} from "./template-proof-scratch";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-template-proof-scratch-"));
  temporaryRoots.push(root);
  return root;
}

describe("template proof scratch ownership fence", () => {
  it("initializes a missing or empty caller scratch without requiring force", async () => {
    const parent = await temporaryRoot();
    const scratch = join(parent, "proof");
    const prepared = await prepareTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo"), force: false });
    expect(prepared.state).toBe("initialized_empty");
    expect(JSON.parse(await readFile(join(scratch, TEMPLATE_PROOF_SCRATCH_MARKER), "utf8"))).toEqual({
      schema: TEMPLATE_PROOF_SCRATCH_SCHEMA,
      root: scratch
    });
  });

  it("never replaces a non-empty markerless directory, even with force", async () => {
    const parent = await temporaryRoot();
    const scratch = join(parent, "unowned");
    await mkdir(scratch);
    await writeFile(join(scratch, "notes.txt"), "keep me\n", "utf8");
    await expect(prepareTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo"), force: true }))
      .rejects.toThrow("ownership marker");
    await expect(readFile(join(scratch, "notes.txt"), "utf8")).resolves.toBe("keep me\n");
  });

  it("resets only known marker-owned proof roles after explicit force", async () => {
    const parent = await temporaryRoot();
    const scratch = join(parent, "owned");
    await prepareTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo"), force: false });
    await mkdir(join(scratch, "renders"));
    await writeFile(join(scratch, "renders", "example.mp4"), "diagnostic", "utf8");
    await writeFile(join(scratch, "evidence.json"), "{}\n", "utf8");
    await writeFile(join(scratch, "resume-inspection.failure.json"), "{}\n", "utf8");
    await expect(prepareTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo"), force: false }))
      .rejects.toThrow("pass --force");
    const reset = await prepareTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo"), force: true });
    expect(reset.state).toBe("reset_owned_roles");
    await expect(readFile(join(scratch, "renders", "example.mp4"), "utf8")).rejects.toThrow();
    await expect(readFile(join(scratch, "resume-inspection.failure.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(scratch, TEMPLATE_PROOF_SCRATCH_MARKER), "utf8")).resolves.toContain(TEMPLATE_PROOF_SCRATCH_SCHEMA);
  });

  it("preserves unknown content even if a valid marker is present", async () => {
    const parent = await temporaryRoot();
    const scratch = join(parent, "owned-with-notes");
    await prepareTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo"), force: false });
    await writeFile(join(scratch, "notes.txt"), "do not delete\n", "utf8");
    await expect(prepareTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo"), force: true }))
      .rejects.toThrow("non-proof content");
    await expect(readFile(join(scratch, "notes.txt"), "utf8")).resolves.toBe("do not delete\n");
  });

  it("opens only a marker-bound complete diagnostic root without resetting it", async () => {
    const parent = await temporaryRoot();
    const scratch = join(parent, "retained");
    await prepareTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo"), force: false });
    for (const role of ["packages", "renders", "frames", "quality"] as const) await mkdir(join(scratch, role));
    await writeFile(join(scratch, "evidence.json"), "{}\n", "utf8");
    await expect(inspectRetainedTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo") }))
      .resolves.toMatchObject({ root: scratch, state: "inspection_ready" });
    await expect(readFile(join(scratch, TEMPLATE_PROOF_SCRATCH_MARKER), "utf8")).resolves.toContain(TEMPLATE_PROOF_SCRATCH_SCHEMA);
  });

  it("refuses partial retained diagnostics without modifying their remaining contents", async () => {
    const parent = await temporaryRoot();
    const scratch = join(parent, "partial-retained");
    await prepareTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo"), force: false });
    await mkdir(join(scratch, "renders"));
    await writeFile(join(scratch, "evidence.json"), "{}\n", "utf8");
    await expect(inspectRetainedTemplateProofScratch({ root: scratch, repoRoot: join(parent, "repo") }))
      .rejects.toThrow("missing required packages diagnostics");
    await expect(readFile(join(scratch, "evidence.json"), "utf8")).resolves.toBe("{}\n");
  });

  it("rejects protected broad roots before inspecting or deleting them", async () => {
    const parent = await temporaryRoot();
    await expect(prepareTemplateProofScratch({ root: "/", repoRoot: join(parent, "repo"), force: true }))
      .rejects.toThrow("filesystem root");
    await expect(prepareTemplateProofScratch({ root: parent, repoRoot: parent, force: true }))
      .rejects.toThrow("repository root");
    await expect(prepareTemplateProofScratch({ root: homedir(), repoRoot: join(parent, "repo"), force: true }))
      .rejects.toThrow("home directory");
  });
});
