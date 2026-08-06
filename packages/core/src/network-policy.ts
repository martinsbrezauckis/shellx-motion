import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedNetworkAddress {
  address: string;
  family: 4 | 6;
}

export type NetworkAddressResolver = (hostname: string) => Promise<ResolvedNetworkAddress[]>;

export interface ResolvedNetworkTarget {
  url: URL;
  hostname: string;
  addresses: ResolvedNetworkAddress[];
  pinnedAddress: ResolvedNetworkAddress;
}

export type ResolvedPublicNetworkTarget = ResolvedNetworkTarget;

export function assertPublicNetworkUrl(raw: string, purpose = "network request"): URL {
  return assertNetworkUrl(raw, { purpose, allowPrivate: false });
}

export function assertNetworkUrl(
  raw: string,
  options: { purpose?: string; allowPrivate?: boolean } = {}
): URL {
  const purpose = options.purpose ?? "network request";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http(s) URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error(`${purpose} URLs must not include credentials`);
  }

  const host = normalizeNetworkHostname(url.hostname);
  if (!host) throw new Error(`${purpose} URL must include a hostname`);
  if (!options.allowPrivate && (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )) {
    throw new Error(`refusing to fetch local host: ${host}`);
  }

  if (!options.allowPrivate && isIP(host) !== 0) assertPublicNetworkAddress(host, purpose);
  return url;
}

export async function resolveNetworkTarget(
  raw: string | URL,
  options: { resolver?: NetworkAddressResolver; purpose?: string; signal?: AbortSignal; allowPrivate?: boolean } = {}
): Promise<ResolvedNetworkTarget> {
  const purpose = options.purpose ?? "network request";
  const url = assertNetworkUrl(raw instanceof URL ? raw.href : raw, { purpose, allowPrivate: options.allowPrivate });
  const hostname = normalizeNetworkHostname(url.hostname);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : dedupeNetworkAddresses(await resolveWithSignal((options.resolver ?? defaultNetworkAddressResolver)(hostname), options.signal));

  if (addresses.length === 0) {
    throw new Error(`${purpose} hostname did not resolve: ${hostname}`);
  }
  if (!options.allowPrivate) {
    for (const address of addresses) assertPublicNetworkAddress(address.address, purpose);
  }

  return {
    url,
    hostname,
    addresses,
    pinnedAddress: addresses[0]
  };
}

export async function resolvePublicNetworkTarget(
  raw: string | URL,
  options: { resolver?: NetworkAddressResolver; purpose?: string; signal?: AbortSignal } = {}
): Promise<ResolvedPublicNetworkTarget> {
  return resolveNetworkTarget(raw, { ...options, allowPrivate: false });
}

async function resolveWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error("network resolution aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function assertPublicNetworkAddress(address: string, purpose = "network request"): void {
  const normalized = normalizeNetworkHostname(address);
  const family = isIP(normalized);
  if (family === 4) {
    if (!isPublicIPv4(normalized)) throw new Error(`refusing to fetch private IP: ${normalized}`);
    return;
  }
  if (family === 6) {
    if (!isPublicIPv6(normalized)) throw new Error(`refusing to fetch private IP: ${normalized}`);
    return;
  }
  throw new Error(`${purpose} resolver returned an invalid IP address: ${address}`);
}

export function isPublicNetworkAddress(address: string): boolean {
  try {
    assertPublicNetworkAddress(address);
    return true;
  } catch {
    return false;
  }
}

export async function defaultNetworkAddressResolver(hostname: string): Promise<ResolvedNetworkAddress[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records
    .filter((record): record is { address: string; family: 4 | 6 } => record.family === 4 || record.family === 6)
    .map((record) => ({ address: record.address, family: record.family }));
}

function normalizeNetworkHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  return normalized;
}

function dedupeNetworkAddresses(addresses: ResolvedNetworkAddress[]): ResolvedNetworkAddress[] {
  const seen = new Set<string>();
  const result: ResolvedNetworkAddress[] = [];
  for (const record of addresses) {
    const address = normalizeNetworkHostname(String(record.address));
    const actualFamily = isIP(address);
    if (actualFamily !== 4 && actualFamily !== 6) {
      throw new Error(`network resolver returned an invalid IP address: ${record.address}`);
    }
    const key = `${actualFamily}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ address, family: actualFamily });
  }
  return result;
}

function isPublicIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b, c] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIPv6(address: string): boolean {
  const bytes = parseIPv6(address);
  if (!bytes) return false;

  if (bytes.slice(0, 12).every((value) => value === 0)) {
    return isPublicIPv4(bytes.slice(12).join("."));
  }
  if (bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIPv4(bytes.slice(12).join("."));
  }
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((value) => value === 0)
  ) {
    return isPublicIPv4(bytes.slice(12).join("."));
  }

  if ((bytes[0] & 0xe0) !== 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02 && bytes[4] === 0x00 && bytes[5] === 0x00) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && (bytes[3] & 0xf0) === 0x10) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && (bytes[3] & 0xf0) === 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0x00) return false;
  return true;
}

function parseIPv6(address: string): number[] | null {
  let input = normalizeNetworkHostname(address).split("%", 1)[0];
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = input.slice(lastColon + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    input = `${input.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const hextets = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null;
    const value = Number.parseInt(hextet, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}
