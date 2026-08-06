/**
 * workbench-update-network.test.ts — network-boundary coverage for the update feed.
 *
 * Proves the update check honors docs/public/security-model.md:45-54: hostnames are resolved and
 * private/reserved addresses rejected, one public address is pinned, redirects are re-validated,
 * HTTPS->HTTP downgrades are refused, a JSON media type is required, the API base is restricted to the
 * GitHub API origin in production, the body is streamed and aborted at the byte ceiling (never fully
 * buffered), and the request timeout is enforced. Pure-policy hops use an injected resolver + fetcher
 * (the source-import test pattern); the streaming/timeout cases use a real loopback fixture server with
 * the explicit unsafe development override, so the production path stays strict.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { NetworkAddressResolver } from "@shellx-motion/core";
import { runWorkbenchUpdateCheck, type UpdateFetch, type UpdateFetchResponse } from "./workbench-update";

const GITHUB_BASE = "https://api.github.com";
const PUBLIC_IPV4 = "93.184.216.34";
const PUBLIC_RESOLVER: NetworkAddressResolver = async () => [{ address: PUBLIC_IPV4, family: 4 }];
const VALID_RELEASE = JSON.stringify({ tag_name: "v9.9.9", name: "ShellX Motion 9.9.9", body: "Notes." });

/** Baseline config for a configured, production-strict (no override) update check. */
function baseConfig(overrides: Partial<Parameters<typeof runWorkbenchUpdateCheck>[0]> = {}): Parameters<typeof runWorkbenchUpdateCheck>[0] {
  return {
    repo: "shellx/motion",
    apiBaseUrl: GITHUB_BASE,
    installRoot: null,
    currentVersion: "1.0.0",
    resolver: PUBLIC_RESOLVER,
    ...overrides
  };
}

/** Build a mock {@link UpdateFetchResponse} (bypasses the real transport for pure-policy hops). */
function updateFetchResponse(opts: {
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: string;
  location?: string;
} = {}): UpdateFetchResponse {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: opts.statusText ?? "OK",
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === "content-type") return opts.contentType ?? "application/json";
        if (key === "location") return opts.location ?? null;
        return null;
      }
    },
    text: async () => opts.body ?? "",
    discard: () => {}
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise((server.address() as AddressInfo).port)));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

