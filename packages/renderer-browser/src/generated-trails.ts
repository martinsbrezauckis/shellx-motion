import type { MotionTrailSegment } from "@shellx-motion/core";
import type { Page } from "playwright-core";

export interface BrowserTrailCanvasInput {
  layerId: string;
  width: number;
  height: number;
  segments: readonly MotionTrailSegment[];
  resolveColor: (color: string | undefined) => string;
  style?: string;
}

/** Fixed-engine Canvas2D strokes for bounded, Core-resolved trail segments. */
export function renderGeneratedTrailCanvas(input: BrowserTrailCanvasInput): string {
  const trails = input.segments.map((segment) => ({
    x0: segment.x0, y0: segment.y0, x1: segment.x1, y1: segment.y1,
    width: segment.width, opacity: segment.opacity, color: input.resolveColor(segment.color)
  }));
  const config = Buffer.from(JSON.stringify({ trails }), "utf8").toString("base64");
  return `<canvas data-layer-id="${escapeAttr(input.layerId)}" data-motion-trails="true" data-motion-trails-state="pending" data-motion-trails-count="${trails.length}" data-motion-trails-config="${config}" width="${Math.max(1, Math.round(input.width))}" height="${Math.max(1, Math.round(input.height))}" style="${input.style ?? "display:block;background:transparent"}"></canvas>`;
}

export function renderGeneratedParticleTrailCanvas(input: Omit<BrowserTrailCanvasInput, "resolveColor" | "style">): string {
  if (input.segments.length === 0) return "";
  return renderGeneratedTrailCanvas({
    ...input,
    resolveColor: (color) => color ?? "#ffffff",
    style: "position:absolute;left:0;top:0;display:block;background:transparent;pointer-events:none"
  });
}

export async function settleGeneratedMotionTrails(page: Page): Promise<void> {
  const selector = "canvas[data-motion-trails='true']";
  await page.waitForFunction((trailSelector) => {
    const trails = Array.from(document.querySelectorAll<HTMLCanvasElement>(trailSelector));
    return trails.every((canvas) => canvas.dataset.motionTrailsState === "ready" || canvas.dataset.motionTrailsState === "error");
  }, selector, { timeout: 5_000 });
  const failures = await page.evaluate((trailSelector) => Array.from(document.querySelectorAll<HTMLCanvasElement>(trailSelector))
    .filter((canvas) => canvas.dataset.motionTrailsState === "error")
    .map((canvas) => ({ layerId: canvas.dataset.layerId ?? "(unknown)", error: canvas.dataset.motionTrailsError ?? "trail drawing failed" })), selector);
  if (failures.length > 0) {
    throw new Error(`Trail render failed: ${failures.map((failure) => `${failure.layerId}: ${failure.error}`).join("; ")}`);
  }
}

/** Fixed engine implementation code, never package-authored script. */
export function fixedTrailRuntimeScript(): string {
  return `<script>(()=>{
const decode=(text)=>JSON.parse(atob(text));
for(const canvas of document.querySelectorAll("canvas[data-motion-trails='true']")){
 try{
  const config=decode(canvas.dataset.motionTrailsConfig||"");const context=canvas.getContext("2d",{alpha:true});
  if(!context)throw new Error("could not create a 2D trail surface");context.clearRect(0,0,canvas.width,canvas.height);context.lineCap="round";
  for(const trail of config.trails){
   if(!Number.isFinite(trail.x0)||!Number.isFinite(trail.y0)||!Number.isFinite(trail.x1)||!Number.isFinite(trail.y1)||!Number.isFinite(trail.width)||!Number.isFinite(trail.opacity))throw new Error("received a non-finite trail value");
   context.globalAlpha=trail.opacity;context.strokeStyle=trail.color;context.lineWidth=trail.width;context.beginPath();context.moveTo(trail.x0,trail.y0);context.lineTo(trail.x1,trail.y1);context.stroke();
  }
  context.globalAlpha=1;canvas.dataset.motionTrailsState="ready";
 }catch(error){canvas.dataset.motionTrailsState="error";canvas.dataset.motionTrailsError=String(error instanceof Error?error.message:error).slice(0,512);}
}
})();</script>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
