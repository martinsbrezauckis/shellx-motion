import { describe, expect, it } from "vitest";
import {
  assertPublicNetworkAddress,
  assertPublicNetworkUrl,
  isPublicNetworkAddress,
  resolveNetworkTarget,
  resolvePublicNetworkTarget
} from "./network-policy";

describe("shared public network policy", () => {
  it("accepts public HTTP origins and public IPv4/IPv6 addresses", async () => {
    expect(assertPublicNetworkUrl("https://example.com/path").origin).toBe("https://example.com");
    expect(isPublicNetworkAddress("93.184.216.34")).toBe(true);
    expect(isPublicNetworkAddress("2606:4700:4700::1111")).toBe(true);

    await expect(resolvePublicNetworkTarget("https://example.com/path", {
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 }
      ]
    })).resolves.toMatchObject({
      hostname: "example.com",
      pinnedAddress: { address: "93.184.216.34", family: 4 }
    });
  });

  it("rejects local names, credentials, non-HTTP schemes, and direct private addresses", () => {
    expect(() => assertPublicNetworkUrl("http://localhost./x")).toThrow("local host");
    expect(() => assertPublicNetworkUrl("http://service.internal/x")).toThrow("local host");
    expect(() => assertPublicNetworkUrl("https://user:secret@example.com/x")).toThrow("must not include credentials");
    expect(() => assertPublicNetworkUrl("file:///tmp/x")).toThrow("only http(s)");
    expect(() => assertPublicNetworkUrl("http://2130706433/x")).toThrow("private IP: 127.0.0.1");
    expect(() => assertPublicNetworkUrl("http://[::ffff:127.0.0.1]/x")).toThrow("private IP");
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "2001::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "2002:7f00:1::",
    "3fff::1",
    "fc00::1",
    "fe80::1",
    "ff02::1"
  ])("rejects non-public address %s", (address) => {
    expect(() => assertPublicNetworkAddress(address)).toThrow("refusing to fetch private IP");
  });

  it("rejects DNS answers containing any private or invalid address", async () => {
    await expect(resolvePublicNetworkTarget("https://mixed.example/x", {
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ]
    })).rejects.toThrow("private IP: 127.0.0.1");

    await expect(resolvePublicNetworkTarget("https://invalid.example/x", {
      resolver: async () => [{ address: "not-an-ip", family: 4 }]
    })).rejects.toThrow("invalid IP address");
  });

  it("allows an explicit trusted-host policy to resolve private development targets", async () => {
    await expect(resolveNetworkTarget("http://127.0.0.1:7310/path", {
      allowPrivate: true
    })).resolves.toMatchObject({
      hostname: "127.0.0.1",
      pinnedAddress: { address: "127.0.0.1", family: 4 }
    });
  });
});
