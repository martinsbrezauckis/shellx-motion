import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HDR10_PQ_DIRECT_FINAL_MAX_FFPROBE_BYTES, HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES, HDR10_PQ_DIRECT_FINAL_SCHEMA, HDR10_PQ_DIRECT_FINAL_TIMEOUT_MS, createHdr10PqDirectFinalReceipt, verifyHdr10PqDirectFinalReceiptStructure } from "./hdr10-pq-direct-final-contract.js";
import { assertHdr10PqOutputDisjoint } from "./hdr10-pq-output-topology.js";
import { renderHdr10PqDirectFinalForTest, renderHdr10PqDirectFinalInternal } from "./hdr10-pq-direct-final.js";

const HASH = "a".repeat(64);

describe("private HDR10 C2 durable boundary", () => {
  it("pins a path-free direct-final receipt to all source, conversion, command, probe, output, and ceiling facts", () => {
    const receipt = createHdr10PqDirectFinalReceipt(facts());
    expect(verifyHdr10PqDirectFinalReceiptStructure(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({ limits: { maxOutputBytes: HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES, timeoutMs: HDR10_PQ_DIRECT_FINAL_TIMEOUT_MS, maxFfprobeBytes: HDR10_PQ_DIRECT_FINAL_MAX_FFPROBE_BYTES }, output: { file: "video.mp4" }, command: { hardware: "refused", softwareEncoder: "libx265" } });
    expect(JSON.stringify(receipt)).not.toContain("/tmp/");
    expect(() => verifyHdr10PqDirectFinalReceiptStructure({ ...receipt, output: { ...receipt.output, byteLength: HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES + 1 } })).toThrow();
    expect(() => verifyHdr10PqDirectFinalReceiptStructure({ ...receipt, probe: { ...receipt.probe, observedJsonSha256: "b".repeat(64) } })).toThrow();
    expect(() => verifyHdr10PqDirectFinalReceiptStructure({ ...receipt, limits: { ...receipt.limits, governedProcessTreeRssBytes: 2 * 1024 * 1024 * 1024 + 1 } })).toThrow();
  });

  it("refuses output overlap before any transaction or renderer path can begin", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-hdr10-c2-")), packageRoot = join(root, "package"), outside = join(root, "output");
    try {
      await mkdir(packageRoot, { mode: 0o700 });
      await expect(assertHdr10PqOutputDisjoint(packageRoot, outside)).resolves.toBeUndefined();
      await expect(assertHdr10PqOutputDisjoint(packageRoot, packageRoot)).rejects.toThrow(/disjoint/i);
      await expect(assertHdr10PqOutputDisjoint(packageRoot, join(packageRoot, "output"))).rejects.toThrow(/disjoint/i);
      await symlink(packageRoot, join(root, "package-alias"), "dir");
      await expect(assertHdr10PqOutputDisjoint(packageRoot, join(root, "package-alias", "output"))).rejects.toThrow(/symlink/i);
      await expect(stat(outside)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses audio before route reopen, output staging, Browser, or process admission", async () => {
    const result = await renderHdr10PqDirectFinalInternal({ schema: HDR10_PQ_DIRECT_FINAL_SCHEMA, pkg: { root: "/not-used", motion: { layers: [{ type: "audio" }] } } as never, outputDirectory: "/not-used-output", job: job() });
    expect(result).toMatchObject({ ok: false, code: "hdr10_direct_final_refused" });
  });

  it("refuses a pre-acquired job above the fixed 2GiB C2 process ceiling", async () => {
    const result = await renderHdr10PqDirectFinalInternal({ schema: HDR10_PQ_DIRECT_FINAL_SCHEMA, pkg: {} as never, outputDirectory: "/not-used-output", job: { ...job(), maxProcessTreeRssBytes: 2 * 1024 * 1024 * 1024 + 1 } });
    expect(result).toMatchObject({ ok: false, code: "hdr10_direct_final_refused" });
  });

  it("aborts an injected early pipe close and leaves no public transaction", async () => {
    const packageRoot = await mkdtemp(join(process.cwd(), ".shellx-motion-hdr10-c2-package-")), root = await mkdtemp(join(tmpdir(), "shellx-motion-hdr10-c2-output-")), output = join(root, "output"); let aborted = 0, transactionAborted = 0;
    try {
      const result = await renderHdr10PqDirectFinalForTest({ schema: HDR10_PQ_DIRECT_FINAL_SCHEMA, pkg: { root: packageRoot, motion: { fps: 30, width: 1280, height: 720, durationMs: 3_000, layers: [] } } as never, outputDirectory: output, job: job() }, {
        resolveRoute: async () => ({ kind: "present", hdrRoute: { packageId: "pkg_hdr10" }, sdrRoute: {} } as never),
        createProducer: () => ({ produce: async (sink: { write(frame: unknown): Promise<void> }) => { await sink.write(frame()); } } as never),
        startProcess: async () => ({ closed: Promise.resolve({ exitCode: 1, stdout: "", stderr: "closed" }), write: async () => { throw new Error("stdin closed early"); }, end: async () => ({ exitCode: 1, stdout: "", stderr: "closed" }), abort: async () => { aborted += 1; return { exitCode: 1, stdout: "", stderr: "closed" }; } }),
        createTransaction: async () => ({ outputPath: output, stagingPath: join(root, "private-stage"), assertCurrent: async () => {}, abort: async () => { transactionAborted += 1; } } as never)
      });
      expect(result).toMatchObject({ ok: false, code: "hdr10_direct_final_failed", message: expect.stringContaining("stdin closed early") }); expect(aborted).toBe(1); expect(transactionAborted).toBe(1);
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await Promise.all([rm(packageRoot, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]); }
  }, 45_000);
});

function facts(): Parameters<typeof createHdr10PqDirectFinalReceipt>[0] { return { packageId: "pkg_hdr10", route: { fingerprint: HASH, sourceInputHashes: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`source-${index}`, HASH])), sceneStateSha256: HASH, staticFingerprint: HASH, sdrStaticFingerprint: HASH, frameFingerprint: HASH }, browser: { catalogSha256: HASH, pipelineSha256: HASH, producerEvidenceSha256: HASH, rawFrameSequenceSha256: HASH, framesRendered: 90 }, conversion: { contractSha256: HASH, sequenceFingerprint: HASH, generatedReceiptSha256: HASH, generatedFrameSequenceSha256: HASH, frameCount: 90, generatedYuvFrameByteLength: 2_764_800 }, command: { c1InertPlanSha256: HASH, c2TokenizedCommandSha256: HASH, softwareEncoder: "libx265", hardware: "refused" }, probe: { querySha256: HASH, observedJsonSha256: HASH, observedStreamSha256: HASH, validationFingerprint: HASH }, output: { file: "video.mp4", sha256: HASH, byteLength: 1 }, limits: { maxOutputBytes: HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES, timeoutMs: HDR10_PQ_DIRECT_FINAL_TIMEOUT_MS, maxFfprobeBytes: HDR10_PQ_DIRECT_FINAL_MAX_FFPROBE_BYTES, maximumProcessTreeRssBytes: 2 * 1024 * 1024 * 1024, governedProcessTreeRssBytes: 64 * 1024 * 1024 }, cleanup: { browserTerminal: true, encoderExitCode: 0, ffprobeExitCode: 0 } }; }
function job() { return { admission: "pre-acquired" as const, signal: new AbortController().signal, scratchRoot: "/tmp/shellx-motion-hdr10-c2-test", maxProcessTreeRssBytes: 64 * 1024 * 1024, watchProcess: () => {}, reportProcessContainment: () => {} }; }
function frame() { const rgba16float = Buffer.alloc(7_372_800); for (let offset = 7; offset < rgba16float.length; offset += 8) rgba16float[offset] = 0x3c; return { schema: "shellx-motion/browser-scene3d-gltf-pbr-hdr10-readback@1", staticFingerprint: HASH, sdrStaticFingerprint: HASH, frameFingerprint: HASH, frameIndex: 0, rawRgba16floatSha256: createHash("sha256").update(rgba16float).digest("hex"), width: 1280, height: 720, bytesPerRow: 10_240, byteOrder: "ieee754-binary16-le", rgba16float }; }
