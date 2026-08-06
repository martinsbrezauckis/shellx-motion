/** Browser HTTP transport security, timeout, and response-bound tests. */
import { describe, expect, it, vi } from "vitest";
import { createMotionSdk } from "./client";
import { createMotionSdkHttpTransport } from "./http";

describe("Motion SDK HTTP transport", () => {
  it("refuses remote origins, embedded credentials, and path-bearing base URLs by default", () => {
    expect(() => createMotionSdkHttpTransport({ baseUrl: "https://motion.example", capabilityToken: "token" }))
      .toThrow("refuses non-loopback hosts");
    expect(() => createMotionSdkHttpTransport({ baseUrl: "http://user:pass@127.0.0.1:5757", capabilityToken: "token" }))
      .toThrow("must not contain credentials");
    expect(() => createMotionSdkHttpTransport({ baseUrl: "http://127.0.0.1:5757/api", capabilityToken: "token" }))
      .toThrow("must not contain a path");
    expect(() => createMotionSdkHttpTransport({ baseUrl: "http://motion.example", capabilityToken: "token", allowNonLoopback: true }))
      .toThrow("requires HTTPS for non-loopback hosts");
    expect(() => createMotionSdkHttpTransport({ baseUrl: "https://motion.example", capabilityToken: "token", allowNonLoopback: true }))
      .not.toThrow();
  });

  it("uses bounded no-credential fetch settings and rejects oversized responses", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sdk-token");
      return new Response("{}", { status: 200, headers: { "content-length": "999" } });
    });
    const sdk = createMotionSdk(createMotionSdkHttpTransport({
      baseUrl: "http://127.0.0.1:5757",
      capabilityToken: "sdk-token",
      fetch: fetcher as typeof globalThis.fetch,
      maxResponseBytes: 100
    }));
    await expect(sdk.validate({ packageRoot: "/pkg" })).resolves.toMatchObject({
      ok: false,
      error: { code: "http_transport_failed", message: "Motion SDK HTTP response exceeds 100 bytes." }
    });
  });

  it("aborts stalled requests with an explicit retryable timeout", async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    }));
    const sdk = createMotionSdk(createMotionSdkHttpTransport({
      baseUrl: "http://127.0.0.1:5757",
      capabilityToken: "sdk-token",
      fetch: fetcher as typeof globalThis.fetch,
      timeoutMs: 10
    }));
    await expect(sdk.status({ receiptsRoot: "/receipts" })).resolves.toMatchObject({
      ok: false,
      error: { code: "request_timeout", message: "Motion SDK HTTP request timed out after 10ms.", retryable: true }
    });
  });
});
