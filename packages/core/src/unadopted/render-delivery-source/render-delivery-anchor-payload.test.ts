import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../canonical-json";
import { renderDeliveryAnchorDeliveryBindingSha256 } from "./render-delivery-identity";
import { parseMotionRenderDeliveryAnchorPayload } from "./render-delivery-anchor-payload";
import { syntheticGeRenderDelivery } from "./render-delivery-ge.fixture";
import { MAX_RENDER_DELIVERY_ANCHOR_ID } from "./render-delivery-types";

describe("motion.render-provider-anchor-payload/v1", () => {
  it("admits stable numeric tracks with dense exact samples and explicit not-visible states", () => {
    const { delivery, bytes } = fixture();
    const parsed = parseMotionRenderDeliveryAnchorPayload(bytes, delivery);

    expect(parsed).toEqual({
      schema: "motion.render-provider-anchor-payload/v1",
      deliveryBindingSha256: renderDeliveryAnchorDeliveryBindingSha256(delivery),
      coordinateConvention: "screen-pixel-top-left-q1024",
      anchors: [
        { id: 7, samples: [
          { frameIndex: 0, state: "visible", xQ1024: 1_024, yQ1024: 2_048 },
          { frameIndex: 1, state: "not-visible" },
          { frameIndex: 2, state: "visible", xQ1024: -1_024, yQ1024: 0 },
        ] },
      ],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects alternate JSON bytes, labels, unbounded coordinates, sparse samples, and schedule bindings", () => {
    const base = fixture();
    const payload = JSON.parse(base.bytes.toString("utf8")) as Record<string, any>;
    const expectRefused = (value: unknown) => {
      expect(() => parseMotionRenderDeliveryAnchorPayload(Buffer.from(canonicalJson(value), "utf8"), base.delivery)).toThrow(/not admitted/i);
    };

    expect(() => parseMotionRenderDeliveryAnchorPayload(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), base.bytes]), base.delivery)).toThrow(/not admitted/i);
    expect(() => parseMotionRenderDeliveryAnchorPayload(Buffer.from(`${base.bytes.toString("utf8")}\n`, "utf8"), base.delivery)).toThrow(/not admitted/i);
    expectRefused({ ...payload, label: "provider-local-name" });
    expectRefused({ ...payload, anchors: [{ ...payload.anchors[0], id: "face-centre" }] });
    expectRefused({ ...payload, anchors: [{ ...payload.anchors[0], id: MAX_RENDER_DELIVERY_ANCHOR_ID + 1 }] });
    expectRefused({ ...payload, anchors: [{ ...payload.anchors[0], samples: [{ frameIndex: 0, state: "visible", xQ1024: 8_388_609, yQ1024: 0 }, ...payload.anchors[0].samples.slice(1)] }] });
    expectRefused({ ...payload, anchors: [{ ...payload.anchors[0], samples: [payload.anchors[0].samples[0], payload.anchors[0].samples[2]] }] });
    const otherDelivery = structuredClone(base.delivery) as any;
    otherDelivery.schedule[1]!.presentationTime = { numerator: 1, denominator: 24 };
    expectRefused({ ...payload, deliveryBindingSha256: renderDeliveryAnchorDeliveryBindingSha256(otherDelivery) });
  });

  it("caps encoded tracks before accepting per-track payloads", () => {
    const { delivery, bytes } = fixture();
    const payload = JSON.parse(bytes.toString("utf8")) as { anchors: unknown[] };
    payload.anchors = Array.from({ length: 65 }, () => ({ id: 1, samples: [] }));
    expect(() => parseMotionRenderDeliveryAnchorPayload(Buffer.from(canonicalJson(payload), "utf8"), delivery)).toThrow();
  });

  it("accepts the positive signed-32-bit anchor ID boundary", () => {
    const { delivery, bytes } = fixture();
    const payload = JSON.parse(bytes.toString("utf8")) as any;
    payload.anchors[0].id = MAX_RENDER_DELIVERY_ANCHOR_ID;
    expect(parseMotionRenderDeliveryAnchorPayload(Buffer.from(canonicalJson(payload), "utf8"), delivery).anchors[0]!.id)
      .toBe(MAX_RENDER_DELIVERY_ANCHOR_ID);
  });
});

function fixture() {
  const delivery = structuredClone(syntheticGeRenderDelivery()) as any;
  delivery.anchors!.sha256 = "0".repeat(64);
  const payload = {
    schema: "motion.render-provider-anchor-payload/v1",
    deliveryBindingSha256: renderDeliveryAnchorDeliveryBindingSha256(delivery),
    coordinateConvention: "screen-pixel-top-left-q1024",
    anchors: [{
      id: 7,
      samples: [
        { frameIndex: 0, state: "visible", xQ1024: 1_024, yQ1024: 2_048 },
        { frameIndex: 1, state: "not-visible" },
        { frameIndex: 2, state: "visible", xQ1024: -1_024, yQ1024: 0 },
      ],
    }],
  } as const;
  const bytes = Buffer.from(canonicalJson(payload), "utf8");
  delivery.anchors!.sha256 = createHash("sha256").update(bytes).digest("hex");
  return { delivery, bytes };
}
