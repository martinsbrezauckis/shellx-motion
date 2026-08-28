import { effectivePointCloudAtMs, type MotionLayer, type MotionTrailSegment } from "@shellx-motion/core";

export interface BrowserPointCloudRenderInput {
  layer: MotionLayer;
  atMs: number;
  width: number;
  height: number;
  style: string;
  resolveColor: (value: string) => string;
  trails?: readonly MotionTrailSegment[];
}

/** One renderer-owned 2D canvas per declarative point-cloud layer; never one DOM node per point. */
export function renderGeneratedPointCloud(input: BrowserPointCloudRenderInput): string {
  const pointCloud = input.layer.pointCloud;
  if (!pointCloud) throw new Error(`Points layer ${input.layer.id} has no pointCloud payload.`);
  const fallbackColor = pointColorFallback(input.layer);
  const points = effectivePointCloudAtMs(pointCloud, input.atMs).map((point) => ({
    x: point.x,
    y: point.y,
    size: point.size,
    opacity: point.opacity,
    color: input.resolveColor(point.color ?? fallbackColor),
  }));
  const trails = (input.trails ?? []).map((segment) => ({
    x0: segment.x0, y0: segment.y0, x1: segment.x1, y1: segment.y1,
    width: segment.width, opacity: segment.opacity, color: input.resolveColor(segment.color ?? fallbackColor)
  }));
  const config = Buffer.from(JSON.stringify({ points, trails }), "utf8").toString("base64");
  return `<canvas data-layer-id="${escapeAttr(input.layer.id)}" data-motion-points="true" data-motion-points-state="pending" data-motion-points-count="${points.length}" data-motion-points-config="${config}" width="${Math.max(1, Math.round(input.width))}" height="${Math.max(1, Math.round(input.height))}" data-start="${input.layer.startMs}" data-duration="${input.layer.durationMs}" style="${input.style}display:block;background:transparent"></canvas>`;
}

/** Fixed engine implementation code, not package-authored or imported script. */
export function fixedPointsRuntimeScript(): string {
  return `<script>(()=>{
const decode=(text)=>JSON.parse(atob(text));
for(const canvas of document.querySelectorAll("canvas[data-motion-points='true']")){
 try{
  const config=decode(canvas.dataset.motionPointsConfig||"");
  const context=canvas.getContext("2d",{alpha:true});
  if(!context)throw new Error("could not create a 2D point surface");
  context.clearRect(0,0,canvas.width,canvas.height);
  context.lineCap="round";
  for(const trail of config.trails||[]){
   if(!Number.isFinite(trail.x0)||!Number.isFinite(trail.y0)||!Number.isFinite(trail.x1)||!Number.isFinite(trail.y1)||!Number.isFinite(trail.width)||!Number.isFinite(trail.opacity))throw new Error("received a non-finite trail value");
   context.globalAlpha=trail.opacity;context.strokeStyle=trail.color;context.lineWidth=trail.width;context.beginPath();context.moveTo(trail.x0,trail.y0);context.lineTo(trail.x1,trail.y1);context.stroke();
  }
  for(const point of config.points){
   if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||!Number.isFinite(point.size)||!Number.isFinite(point.opacity))throw new Error("received a non-finite point value");
   context.globalAlpha=point.opacity;context.fillStyle=point.color;context.beginPath();context.arc(point.x,point.y,point.size/2,0,Math.PI*2);context.fill();
  }
  context.globalAlpha=1;canvas.dataset.motionPointsState="ready";
 }catch(error){canvas.dataset.motionPointsState="error";canvas.dataset.motionPointsError=String(error instanceof Error?error.message:error).slice(0,512);}
}
})();</script>`;
}

function pointColorFallback(layer: MotionLayer): string {
  const style = record(layer.style);
  return string(layer.fill) ?? string(layer.color) ?? string(style.fill) ?? string(style.color) ?? "#ffffff";
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
