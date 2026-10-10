import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local";
import { withTestAuthoringRoots } from "./local-test-authoring-context.test-support";

const tempDirs: string[] = [];

describe("local SDK portable path authority", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("refuses an authoring output reached through an operating-system path alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-local-alias-"));
    tempDirs.push(root);
    const canonicalParent = join(root, "canonical");
    const aliasParent = join(root, "alias");
    await mkdir(canonicalParent, { recursive: true, mode: 0o700 });
    await symlink(canonicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const outDir = join(aliasParent, "edited");

    const source = resolve(import.meta.dirname, "../../../fixtures/packages/editable-lower-third");
    const edited = await createLocalMotionSdk(withTestAuthoringRoots({}, { inputRoots: [source], outputRoots: [canonicalParent] })).timelineEdit({
      packageRoot: source,
      outDir,
      edit: { kind: "keyframe.upsert", layerId: "title", target: "opacity", atMs: 150, value: 0.5 }
    });

    expect(edited).toMatchObject({ ok: false, error: { code: "timeline_keyframe_upsert_failed", message: expect.stringMatching(/authoring output root/i) } });
    if (!edited.ok) expect(edited.error.message).not.toContain(outDir);
  });
});
