import { createServer } from "node:http";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const STARTUP_TIMEOUT_MS = 20_000;
const BENCHMARK_TIMEOUT_MS = 120_000;

export async function runIsolatedMediabunnyBenchmark(input) {
  const bundleStat = await stat(input.bundlePath);
  if (!bundleStat.isFile() || bundleStat.size <= 0 || bundleStat.size > 16 * 1024 * 1024) throw new Error("Mediabunny candidate bundle must be a non-empty regular file no larger than 16 MiB.");
  const bundle = await readFile(input.bundlePath);
  const outputs = new Map(input.cases.map((entry) => [entry.id, join(input.outDir, `mediabunny-${entry.id}.webm`)]));
  const server = createBenchmarkServer({ bundle, cases: input.cases, outputs, contract: input.contract });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark loopback server did not expose a TCP port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const profileRoot = join(input.outDir, "candidate-browser-profile");
  const browser = spawn(input.browserPath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileRoot}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=127.0.0.1;localhost",
    "--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    "about:blank",
  ], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const browserLog = boundedProcessLog(browser, 1 * 1024 * 1024);
  let cdp;
  try {
    const { port } = await readDevToolsEndpoint(profileRoot, browser);
    const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    if (!targetResponse.ok) throw new Error(`Chromium target creation failed with HTTP ${targetResponse.status}.`);
    const target = await targetResponse.json();
    if (!target || typeof target.webSocketDebuggerUrl !== "string") throw new Error("Chromium target did not expose a DevTools WebSocket URL.");
    cdp = await CdpClient.open(target.webSocketDebuggerUrl);
    const browserVersion = await cdp.send("Browser.getVersion");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const loaded = cdp.waitForEvent("Page.loadEventFired", STARTUP_TIMEOUT_MS);
    const navigation = await cdp.send("Page.navigate", { url: `${origin}/` });
    if (navigation.errorText) throw new Error(`Benchmark page navigation failed: ${navigation.errorText}`);
    await loaded;
    const evaluated = await withTimeout(cdp.send("Runtime.evaluate", {
      expression: "globalThis.runFrameVideoEncoderBenchmark()",
      awaitPromise: true,
      returnByValue: true,
    }), BENCHMARK_TIMEOUT_MS, "Mediabunny browser benchmark timed out.");
    if (evaluated.exceptionDetails) throw new Error(`Mediabunny benchmark page failed: ${evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? "unknown exception"}`);
    const value = evaluated.result?.value;
    if (!value || typeof value !== "object") throw new Error("Mediabunny benchmark page returned no structured result.");
    await cdp.send("Browser.close").catch(() => undefined);
    await waitForExit(browser, 10_000);
    return { ...value, browserVersion, outputFiles: Object.fromEntries([...outputs].map(([id, path]) => [id, path])) };
  } catch (error) {
    if (browser.exitCode === null) browser.kill();
    await waitForExit(browser, 5_000).catch(() => undefined);
    const log = await browserLog;
    throw new Error(`${error instanceof Error ? error.message : String(error)}${log ? ` Chromium log: ${log}` : ""}`);
  } finally {
    cdp?.close();
    const serverClosed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await serverClosed;
    await rm(profileRoot, { recursive: true, force: true });
  }
}

