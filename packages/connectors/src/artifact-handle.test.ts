import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectorArtifactOperationHash, connectorArtifactStagingPath, publishConnectorArtifact } from "./artifact-handle";

const roots: string[] = [];

describe("connector artifact operation hashes", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("binds semantic Cut plan inputs without receipt timestamp or id drift", () => {
    const first = connectorArtifactOperationHash({
      packageId: "pkg_test",
      motionId: "motion_test",
      preset: "mp4-h264",
      plan: cutPlan("receipt-one", "2026-07-11T10:00:00.000Z")
    });
    const second = connectorArtifactOperationHash({
      preset: "mp4-h264",
      motionId: "motion_test",
      packageId: "pkg_test",
      plan: cutPlan("receipt-two", "2026-07-11T11:00:00.000Z")
    });
    const changed = connectorArtifactOperationHash({
      packageId: "pkg_test",
      motionId: "motion_test",
      preset: "mp4-h264",
      plan: { ...cutPlan("receipt-three", "2026-07-11T12:00:00.000Z"), operations: [] }
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("publishes same-directory staged media atomically without replacing an output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-artifact-publish-"));
    roots.push(root);
    const output = join(root, "render.mp4");
    const staging = connectorArtifactStagingPath(output);
    await writeFile(staging, "first");

    await publishConnectorArtifact(staging, output);

    await expect(readFile(output, "utf8")).resolves.toBe("first");
    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });

    const secondStaging = connectorArtifactStagingPath(output);
    await writeFile(secondStaging, "second");
    await expect(publishConnectorArtifact(secondStaging, output)).rejects.toThrow("output already exists");
    await expect(readFile(output, "utf8")).resolves.toBe("first");
    await expect(stat(secondStaging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes a host replacement after a linked output's parent and random stage name are retargeted", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-artifact-retarget-"));
    roots.push(root);
    const parent = join(root, "publish");
    const displacedParent = join(root, "displaced-publish");
    await mkdir(parent, { mode: 0o700 });
    const output = join(parent, "render.mp4");
    const staging = connectorArtifactStagingPath(output);
    await writeFile(staging, "motion-owned bytes", "utf8");

    await expect(publishConnectorArtifact(staging, output, {
      afterOutputLinked: async () => {
        await rename(parent, displacedParent);
        await mkdir(parent);
        await writeFile(output, "host replacement", "utf8");
        await writeFile(join(parent, basename(staging)), "host stage replacement", "utf8");
      }
    })).rejects.toThrow("did not preserve the staged file identity");

    // The old cleanup unlinked both of these new pathnames after its identity check. A failed
    // publication now leaves replacements and any private orphan alone, because neither can be
    // safely removed by pathname after an ancestor retarget.
    await expect(readFile(output, "utf8")).resolves.toBe("host replacement");
    await expect(readFile(join(parent, basename(staging)), "utf8")).resolves.toBe("host stage replacement");
  });

  it("stamps the same operation identity regardless of the host locale", () => {
    // Regression for a reproduced defect: `connectorArtifactOperationHash` sorted the operation's
    // keys with `String.prototype.localeCompare`, so the identity written into every attested
    // artifact handle depended on the ambient LC_ALL. Live probe on one machine, same input:
    // ea2aaf72… under en_US.UTF-8 versus baf8aca2… under sv_SE.UTF-8. `inputHashes` is keyed by
    // package-relative FILE NAMES, which is where non-ASCII keys enter in practice.
    const plan = {
      schema: "shellx-motion/cut-import-plan@1",
      receipt: { inputHashes: { "a.png": "a".repeat(64), "ä.png": "b".repeat(64), "z.png": "c".repeat(64) } }
    };
    const input = { packageId: "pkg_test", motionId: "motion_test", preset: "mp4-h264", plan };
    expect(withLocaleTrap(() => connectorArtifactOperationHash(input))).toBe(connectorArtifactOperationHash(input));
  });

  it("stamps the same operation identity regardless of key insertion order", () => {
    // The second half of the same defect. Canonical JSON must depend on the VALUE, never on the
    // order the producer happened to build it in — two connectors emitting the same plan with
    // keys in different orders describe one operation and must stamp one identity.
    const forward = connectorArtifactOperationHash({
      packageId: "pkg_test",
      motionId: "motion_test",
      preset: "mp4-h264",
      plan: { schema: "shellx-motion/cut-import-plan@1", ok: true, targetId: "shellx-cut" }
    });
    const reversed = connectorArtifactOperationHash({
      preset: "mp4-h264",
      motionId: "motion_test",
      packageId: "pkg_test",
      plan: { targetId: "shellx-cut", ok: true, schema: "shellx-motion/cut-import-plan@1" }
    });
    expect(forward).toBe(reversed);
  });

  it("refuses an operation value canonical JSON would silently coerce", () => {
    // Canonical JSON honours toJSON, so a Date would become a string and the identity would stop
    // describing what was actually passed. An identity refuses; it does not paper over.
    expect(() => connectorArtifactOperationHash({
      packageId: "pkg_test",
      motionId: "motion_test",
      preset: "mp4-h264",
      plan: { at: new Date("2026-08-02T00:00:00.000Z") }
    })).toThrow("unsupported object value");
  });
});

/**
 * Run `body` with every locale-sensitive global replaced by a thrower.
 *
 * Stronger and more portable than re-running under a set of `LC_ALL` values: it proves the code
 * path never CONSULTS the locale at all, and it does not depend on which locale data the CI image
 * happens to ship. The `LC_ALL` matrix in the regression found the defect; this keeps it dead.
 */
function withLocaleTrap<T>(body: () => T): T {
  const globals = globalThis as Record<string, unknown>;
  const savedIntl = globals.Intl;
  const savedCompare = String.prototype.localeCompare;
  const boom = () => { throw new Error("locale-sensitive path reached from an identity hash"); };
  try {
    globals.Intl = new Proxy({}, { get: boom, has: boom, apply: boom });
    String.prototype.localeCompare = boom as typeof String.prototype.localeCompare;
    return body();
  } finally {
    globals.Intl = savedIntl;
    String.prototype.localeCompare = savedCompare;
  }
}

function cutPlan(id: string, createdAt: string): Record<string, unknown> {
  return {
    schema: "shellx-motion/cut-import-plan@1",
    ok: true,
    packageId: "pkg_test",
    motionId: "motion_test",
    targetId: "shellx-cut",
    mode: "rendered_media",
    operations: [{ verb: "cut.media.import_rendered", durationMs: 1000 }],
    unsupported: [],
    document: { width: 1280, height: 720, fps: 30, durationMs: 1000 },
    receipt: {
      schema: "shellx-motion/receipt@1",
      id,
      createdAt,
      inputHashes: { motion: "a".repeat(64), targetCapabilities: "b".repeat(64) }
    }
  };
}
