import { describe, expect, it } from "vitest";
import { strictServerRenderContext } from "./server-render-context";

describe("strictServerRenderContext", () => {
  it("forces render-root enforcement while retaining the server-minted reuse authority", () => {
    const reuseAuthority = { mintedBy: "server" };
    const gpuAuthority = { grantedBy: "registry" };
    const context = strictServerRenderContext(
      { receiptsRoot: "/host/receipts", enforceRenderRoots: false },
      reuseAuthority,
      gpuAuthority,
    );

    expect(context).toMatchObject({ receiptsRoot: "/host/receipts", enforceRenderRoots: true });
    expect(context.attestedRenderReuseProducerAuthority).toBe(reuseAuthority);
    expect(context.gpuEffectModuleUseAuthority).toBe(gpuAuthority);
  });
});
