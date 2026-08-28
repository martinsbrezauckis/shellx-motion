import type { GpuTextFitEvidence, InternalGpuFramePlan, GpuRuntimeFailure } from "./gpu-runtime-types";

export interface GpuPageSessionFontInput {
  resourceId: string;
  family: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  bytesBase64: string;
}
export type GpuPageTextFitEvidence = GpuTextFitEvidence;
export type GpuPageSessionTextOutput = { ok: true; count: number; textFit: readonly GpuPageTextFitEvidence[] } | { ok: false; failure: GpuRuntimeFailure };

/** Registers exact manifest font bytes with the retained renderer page. */
export async function uploadWebGpuPageSessionFonts(inputs: GpuPageSessionFontInput[]): Promise<GpuPageSessionTextOutput> {
  type FontSet = { add(face: unknown): void; check(font: string, text?: string): boolean };
  type FontFaceCtor = new (family: string, source: ArrayBuffer, descriptors: { weight: string; style: string; display: string }) => { load(): Promise<unknown> };
  const fail = (message: string): GpuPageSessionTextOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const browserGlobal = globalThis as unknown as { atob?(value: string): string; FontFace?: FontFaceCtor; document?: { fonts?: FontSet }; __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { fonts?: Map<string, unknown> } | undefined;
  if (!state || typeof browserGlobal.atob !== "function" || !browserGlobal.FontFace || !browserGlobal.document?.fonts) return fail("The persistent GPU page session cannot register package fonts.");
  if (!Array.isArray(inputs) || inputs.length > 32) return fail("GPU font resources exceed the 32-face session budget.");
  state.fonts ??= new Map<string, unknown>(); const staged: Array<{ id: string; face: unknown }> = [];
  try {
    for (const input of inputs) {
      if (!input || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.resourceId) || state.fonts.has(input.resourceId) || staged.some((entry) => entry.id === input.resourceId)) throw new Error("GPU font resource id is invalid or duplicated.");
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(input.family) || !Number.isInteger(input.weight) || input.weight < 1 || input.weight > 1_000 || !["normal", "italic", "oblique"].includes(input.style)) throw new Error("GPU font resource metadata is invalid.");
      const binary = browserGlobal.atob(input.bytesBase64); if (binary.length < 1 || binary.length > 16 * 1024 * 1024) throw new Error("GPU font resource bytes are outside the fixed limit.");
      const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const face = new browserGlobal.FontFace(input.family, bytes.buffer, { weight: String(input.weight), style: input.style, display: "block" });
      await face.load(); browserGlobal.document.fonts.add(face); staged.push({ id: input.resourceId, face });
    }
    for (const entry of staged) state.fonts.set(entry.id, entry.face);
    return { ok: true, count: staged.length, textFit: [] };
  } catch (error) { return fail(error instanceof Error ? error.message : "GPU package font registration failed."); }
}