describe("update feed network boundary", () => {
  const openServers: Server[] = [];
  const openSockets: Socket[] = [];
  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.destroy();
    await Promise.all(openServers.splice(0).map(closeServer));
  });

  it("fetches the release for a public target on the pinned policy", async () => {
    let fetchedUrl = "";
    const fetcher: UpdateFetch = async (url) => {
      fetchedUrl = url;
      return updateFetchResponse({ body: VALID_RELEASE });
    };
    const result = await runWorkbenchUpdateCheck(baseConfig({ fetchImpl: fetcher }));
    expect(result).toMatchObject({ ok: true, configured: true, latestVersion: "9.9.9", upToDate: false, unsafeNetworkOverride: false });
    expect(fetchedUrl).toContain("api.github.com/repos/shellx/motion/releases/latest");
  });

  it("rejects a target that resolves to a loopback address before any fetch", async () => {
    let fetched = 0;
    const fetcher: UpdateFetch = async () => {
      fetched += 1;
      return updateFetchResponse({ body: VALID_RELEASE });
    };
    const result = await runWorkbenchUpdateCheck(baseConfig({
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchImpl: fetcher
    }));
    expect(result).toMatchObject({ ok: false, configured: true, error: { code: "update_feed_network_blocked" } });
    expect((result as { error: { message: string } }).error.message).toContain("127.0.0.1");
    expect(fetched).toBe(0);
  });

  it("rejects mixed DNS answers when any address is private", async () => {
    const result = await runWorkbenchUpdateCheck(baseConfig({
      resolver: async () => [{ address: PUBLIC_IPV4, family: 4 }, { address: "10.0.0.5", family: 4 }],
      fetchImpl: async () => updateFetchResponse({ body: VALID_RELEASE })
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "update_feed_network_blocked" } });
    expect((result as { error: { message: string } }).error.message).toContain("10.0.0.5");
  });

  it("re-validates a redirect and blocks a hop that resolves to a private address", async () => {
    const fetcher: UpdateFetch = async (url) =>
      url.includes("api.github.com")
        ? updateFetchResponse({ status: 302, statusText: "Found", location: "https://redirect.example/elsewhere" })
        : updateFetchResponse({ body: VALID_RELEASE });
    const resolver: NetworkAddressResolver = async (hostname) =>
      hostname === "api.github.com" ? [{ address: PUBLIC_IPV4, family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    const result = await runWorkbenchUpdateCheck(baseConfig({ resolver, fetchImpl: fetcher }));
    expect(result).toMatchObject({ ok: false, error: { code: "update_feed_network_blocked" } });
    expect((result as { error: { message: string } }).error.message).toContain("127.0.0.1");
  });

  it("refuses an HTTPS-to-HTTP redirect downgrade", async () => {
    const fetcher: UpdateFetch = async () =>
      updateFetchResponse({ status: 302, statusText: "Found", location: "http://api.github.com/repos/shellx/motion/releases/latest" });
    const result = await runWorkbenchUpdateCheck(baseConfig({ fetchImpl: fetcher }));
    expect(result).toMatchObject({ ok: false, error: { code: "update_feed_redirect_blocked" } });
    expect((result as { error: { message: string } }).error.message).toMatch(/downgrade/i);
  });

  it("rejects a non-JSON content type", async () => {
    const fetcher: UpdateFetch = async () => updateFetchResponse({ contentType: "text/html", body: "<html></html>" });
    const result = await runWorkbenchUpdateCheck(baseConfig({ fetchImpl: fetcher }));
    expect(result).toMatchObject({ ok: false, error: { code: "update_feed_wrong_content_type" } });
  });

  it("restricts the API base to the GitHub API origin in production", async () => {
    let fetched = 0;
    const result = await runWorkbenchUpdateCheck(baseConfig({
      apiBaseUrl: "https://evil.example",
      fetchImpl: async () => {
        fetched += 1;
        return updateFetchResponse({ body: VALID_RELEASE });
      }
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "update_base_not_allowed" }, unsafeNetworkOverride: false });
    expect(fetched).toBe(0);
  });

  it("allows a non-GitHub base only under the explicit unsafe override, and records it in the payload", async () => {
    const result = await runWorkbenchUpdateCheck(baseConfig({
      apiBaseUrl: "https://mirror.example",
      allowUnsafeBase: true,
      fetchImpl: async () => updateFetchResponse({ body: VALID_RELEASE })
    }));
    expect(result).toMatchObject({ ok: true, configured: true, latestVersion: "9.9.9", unsafeNetworkOverride: true });
  });

  it("streams the body and aborts at the byte ceiling instead of buffering an oversized response", async () => {
    const SERVER_STREAM_CAP = 16 * 1024 * 1024; // 16 MiB the server WOULD stream if never interrupted
    let serverCompleted = false; // true only if the server streamed its whole intended body
    let clientAborted = false; // true if the response closed before the server finished (client cut it off)
    let markResponseClosed: () => void = () => {};
    const responseClosed = new Promise<void>((resolvePromise) => { markResponseClosed = resolvePromise; });
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      // Chunked (no content-length): stream 64 KiB chunks of leading whitespace (never a complete JSON
      // document). If the client streamed-and-buffered the whole body it would run to SERVER_STREAM_CAP.
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      let stopped = false;
      response.on("close", () => {
        stopped = true;
        if (!serverCompleted) clientAborted = true;
        markResponseClosed();
      });
      const pump = (): void => {
        if (stopped) return;
        if (sent >= SERVER_STREAM_CAP) { serverCompleted = true; response.end(); return; }
        sent += chunk.length;
        if (response.write(chunk)) setImmediate(pump);
        else response.once("drain", pump);
      };
      pump();
    });
    openServers.push(server);
    server.on("connection", (socket) => openSockets.push(socket));
    const port = await listen(server);

    const result = await runWorkbenchUpdateCheck(baseConfig({
      apiBaseUrl: `http://127.0.0.1:${port}`,
      allowUnsafeBase: true,
      maxBytes: 128 * 1024
      // No fetchImpl: the real pinned node transport streams and must abort early.
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "update_feed_too_large" } });
    // The client destroyed the connection at the 128 KiB ceiling; wait for the server to observe that
    // disconnect (it propagates just after the client returns), then assert the server was cut off BEFORE
    // streaming its full intended body — deterministic proof of an early streaming abort, not full buffering.
    await responseClosed;
    expect(clientAborted).toBe(true);
    expect(serverCompleted).toBe(false);
  });

  it("enforces the request timeout when the feed never responds", async () => {
    const server = createServer(() => {
      // Never respond: hold the connection open until the client times out and aborts.
    });
    openServers.push(server);
    server.on("connection", (socket) => openSockets.push(socket));
    const port = await listen(server);

    const result = await runWorkbenchUpdateCheck(baseConfig({
      apiBaseUrl: `http://127.0.0.1:${port}`,
      allowUnsafeBase: true,
      timeoutMs: 250
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "update_feed_timeout" } });
  });
});
