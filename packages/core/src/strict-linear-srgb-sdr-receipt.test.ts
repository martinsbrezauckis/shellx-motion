import { describe, expect, it } from "vitest";
import { inspectStrictLinearSrgbSdrFinalReceipt } from "./strict-linear-srgb-sdr-receipt";
import { loadSchema, validateDocument } from "./validate";

function strictRouteInputHashes() {
  return {
    motion: "a".repeat(64),
    "linear-srgb-sdr-route": "b".repeat(64),
    "linear-srgb-sdr-preparation": "c".repeat(64),
    "linear-srgb-sdr-ffmpeg-contract": "d".repeat(64),
    "linear-srgb-sdr-webgpu-producer": "e".repeat(64),
    "linear-srgb-sdr-producer-frame": "f".repeat(64),
    "linear-srgb-sdr-comparison-policy": "0".repeat(64),
    "linear-srgb-sdr-execution": "1".repeat(64),
  };
}

function freshReceipt() {
  const sha256 = "a".repeat(64);
  return {
    schema: "shellx-motion/receipt@1",
    id: "strict-sdr-final",
    operation: "render.final",
    status: "passed",
    packageId: "pkg_strict_sdr",
    inputHashes: strictRouteInputHashes(),
    createdAt: "2026-09-02T00:00:00.000Z",
    lane: "ffmpeg",
    output: {
      path: "/private/pre-existing-stage.mp4",
      sha256,
      byteLength: 17,
      frameTransport: {
        schema: "shellx-motion/linear-srgb-sdr-final-transport@2",
        privateOutputAdoption: {
          schema: "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1",
          verifiedOutput: { sha256, byteLength: 17 },
          privatePublicationStage: { sha256, byteLength: 17 },
        },
      },
    },
    warnings: [],
  };
}

describe("strict linear-sRGB SDR receipt adoption", () => {
  it("requires a closed private-output adoption for fresh @2 receipts", async () => {
    const schema = await loadSchema("receipt");
    const receipt = freshReceipt();
    expect(await validateDocument(schema, receipt)).toEqual({ ok: true });

    const missingAdoption: any = structuredClone(receipt);
    delete missingAdoption.output.frameTransport.privateOutputAdoption;
    await expect(validateDocument(schema, missingAdoption)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/output/frameTransport/privateOutputAdoption" })]),
    });

    const wrongByteLength: any = structuredClone(receipt);
    wrongByteLength.output.byteLength += 1;
    await expect(validateDocument(schema, wrongByteLength)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/output" })]),
    });

    const wrongAdoptionSchema: any = structuredClone(receipt);
    wrongAdoptionSchema.output.frameTransport.privateOutputAdoption.schema = "shellx-motion/linear-srgb-sdr-final-private-output-adoption@2";
    await expect(validateDocument(schema, wrongAdoptionSchema)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/output/frameTransport/privateOutputAdoption/schema" })]),
    });

    const leakedPrivatePath: any = structuredClone(receipt);
    leakedPrivatePath.output.frameTransport.privateOutputAdoption.path = "/private/strict-stage.mp4";
    await expect(validateDocument(schema, leakedPrivatePath)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/output/frameTransport/privateOutputAdoption" })]),
    });
  });

  it("rejects unsupported fresh strict transports while retaining historical @1 readability", async () => {
    const schema = await loadSchema("receipt");
    const wrongTransport: any = freshReceipt();
    wrongTransport.output.frameTransport.schema = "shellx-motion/linear-srgb-sdr-final-transport@3";
    await expect(validateDocument(schema, wrongTransport)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/output/frameTransport/schema" })]),
    });

    const historical: any = freshReceipt();
    historical.output.frameTransport.schema = "shellx-motion/linear-srgb-sdr-final-transport@1";
    delete historical.output.frameTransport.privateOutputAdoption;
    delete historical.output.byteLength;
    expect(inspectStrictLinearSrgbSdrFinalReceipt(historical)).toEqual({ kind: "historical-v1" });
    await expect(validateDocument(schema, historical)).resolves.toEqual({ ok: true });
  });

  it.each([
    ["is deleted", (value: any) => { delete value.output.frameTransport; }],
    ["uses a foreign schema", (value: any) => { value.output.frameTransport = { schema: "shellx-motion/other-stream@1" }; }],
    ["uses a strict lookalike schema", (value: any) => { value.output.frameTransport = { schema: "shellx-motion/linear-srgb-sdr-final-transport@1-downgrade" }; }],
  ])("does not permit a route-identified strict receipt to downgrade when its transport %s", async (_label, mutate) => {
    const schema = await loadSchema("receipt");
    const candidate: any = freshReceipt();
    mutate(candidate);
    expect(inspectStrictLinearSrgbSdrFinalReceipt(candidate)).toMatchObject({ kind: "invalid-strict-v2" });
    await expect(validateDocument(schema, candidate)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/output/frameTransport/schema" })]),
    });
  });

  it("does not classify ordinary receipts with an incomplete strict-route key set as strict", async () => {
    const schema = await loadSchema("receipt");
    const ordinary: any = freshReceipt();
    delete ordinary.inputHashes["linear-srgb-sdr-execution"];
    delete ordinary.output.frameTransport;
    expect(inspectStrictLinearSrgbSdrFinalReceipt(ordinary)).toEqual({ kind: "not-strict" });
    await expect(validateDocument(schema, ordinary)).resolves.toEqual({ ok: true });
  });
});
