import { describe, expect, it } from "vitest";
import { deriveMotionRenderDeliveryImportPlan, planMotionRenderDeliveryImport } from "./render-delivery-import-plan";
import { syntheticGeImportSources, syntheticGeRenderDelivery } from "./render-delivery-ge.fixture";
import { describeMotionRenderDelivery } from "./render-delivery-validate";

describe("motion.render-delivery/v1", () => {
  it("admits terminal, revalidated GE-shaped beauty and optional anchors without invoking UE", () => {
    const first = describeMotionRenderDelivery(syntheticGeRenderDelivery());
    const replay = describeMotionRenderDelivery(reordered(syntheticGeRenderDelivery()));
    expect(first).toMatchObject({ ok: true }); expect(replay).toMatchObject({ ok: true });
    if (!first.ok || !replay.ok) return;
    expect(replay.fingerprint).toBe(first.fingerprint);
    expect(first.delivery.terminal).toMatchObject({ outcome: "passed", revalidation: "passed", cleanup: { succeeded: true } });
    expect(first.delivery.schedule.slice(0, 2)).toMatchObject([{ presentationTime: { numerator: 0, denominator: 1 } }, { presentationTime: { numerator: 1, denominator: 30 } }]);
    expect(Object.isFrozen(first.delivery)).toBe(true);
  });

  it("plans only package-local staging names and never persists provider-local locations", () => {
    const sources = syntheticGeImportSources();
    const planned = planMotionRenderDeliveryImport({ delivery: syntheticGeRenderDelivery(), sources });
    expect(planned).toMatchObject({ ok: true }); if (!planned.ok) return;
    const described = describeMotionRenderDelivery(syntheticGeRenderDelivery());
    expect(described).toMatchObject({ ok: true }); if (!described.ok) return;
    expect(deriveMotionRenderDeliveryImportPlan(described.delivery, described.fingerprint)).toEqual(planned.plan);
    expect(planned.plan.assets.beauty).toEqual([
      expect.objectContaining({ packagePath: `assets/provider-delivery/${planned.plan.deliveryFingerprint}/beauty/000000.png`, frameIndex: 0 }),
      expect.objectContaining({ packagePath: `assets/provider-delivery/${planned.plan.deliveryFingerprint}/beauty/000001.png`, frameIndex: 1 }),
      expect.objectContaining({ packagePath: `assets/provider-delivery/${planned.plan.deliveryFingerprint}/beauty/000002.png`, frameIndex: 2 }),
    ]);
    expect(planned.plan.assets.anchors).toEqual(expect.objectContaining({ packagePath: `assets/provider-delivery/${planned.plan.deliveryFingerprint}/anchors.json` }));
    const persisted = JSON.stringify(planned.plan);
    expect(persisted).not.toContain(sources.beauty[0]!.providerLocalPath);
    expect(persisted).not.toContain(sources.anchors.providerLocalPath);
    expect(persisted).not.toContain("ge-private");
    expect(persisted).not.toContain("C:\\");
  });

  it("detects schedule and frame-sequence tampering even when structural fields remain valid", () => {
    const scheduleTamper = structuredClone(syntheticGeRenderDelivery()) as unknown as { schedule: Array<{ presentationTime: { numerator: number; denominator: number } }> };
    scheduleTamper.schedule[1]!.presentationTime = { numerator: 1, denominator: 24 };
    expect(describeMotionRenderDelivery(scheduleTamper)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "$.schedule[1].presentationTime" })] });
    const frameTamper = structuredClone(syntheticGeRenderDelivery()) as unknown as { passes: Array<{ frames: Array<{ sha256: string }> }> };
    frameTamper.passes[0]!.frames[1]!.sha256 = "a".repeat(64);
    expect(describeMotionRenderDelivery(frameTamper)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "$.passes[0].frameSequenceSha256", code: "hash-mismatch" })] });
  });

  it("bounds descriptor arrays and rejects reflection-shaped fields before planning", () => {
    const cap = structuredClone(syntheticGeRenderDelivery()) as unknown as { schedule: unknown[] };
    cap.schedule = Array.from({ length: 601 }, () => ({ index: 0, presentationTime: { numerator: 0, denominator: 1 } }));
    expect(describeMotionRenderDelivery(cap)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "$.schedule", code: "cap" })]) });
    const reflected = syntheticGeRenderDelivery() as unknown as { provider: Record<string, unknown> };
    Object.defineProperty(reflected.provider, "providerLocalPath", { enumerable: false, value: "C:\\private" });
    expect(describeMotionRenderDelivery(reflected)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "$.provider", code: "reflection" })] });
  });

  it("stops before hostile sparse, huge, and proxy-controlled child traversal", () => {
    let elementReads = 0;
    const huge = new Proxy(new Array(601), { get(target, property, receiver) { if (property !== "length") elementReads += 1; return Reflect.get(target, property, receiver); } });
    const hugeDelivery = structuredClone(syntheticGeRenderDelivery()) as unknown as { schedule: unknown[] };
    hugeDelivery.schedule = huge;
    expect(describeMotionRenderDelivery(hugeDelivery)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "$.schedule", code: "cap" })]) });
    expect(elementReads).toBe(0);
    const sparseDelivery = structuredClone(syntheticGeRenderDelivery()) as unknown as { schedule: unknown[] };
    sparseDelivery.schedule = new Array(3);
    expect(describeMotionRenderDelivery(sparseDelivery)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "$.schedule", code: "reflection" })] });
    const ownKeysTrap = new Proxy(syntheticGeRenderDelivery(), { ownKeys() { throw new Error("trap"); } });
    expect(() => describeMotionRenderDelivery(ownKeysTrap)).not.toThrow();
    expect(describeMotionRenderDelivery(ownKeysTrap)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "$", code: "reflection" })] });
    const descriptorTrap = structuredClone(syntheticGeRenderDelivery()) as unknown as { provider: object };
    descriptorTrap.provider = new Proxy(descriptorTrap.provider, { getOwnPropertyDescriptor() { throw new Error("trap"); } });
    expect(() => describeMotionRenderDelivery(descriptorTrap)).not.toThrow();
    expect(describeMotionRenderDelivery(descriptorTrap)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "$.provider", code: "reflection" })] });
    const prototypeTrap = structuredClone(syntheticGeRenderDelivery()) as unknown as { provider: object };
    prototypeTrap.provider = new Proxy(prototypeTrap.provider, { getPrototypeOf() { throw new Error("trap"); } });
    expect(() => describeMotionRenderDelivery(prototypeTrap)).not.toThrow();
    expect(describeMotionRenderDelivery(prototypeTrap)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "$.provider", code: "reflection" })] });
    const symbolReflected = syntheticGeRenderDelivery() as unknown as { provider: Record<PropertyKey, unknown> };
    symbolReflected.provider[Symbol("private")] = "provider-only";
    expect(describeMotionRenderDelivery(symbolReflected)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "$.provider", code: "reflection" })] });
  });

  it("caps provider source lists before reading their elements", () => {
    let elementReads = 0;
    const sources = syntheticGeImportSources() as unknown as { beauty: unknown[]; anchors: unknown };
    sources.beauty = new Proxy(new Array(4), { get(target, property, receiver) { if (property !== "length") elementReads += 1; return Reflect.get(target, property, receiver); } });
    const planned = planMotionRenderDeliveryImport({ delivery: syntheticGeRenderDelivery(), sources });
    expect(planned).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "$.sources.beauty", code: "cap" })] });
    expect(elementReads).toBe(0);
  });

  it("explicitly refuses matte and depth delivery, partial execution, and non-clean cleanup", () => {
    for (const kind of ["matte", "depth"] as const) {
      const delivery = structuredClone(syntheticGeRenderDelivery()) as unknown as { passes: unknown[] };
      delivery.passes.push({ kind, id: kind, format: "png", alphaMode: "straight", width: 1, height: 1, frames: [], frameSequenceSha256: "0".repeat(64) });
      expect(describeMotionRenderDelivery(delivery)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: `unsupported-${kind}` })]) });
    }
    const partial = structuredClone(syntheticGeRenderDelivery()) as unknown as { terminal: { revalidation: string; cleanup: { succeeded: boolean } } };
    partial.terminal.revalidation = "pending"; partial.terminal.cleanup.succeeded = false;
    expect(describeMotionRenderDelivery(partial)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: "$.terminal.revalidation" }), expect.objectContaining({ path: "$.terminal.cleanup.succeeded" })]) });
  });
});

function reordered(value: object): unknown {
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).reverse()) : child]));
}