/** Rasterizes browser-shaped text into bounded cached textures before the GPU render pass. */
export async function prepareWebGpuPageSessionTextSurfaces(plan: InternalGpuFramePlan): Promise<GpuPageSessionTextOutput> {
  type Texture = { createView(): unknown; destroy?(): void };
  type Device = {
    createBindGroup(value: unknown): unknown;
    createTexture(value: unknown): Texture;
    pushErrorScope(filter: "validation"): void;
    popErrorScope(): Promise<{ message?: unknown } | null>;
    queue: { copyExternalImageToTexture(a: unknown,b: unknown,c: unknown): void; onSubmittedWorkDone(): Promise<void> };
  };
  type TextFit = GpuPageTextFitEvidence;
  type TextSurface = { texture: Texture; bindGroup: unknown; bytes: number; signature: string; textFit: TextFit | null };
  type Context2d = {
    direction: string; fillStyle: string; font: string; fontKerning: string; letterSpacing?: string; textAlign: string; textBaseline: string;
    shadowOffsetX?: number; shadowOffsetY?: number; shadowBlur?: number; shadowColor?: string;
    fillText(text: string, x: number, y: number): void; measureText(text: string): { width: number; actualBoundingBoxAscent?: number; actualBoundingBoxDescent?: number; actualBoundingBoxLeft?: number; actualBoundingBoxRight?: number };
  };
  const fail = (message: string): GpuPageSessionTextOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const browserGlobal = globalThis as unknown as { document?: { fonts?: { check(font: string, text?: string): boolean }; createElement(name: string): { width: number; height: number; getContext(kind: string): Context2d | null } }; GPUTextureUsage?: Record<string, number>; __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; imagePipeline: { getBindGroupLayout(index: number): unknown }; imageSampler: unknown; fonts: Map<string, unknown>; textSurfaces?: Map<string, TextSurface>; textSurfaceBytes?: number } | undefined;
  const usage = browserGlobal.GPUTextureUsage; if (!state || !usage || !browserGlobal.document) return fail("The persistent GPU page session cannot prepare text surfaces.");
  if (typeof state.device.pushErrorScope !== "function" || typeof state.device.popErrorScope !== "function") return fail("The persistent GPU page session does not expose required WebGPU validation scopes.");
  state.textSurfaces ??= new Map<string, TextSurface>(); state.textSurfaceBytes ??= 0;
  const textDraws = plan.draws.filter((draw) => draw.kind === "text");
  const fitEvidence: TextFit[] = [];
  const createdSurfaces: Array<{ id: string; surface: TextSurface }> = [];
  const discardCreatedSurfaces = (): void => {
    for (const created of createdSurfaces) {
      const surfaces = state.textSurfaces;
      if (!surfaces || surfaces.get(created.id) !== created.surface) continue;
      created.surface.texture.destroy?.(); surfaces.delete(created.id); state.textSurfaceBytes = Math.max(0, (state.textSurfaceBytes ?? 0) - created.surface.bytes);
    }
  };
  const fitsText = (fit: { policy: "safe" | "allow-crop" | "auto-fit"; safeArea: { top: number; right: number; bottom: number; left: number } | null }, overflow: { horizontal: number; vertical: number; safe: { top: number; right: number; bottom: number; left: number } }): boolean => fit.policy === "allow-crop" || (overflow.horizontal <= 0.5 && overflow.vertical <= 0.5 && overflow.safe.top <= 0.5 && overflow.safe.right <= 0.5 && overflow.safe.bottom <= 0.5 && overflow.safe.left <= 0.5);
  const textOverflow = (draw: Extract<InternalGpuFramePlan["draws"][number], { kind: "text" }>, layout: { lines: string[]; linePixels: number; startY: number; drawX: number; measure(value: string): number }, fontSize: number, context: Context2d): { horizontal: number; vertical: number; safe: { top: number; right: number; bottom: number; left: number } } => {
    const round = (value: number) => Math.max(0, Number(value.toFixed(3))); const bounds: Array<{ x: number; y: number }> = [];
    for (const [index, line] of layout.lines.entries()) { if (!line) continue; const metric = context.measureText(line); const width = metric.width; const left = layout.drawX - (draw.textAlign === "center" ? width / 2 : draw.textAlign === "right" ? width : 0); const right = left + width; const baseline = layout.startY + fontSize + index * layout.linePixels; const ascent = metric.actualBoundingBoxAscent ?? fontSize * 0.8; const descent = metric.actualBoundingBoxDescent ?? fontSize * 0.2; bounds.push({ x: left, y: baseline - ascent }, { x: right, y: baseline - ascent }, { x: left, y: baseline + descent }, { x: right, y: baseline + descent }); }
    if (bounds.length === 0) return { horizontal: 0, vertical: 0, safe: { top: 0, right: 0, bottom: 0, left: 0 } };
    const radians = draw.rotationDeg * Math.PI / 180; const placed = bounds.map((point) => { const x = draw.x + point.x - draw.pivotX; const y = draw.y + point.y - draw.pivotY; return { x: draw.pivotX + x * Math.cos(radians) - y * Math.sin(radians), y: draw.pivotY + x * Math.sin(radians) + y * Math.cos(radians) }; }); const left = Math.min(...placed.map((point) => point.x)); const right = Math.max(...placed.map((point) => point.x)); const top = Math.min(...placed.map((point) => point.y)); const bottom = Math.max(...placed.map((point) => point.y)); const safeArea = draw.textFit?.safeArea;
    return { horizontal: round(Math.max(0, right - (draw.x + draw.width), draw.x - left)), vertical: round(Math.max(0, bottom - (draw.y + draw.height), draw.y - top)), safe: safeArea ? { top: round(safeArea.top - top), right: round(right - safeArea.right), bottom: round(bottom - safeArea.bottom), left: round(safeArea.left - left) } : { top: 0, right: 0, bottom: 0, left: 0 } };
  };
  let validationScopeOpen = false;
  try {
    state.device.pushErrorScope("validation"); validationScopeOpen = true;
    for (const draw of textDraws) {
      if (draw.kind !== "text") continue;
      if (draw.fontResourceIds.some((id) => !state.fonts?.has(id))) throw new Error(`GPU text surface '${draw.id}' references a font that was not registered.`);
      const signature = JSON.stringify({ fontResourceIds: draw.fontResourceIds, fontFamily: draw.fontFamily, text: draw.text, width: draw.width, height: draw.height, color: draw.color, fontSize: draw.fontSize, fontWeight: draw.fontWeight, fontStyle: draw.fontStyle, letterSpacing: draw.letterSpacing, lineHeight: draw.lineHeight, textAlign: draw.textAlign, verticalAlign: draw.verticalAlign, direction: draw.direction, textShadow: draw.textShadow, textFit: draw.textFit });
      const existing = state.textSurfaces.get(draw.surfaceId);
      if (existing) { if (existing.signature !== signature) throw new Error(`GPU text surface '${draw.surfaceId}' changed identity.`); state.textSurfaces.delete(draw.surfaceId); state.textSurfaces.set(draw.surfaceId, existing); if (existing.textFit) fitEvidence.push(existing.textFit); continue; }
      const width = Math.ceil(draw.width); const height = Math.ceil(draw.height); const bytes = width * height * 4;
      while (state.textSurfaces.size >= 128 || (state.textSurfaceBytes + bytes) > 128 * 1024 * 1024) {
        const oldest = state.textSurfaces.entries().next().value as [string, TextSurface] | undefined;
        if (!oldest) throw new Error("GPU text surface exceeds the retained cache budget.");
        oldest[1].texture.destroy?.(); state.textSurfaces.delete(oldest[0]); state.textSurfaceBytes -= oldest[1].bytes;
      }
      const canvas = browserGlobal.document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d"); if (!context) throw new Error("Browser text shaping canvas is unavailable.");
      if (draw.letterSpacing !== 0 && !("letterSpacing" in context)) throw new Error("Browser text shaping does not support declared letterSpacing.");
      context.direction = draw.direction; context.fontKerning = "normal"; if ("letterSpacing" in context) context.letterSpacing = `${draw.letterSpacing}px`;
      context.textAlign = draw.textAlign; context.textBaseline = "alphabetic";
      const setFont = (fontSize: number): void => { context.font = `${draw.fontStyle} ${draw.fontWeight} ${fontSize}px "${draw.fontFamily}"`; };
      setFont(draw.fontSize);
      if (!browserGlobal.document.fonts?.check(context.font, draw.text)) throw new Error(`GPU text surface '${draw.id}' could not verify its registered manifest font.`);
      const alpha = draw.color.a; context.fillStyle = `rgba(${Math.round(draw.color.r * 255)},${Math.round(draw.color.g * 255)},${Math.round(draw.color.b * 255)},${alpha})`;
      const layout = (fontSize: number) => {
        setFont(fontSize); const measure = (value: string) => context.measureText(value).width; const lines: string[] = [];
        for (const paragraph of draw.text.split("\n")) {
          if (!paragraph) { lines.push(""); continue; }
          let line = "";
          for (const token of paragraph.match(/\S+\s*|\s+/gu) ?? [paragraph]) {
            const candidate = line + token;
            if (!line || measure(candidate) <= width) { line = candidate; continue; }
            lines.push(line.trimEnd()); line = token.trimStart();
            while (line && measure(line) > width) { const symbols = Array.from(line); let low = 1; let high = symbols.length; while (low < high) { const middle = Math.ceil((low + high) / 2); if (measure(symbols.slice(0, middle).join("")) <= width) low = middle; else high = middle - 1; } const end = Math.max(1, low); lines.push(symbols.slice(0, end).join("")); line = symbols.slice(end).join(""); }
          }
          lines.push(line.trimEnd());
        }
        const linePixels = fontSize * draw.lineHeight; const totalHeight = lines.length * linePixels;
        const startY = draw.verticalAlign === "bottom" ? height - totalHeight : draw.verticalAlign === "middle" ? (height - totalHeight) / 2 : 0;
        const drawX = draw.textAlign === "center" ? width / 2 : draw.textAlign === "right" ? width : 0;
        return { lines, linePixels, startY, drawX, measure };
      };
      let appliedFontSize = draw.fontSize; let arranged = layout(appliedFontSize);
      const overflow = () => textOverflow(draw, arranged, appliedFontSize, context);
      let measured = overflow();
      if (draw.textFit?.policy === "auto-fit") {
        const minimum = draw.textFit.minFontSize ?? draw.fontSize;
        while (!fitsText(draw.textFit, measured) && appliedFontSize > minimum) { appliedFontSize = Math.max(minimum, appliedFontSize - 1); arranged = layout(appliedFontSize); measured = overflow(); }
      }
      if (draw.textFit && !fitsText(draw.textFit, measured)) throw new Error(`GPU text surface '${draw.id}' does not satisfy its ${draw.textFit.policy} glyph-layout contract.`);
      const textFit = draw.textFit ? {
        layerId: draw.id, surfaceId: draw.surfaceId, policy: draw.textFit.policy,
        status: draw.textFit.policy === "allow-crop" ? "allowed-crop" as const : draw.textFit.policy === "auto-fit" && appliedFontSize < draw.fontSize ? "auto-fitted" as const : "passed" as const,
        requestedFontSize: draw.fontSize, appliedFontSize, minFontSize: draw.textFit.minFontSize,
        internalOverflowPx: { horizontal: measured.horizontal, vertical: measured.vertical }, safeAreaOverflowPx: measured.safe
      } : null;
      if (textFit) fitEvidence.push(textFit);
      if (draw.textShadow) { context.shadowOffsetX = draw.textShadow.offsetX; context.shadowOffsetY = draw.textShadow.offsetY; context.shadowBlur = draw.textShadow.blur; context.shadowColor = `rgba(${Math.round(draw.textShadow.color.r * 255)},${Math.round(draw.textShadow.color.g * 255)},${Math.round(draw.textShadow.color.b * 255)},${draw.textShadow.color.a})`; }
      arranged.lines.forEach((line, index) => context.fillText(line, arranged.drawX, arranged.startY + appliedFontSize + index * arranged.linePixels));
      // copyExternalImageToTexture requires a render-attachment destination in
      // Chromium's WebGPU implementation. Sampling alone is not sufficient.
      const texture = state.device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format: "rgba8unorm", usage: usage.TEXTURE_BINDING | usage.COPY_DST | usage.RENDER_ATTACHMENT });
      state.device.queue.copyExternalImageToTexture({ source: canvas }, { texture }, { width, height, depthOrArrayLayers: 1 });
      const bindGroup = state.device.createBindGroup({ layout: state.imagePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: state.imageSampler }, { binding: 1, resource: texture.createView() }] });
      const surface = { texture, bindGroup, bytes, signature, textFit };
      state.textSurfaces.set(draw.surfaceId, surface); state.textSurfaceBytes += bytes; createdSurfaces.push({ id: draw.surfaceId, surface });
    }
    await state.device.queue.onSubmittedWorkDone();
    validationScopeOpen = false; const validation = await state.device.popErrorScope();
    if (validation) {
      discardCreatedSurfaces();
      const detail = typeof validation.message === "string" && validation.message.trim() ? `: ${validation.message}` : ".";
      return fail(`Persistent WebGPU text-surface validation failed${detail}`);
    }
    return { ok: true, count: textDraws.length, textFit: fitEvidence };
  } catch (error) {
    if (validationScopeOpen) await state.device.popErrorScope().catch(() => null);
    discardCreatedSurfaces();
    return fail(error instanceof Error ? error.message : "GPU text surface preparation failed.");
  }
}
