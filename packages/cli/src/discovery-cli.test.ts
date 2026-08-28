import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { motionCapabilityCatalog, prepareGenericConnectorRequest, type MotionCapabilityCatalog } from "@shellx-motion/core";
import { runCli, type RunCliOptions } from "./main";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCI-1 discovery CLI", () => {
  it("reports source/unmanaged runtime truth and closed catalog/describe responses", async () => {
    await expect(runCli(["runtime-probe"])).resolves.toMatchObject({
      ok: true,
      command: "runtime-probe",
      probe: {
        schema: "shellx-motion/runtime-probe@1",
        provenance: {
          execution: "source",
          managedDistribution: "unmanaged",
          distributionQualification: "unverified",
          cleanHostQualification: "unverified"
        }
      }
    });
    await expect(runCli(["connector", "catalog"])).resolves.toMatchObject({
      ok: true,
      command: "connector catalog",
      catalog: { schema: "shellx-motion/capability-catalog@2" }
    });
    await expect(runCli(["connector", "describe", "connector.template-to-cut@1"])).resolves.toMatchObject({
      ok: true,
      command: "connector describe",
      descriptor: {
        id: "connector.template-to-cut@1",
        availability: { platforms: ["linux"], execution: "generic-connector-job" },
        invocation: { admission: "admitted", jobControls: ["cancel", "events", "get", "list", "retry"] }
      }
    });
    await expect(runCli(["connector", "describe", "connector.not-real@1"])).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown_capability" }
    });
    await expect(runCli(["runtime-probe", "--out", "never"])).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("returns Core's exact catalog and descriptor-bound generic submit preparation fields", async () => {
    const response = await runCli(["connector", "catalog"]);
    expect(response).toMatchObject({ ok: true, command: "connector catalog" });
    if (!response.ok || response.command !== "connector catalog") throw new Error("connector catalog unexpectedly failed");
    const catalog = (response as unknown as { catalog: MotionCapabilityCatalog }).catalog;

    const coreCatalog = motionCapabilityCatalog();
    expect(catalog).toEqual(coreCatalog);
    expect(catalog).toMatchObject({
      schema: coreCatalog.schema,
      fingerprint: coreCatalog.fingerprint
    });

    const descriptor = catalog.descriptors.find((candidate) => candidate.id === "connector.template-to-cut@1");
    if (!descriptor) throw new Error("admitted Template-to-Cut descriptor missing");
    expect(descriptor.request.fields).toEqual([
      { id: "input", type: "opaque-reference", required: true, maxLength: 128 },
      { id: "output", type: "opaque-reference", required: true, maxLength: 128 }
    ]);
    expect(prepareGenericConnectorRequest(catalog, descriptor.id, {
      input: "cut-input-handle",
      output: "cut-output-handle"
    })).toEqual({
      capabilityId: descriptor.id,
      descriptorRevision: descriptor.revision,
      descriptorFingerprint: descriptor.fingerprint,
      requestSchemaId: descriptor.request.id,
      request: { input: "cut-input-handle", output: "cut-output-handle" }
    });
  });

  it("publishes discovery routes in help", async () => {
    await expect(runCli(["--help"])).resolves.toMatchObject({
      ok: true,
      commands: expect.arrayContaining([
        expect.objectContaining({ name: "runtime-probe", usage: "shellx-motion runtime-probe" }),
        expect.objectContaining({ name: "connector", usage: expect.stringContaining("catalog | describe <capability-id>") })
      ])
    });
  });

  it("does not touch network, provider/auth, renderer, connector execution, or output state", async () => {
    const output = await mkdtemp(join(tmpdir(), "shellx-motion-discovery-read-only-"));
    created.push(output);
    const noProviderOrAuth = new Proxy({}, { get() { throw new Error("provider/auth must not be touched"); } });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network must not be touched"); }) as typeof fetch;
    const options: RunCliOptions = {
      agentRuntime: noProviderOrAuth as never,
      browserFrameRenderer: async () => { throw new Error("renderer must not be called"); },
      ffmpegRunner: { run: async () => { throw new Error("renderer must not be called"); } } as never,
      sourceFetcher: async () => { throw new Error("network source fetcher must not be called"); },
      sourceResolver: async () => { throw new Error("network resolver must not be called"); }
    };
    try {
      for (const argv of [["runtime-probe"], ["connector", "catalog"], ["connector", "describe", "cut.scene3d-handoff@1"]]) {
        await expect(runCli(argv, options)).resolves.toMatchObject({ ok: true });
      }
      expect(await readdir(output)).toEqual([]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
