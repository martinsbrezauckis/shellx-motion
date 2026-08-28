import { describe, expect, it } from "vitest";
import {
  brokerBoundedBrowserResponse,
  browserDeclaredResponseLength,
  browserRemoteResponseContentTypeAllowed,
  MAX_BROWSER_REMOTE_AGGREGATE_BYTES,
  MAX_BROWSER_REMOTE_CONCURRENT_RESPONSES,
  MAX_BROWSER_REMOTE_RESPONSE_BYTES,
  type BrowserRedirectPausedEvent,
  type BrowserResponseBrokerSession,
} from "./browser-redirect-guard";
import type { BrowserFrameNetworkState } from "./browser-network-state";

function state(): BrowserFrameNetworkState {
  return {
    blockedRequests: [], blockedWebSocketRequests: [], blockedExternalFileRequest: false,
    blockedDowngradeRedirects: [], blockedSecondaryPages: [], blockedForeignPageRequests: [],
    redirectGuardFailures: [], blockedResponsePolicies: [], admittedResponseBytes: 0, activeResponseCount: 0,
  };
}

function event(headers: Array<{ name: string; value: string }>): BrowserRedirectPausedEvent {
  return { requestId: "request-1", request: { url: "https://approved.example/asset" }, responseStatusCode: 200, responseHeaders: headers };
}

describe("browser remote response boundary", () => {
  it("accepts only bounded render media content types and parses safe declared lengths", () => {
    expect(browserRemoteResponseContentTypeAllowed("image/png")).toBe(true);
    expect(browserRemoteResponseContentTypeAllowed("text/html; charset=utf-8")).toBe(true);
    expect(browserRemoteResponseContentTypeAllowed("application/x-shockwave-flash")).toBe(false);
    expect(browserRemoteResponseContentTypeAllowed(undefined)).toBe(false);
    expect(browserDeclaredResponseLength([{ name: "Content-Length", value: "42" }])).toBe(42);
    expect(browserDeclaredResponseLength([{ name: "Content-Length", value: "-1" }])).toBeUndefined();
  });

  it("refuses a declared oversized response before taking its body", async () => {
    const calls: string[] = [];
    const broker: BrowserResponseBrokerSession = { send: async (method) => { calls.push(method); return {}; } };
    const failed: string[] = [];
    const network = state();
    await brokerBoundedBrowserResponse(broker, event([
      { name: "content-type", value: "image/png" },
      { name: "content-length", value: String(MAX_BROWSER_REMOTE_RESPONSE_BYTES + 1) },
    ]), network, async (id) => { failed.push(id); });
    expect(failed).toEqual(["request-1"]);
    expect(calls).toEqual([]);
    expect(network.blockedResponsePolicies).toEqual(["declared_bytes"]);
  });

  it("refuses a disallowed or missing response content type", async () => {
    const broker: BrowserResponseBrokerSession = { send: async () => { throw new Error("body must not be read"); } };
    const network = state();
    await brokerBoundedBrowserResponse(broker, event([{ name: "content-type", value: "application/x-executable" }]), network, async () => undefined);
    expect(network.blockedResponsePolicies).toEqual(["content_type"]);
  });

  it("refuses a chunked body that crosses the streamed-byte ceiling", async () => {
    let reads = 0;
    const broker: BrowserResponseBrokerSession = { send: async (method) => {
      if (method === "Fetch.takeResponseBodyAsStream") return { stream: "stream-1" };
      if (method === "IO.read") {
        reads += 1;
        return { data: Buffer.alloc(MAX_BROWSER_REMOTE_RESPONSE_BYTES / 2 + 1).toString("base64"), base64Encoded: true, eof: reads === 2 };
      }
      return {};
    } };
    const network = state();
    const failed: string[] = [];
    await brokerBoundedBrowserResponse(broker, event([{ name: "content-type", value: "video/mp4" }]), network, async (id) => { failed.push(id); });
    expect(failed).toEqual(["request-1"]);
    expect(network.blockedResponsePolicies).toEqual(["streamed_bytes"]);
    expect(network.admittedResponseBytes).toBe(MAX_BROWSER_REMOTE_RESPONSE_BYTES / 2 + 1);
  });

  it("refuses aggregate and concurrent response pressure before Chromium consumes it", async () => {
    const body = Buffer.from("bounded");
    const broker: BrowserResponseBrokerSession = { send: async (method) => {
      if (method === "Fetch.takeResponseBodyAsStream") return { stream: "stream-1" };
      if (method === "IO.read") return { data: body.toString("base64"), base64Encoded: true, eof: true };
      return {};
    } };
    const aggregate = state();
    aggregate.admittedResponseBytes = MAX_BROWSER_REMOTE_AGGREGATE_BYTES - body.byteLength + 1;
    await brokerBoundedBrowserResponse(broker, event([{ name: "content-type", value: "application/octet-stream" }]), aggregate, async () => undefined);
    expect(aggregate.blockedResponsePolicies).toEqual(["aggregate_bytes"]);

    const concurrent = state();
    concurrent.activeResponseCount = MAX_BROWSER_REMOTE_CONCURRENT_RESPONSES;
    let bodyStarted = false;
    await brokerBoundedBrowserResponse({ send: async () => { bodyStarted = true; return {}; } }, event([
      { name: "content-type", value: "image/png" }
    ]), concurrent, async () => undefined);
    expect(concurrent.blockedResponsePolicies).toEqual(["concurrency"]);
    expect(bodyStarted).toBe(false);
  });

  it("fulfills an allowed bounded body and records exact admitted bytes", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const broker: BrowserResponseBrokerSession = { send: async (method, params) => {
      calls.push({ method, params });
      if (method === "Fetch.takeResponseBodyAsStream") return { stream: "stream-1" };
      if (method === "IO.read") return { data: Buffer.from("PNG").toString("base64"), base64Encoded: true, eof: true };
      return {};
    } };
    const network = state();
    await brokerBoundedBrowserResponse(broker, event([{ name: "content-type", value: "image/png" }]), network, async () => { throw new Error("must not fail"); });
    expect(network.blockedResponsePolicies).toEqual([]);
    expect(network.admittedResponseBytes).toBe(3);
    expect(network.activeResponseCount).toBe(0);
    expect(calls.some(({ method, params }) => method === "Fetch.fulfillRequest" && params.body === "UE5H")).toBe(true);
  });
});
