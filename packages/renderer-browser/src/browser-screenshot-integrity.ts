import { writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

type BrowserScreenshotFormat = "png" | "jpeg";

export interface DeterministicScreenshotPage {
  screenshot(options: Omit<DeterministicScreenshotOptions, "path">): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
}

export interface DeterministicScreenshotOptions {
  path: string;
  type?: BrowserScreenshotFormat;
  quality?: number;
  omitBackground?: boolean;
  animations: "allow" | "disabled";
  caret: "hide" | "initial";
}

export async function captureDeterministicScreenshot(
  page: DeterministicScreenshotPage,
  options: DeterministicScreenshotOptions
): Promise<void> {
  const retryDelaysMs = [50, 100];
  const { path, ...captureOptions } = options;
  for (let attempt = 0; ; attempt += 1) {
    let integrityFailure = false;
    try {
      const captured = await page.screenshot(captureOptions);
      if (!Buffer.isBuffer(captured)) throw new Error("Chromium screenshot did not return an image byte buffer.");
      const integrityError = browserScreenshotIntegrityError(captured, options.type ?? "png");
      if (integrityError) {
        integrityFailure = true;
        throw new Error(`Chromium returned an invalid ${options.type ?? "png"} capture: ${integrityError}`);
      }
      // Never expose Playwright's final pathname while a large image can still be incomplete.
      // Validate in-process first and make this awaited Node write the path's only writer.
      await writeFile(path, captured);
      return;
    } catch (error) {
      if ((!integrityFailure && !isTransientCaptureScreenshotError(error)) || attempt >= retryDelaysMs.length) throw error;
      await page.waitForTimeout(retryDelaysMs[attempt]);
    }
  }
}

function browserScreenshotIntegrityError(capture: Buffer, format: BrowserScreenshotFormat): string | null {
  if (format === "jpeg") {
    if (capture.length < 4 || capture[0] !== 0xff || capture[1] !== 0xd8) return "missing JPEG start marker";
    return capture[capture.length - 2] !== 0xff || capture[capture.length - 1] !== 0xd9 ? "missing JPEG end marker" : null;
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (capture.length < signature.length || !capture.subarray(0, signature.length).equals(signature)) return "missing PNG signature";
  let offset = signature.length;
  let width = 0;
  let height = 0;
  let channels = 0;
  let sawEnd = false;
  const idat: Buffer[] = [];
  while (offset < capture.length) {
    if (offset + 12 > capture.length) return "truncated PNG chunk header";
    const length = capture.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > capture.length) return "truncated PNG chunk";
    const type = capture.subarray(offset + 4, offset + 8).toString("ascii");
    const data = capture.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (data.length !== 13) return "invalid PNG IHDR";
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) return "unsupported PNG encoding";
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (channels === 0) return "unsupported PNG color type";
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (width <= 0 || height <= 0 || idat.length === 0 || !sawEnd) return "incomplete PNG structure";
  const expected = (width * channels + 1) * height;
  try {
    const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
    return inflated.length === expected ? null : `PNG scanline length is ${inflated.length}, expected ${expected}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function isTransientCaptureScreenshotError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Page.captureScreenshot") && message.includes("Unable to capture screenshot");
}