function createBenchmarkServer(input) {
  return createServer((request, response) => {
    void handleRequest(request, response, input).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
}

async function handleRequest(request, response, input) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const headers = {
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'self' 'nonce-shellx-motion-benchmark'; worker-src blob:; connect-src 'self'" });
    response.end(pageHtml(input.contract, input.cases));
    return;
  }
  if (request.method === "GET" && url.pathname === "/candidate.mjs") {
    response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8", "content-length": input.bundle.byteLength });
    response.end(input.bundle);
    return;
  }
  const frameMatch = url.pathname.match(/^\/frames\/([a-z0-9-]+)\.rgba$/u);
  if (request.method === "GET" && frameMatch) {
    const benchmarkCase = input.cases.find((entry) => entry.id === frameMatch[1]);
    if (!benchmarkCase) return notFound(response);
    response.writeHead(200, { ...headers, "content-type": "application/octet-stream", "content-length": benchmarkCase.bytes.byteLength });
    response.end(benchmarkCase.bytes);
    return;
  }
  const outputMatch = url.pathname.match(/^\/output\/([a-z0-9-]+)\.webm$/u);
  if (request.method === "POST" && outputMatch) {
    const outputPath = input.outputs.get(outputMatch[1]);
    if (!outputPath) return notFound(response);
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.byteLength;
      if (total > input.contract.maxCandidateOutputBytes) throw new Error("Mediabunny candidate output exceeded the 64 MiB benchmark bound.");
      chunks.push(chunk);
    }
    if (total === 0) throw new Error("Mediabunny candidate produced an empty output.");
    await writeFile(outputPath, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
    response.writeHead(204, headers);
    response.end();
    return;
  }
  notFound(response);
}

function pageHtml(contract, cases) {
  const pageContract = {
    width: contract.width,
    height: contract.height,
    frameCount: contract.frameCount,
    rate: contract.rate,
    quality: contract.quality,
    cases: cases.map((entry) => ({ id: entry.id, alpha: entry.alpha, timestampUs: entry.timestampUs, durationUs: entry.durationUs })),
  };
  return `<!doctype html><meta charset="utf-8"><title>ShellX Motion isolated encoder benchmark</title><script type="module" nonce="shellx-motion-benchmark">
import { BufferTarget, Output, Quality, VideoSample, VideoSampleSource, WebMOutputFormat } from "/candidate.mjs";
const contract = ${safeScriptJson(pageContract)};
const cleanConfig = (value) => value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, entry]) => ["string", "number", "boolean"].includes(typeof entry))) : null;
globalThis.runFrameVideoEncoderBenchmark = async () => {
  const results = [];
  for (const benchmarkCase of contract.cases) {
    const startedAt = performance.now();
    try {
      const rgba = new Uint8Array(await fetch(\`/frames/\${benchmarkCase.id}.rgba\`).then((response) => { if (!response.ok) throw new Error(\`frame fetch failed: \${response.status}\`); return response.arrayBuffer(); }));
      const target = new BufferTarget();
      let encoderConfig = null;
      const encodedPackets = [];
      const source = new VideoSampleSource({
        codec: "vp9",
        quality: new Quality({ quantizer: contract.quality.quantizer, bitrate: contract.quality.fallbackBitrate }),
        alpha: benchmarkCase.alpha,
        latencyMode: "quality",
        hardwareAcceleration: "no-preference",
        keyFrameInterval: 1,
        onEncoderConfig: (config) => { encoderConfig = cleanConfig(config); },
        onEncodedPacket: (packet) => { encodedPackets.push({ timestampUs: packet.microsecondTimestamp, durationUs: packet.microsecondDuration, type: packet.type, byteLength: packet.byteLength }); },
      });
      const output = new Output({ format: new WebMOutputFormat(), target });
      output.addVideoTrack(source, { frameRate: contract.rate.numerator / contract.rate.denominator });
      await output.start();
      const admittedTimestampsUs = [];
      const frameBytes = contract.width * contract.height * 4;
      for (let frameIndex = 0; frameIndex < contract.frameCount; frameIndex += 1) {
        const frame = rgba.subarray(frameIndex * frameBytes, (frameIndex + 1) * frameBytes);
        const sample = new VideoSample(frame, { format: "RGBA", codedWidth: contract.width, codedHeight: contract.height, timestamp: benchmarkCase.timestampUs[frameIndex] / 1_000_000, duration: benchmarkCase.durationUs[frameIndex] / 1_000_000 });
        admittedTimestampsUs.push(sample.microsecondTimestamp);
        await source.add(sample, { keyFrame: frameIndex === 0 });
        sample.close();
      }
      source.close();
      await output.finalize();
      if (!target.buffer) throw new Error("Mediabunny finalized without an in-memory output buffer.");
      const outputBytes = new Uint8Array(target.buffer);
      const upload = await fetch(\`/output/\${benchmarkCase.id}.webm\`, { method: "POST", body: outputBytes });
      if (!upload.ok) throw new Error(\`output upload failed: \${upload.status} \${await upload.text()}\`);
      results.push({ ok: true, caseId: benchmarkCase.id, alpha: benchmarkCase.alpha, elapsedMs: Number((performance.now() - startedAt).toFixed(3)), outputByteLength: outputBytes.byteLength, admittedTimestampsUs, encodedPackets, encoderConfig });
    } catch (error) {
      results.push({ ok: false, caseId: benchmarkCase.id, alpha: benchmarkCase.alpha, elapsedMs: Number((performance.now() - startedAt).toFixed(3)), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { schema: "shellx-motion/isolated-mediabunny-webcodecs-result@1", userAgent: navigator.userAgent, webCodecs: { VideoEncoder: typeof VideoEncoder, VideoFrame: typeof VideoFrame }, cases: results };
};
</script>`;
}

function safeScriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function notFound(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}

async function readDevToolsEndpoint(profileRoot, browser) {
  const endpointPath = join(profileRoot, "DevToolsActivePort");
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (browser.exitCode !== null) throw new Error(`Chromium exited during startup with code ${browser.exitCode}.`);
    try {
      const [portText] = (await readFile(endpointPath, "utf8")).trim().split(/\r?\n/u);
      const port = Number(portText);
      if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return { port };
    } catch {
      // The exact browser-owned endpoint file appears only after DevTools is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Chromium did not publish its DevTools endpoint before the startup deadline.");
}

function boundedProcessLog(child, maximumBytes) {
  const chunks = [];
  let total = 0;
  const collect = (chunk) => {
    if (total >= maximumBytes) return;
    const admitted = chunk.subarray(0, maximumBytes - total);
    chunks.push(admitted);
    total += admitted.byteLength;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return once(child, "exit").then(() => Buffer.concat(chunks).toString("utf8").replaceAll(/\s+/gu, " ").trim().slice(0, 2_000));
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await withTimeout(once(child, "exit"), timeoutMs, "Chromium did not exit before the cleanup deadline.");
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally {
    clearTimeout(timeout);
  }
}

class CdpClient {
  static async open(url) {
    if (typeof WebSocket !== "function") throw new Error("Node WebSocket support is required for the isolated browser benchmark.");
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chromium DevTools.")), { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.rejectAll(new Error("Chromium DevTools connection closed.")));
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs) {
    return withTimeout(new Promise((resolve) => {
      const queue = this.events.get(method) ?? [];
      queue.push(resolve);
      this.events.set(method, queue);
    }), timeoutMs, `Chromium DevTools event ${method} timed out.`);
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }

  onMessage(raw) {
    const message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      const queue = this.events.get(message.method);
      const resolve = queue?.shift();
      if (resolve) resolve(message.params ?? {});
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
