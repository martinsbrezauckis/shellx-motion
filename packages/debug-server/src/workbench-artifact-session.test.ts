import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { startMotionDebugServer, type MotionDebugServerHandle, type MotionDebugServerOptions } from "./index";

const TEST_CAPABILITY_TOKEN = "test-capability-token-000000000000000000000000";
const TEST_WORKSPACE_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const EDITABLE_LOWER_THIRD = resolve(fileURLToPath(import.meta.url), "../../../../fixtures/packages/editable-lower-third");
const PRODUCT_PACK_ROOT = fileURLToPath(new URL("../../../templates/shellx-product-pack", import.meta.url));
const SAFE_POSTER_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1280\" height=\"720\"><rect width=\"1280\" height=\"720\" fill=\"#071014\"/><text x=\"40\" y=\"80\" fill=\"#24d6ff\">Poster</text></svg>";
const SCRIPTED_POSTER_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><script>alert(1)</script></svg>";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startTestServer(options: MotionDebugServerOptions = {}): Promise<MotionDebugServerHandle> {
  return startMotionDebugServer({ ...options, capabilityToken: TEST_CAPABILITY_TOKEN });
}

function fetch(url: URL, init: RequestInit = {}): Promise<Response> {
  return globalThis.fetch(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${TEST_CAPABILITY_TOKEN}`
    }
  });
}

describe("Workbench artifact session ownership", () => {
  it("serves the local workbench without embedding capabilities and never accepts raw preview paths", async () => {
    const workspaceRoot = await mkdtemp(join(TEST_WORKSPACE_ROOT, "node_modules/shellx-motion-workbench-artifacts-workspace-"));
    const artifactRoot = await mkdtemp(join(workspaceRoot, "artifacts-"));
    const previewPath = join(artifactRoot, "preview.png");
    await writeFile(previewPath, PNG_SIGNATURE);
    const server = await withTrustedWorkspaceAnchor(
      await createTrustedWorkspaceAnchor(TEST_WORKSPACE_ROOT),
      async () => await startTestServer({ port: 0, artifactRoots: [artifactRoot], useDefaultTemplateRoots: false, context: { scratchRoot: artifactRoot } })
    );
    try {
      const workbench = await globalThis.fetch(new URL("/workbench", server.url));
      const html = await workbench.text();
      expect(workbench.status).toBe(200);
      expect(workbench.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(html).toContain("ShellX Motion Workbench");
      expect(html).not.toContain(TEST_CAPABILITY_TOKEN);

      const script = await globalThis.fetch(new URL("/workbench.js", server.url));
      expect(script.status).toBe(200);
      expect(await script.text()).toContain("motion.timeline.panel");

      const unauthenticated = await globalThis.fetch(new URL(`/workbench/artifact?path=${encodeURIComponent(previewPath)}`, server.url));
      expect(unauthenticated.status).toBe(401);

      const rawPath = await fetch(new URL(`/workbench/artifact?path=${encodeURIComponent(previewPath)}`, server.url));
      expect(rawPath.status).toBe(403);
      expect(await rawPath.json()).toMatchObject({ error: { code: "artifact_not_visible" } });
    } finally {
      await server.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("binds preview handles to the Workbench browser session and keeps manual Connect viable", async () => {
    const workspaceRoot = await mkdtemp(join(TEST_WORKSPACE_ROOT, "node_modules/shellx-motion-workbench-session-workspace-"));
    const artifactRoot = await mkdtemp(join(workspaceRoot, "artifacts-"));
    const server = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(TEST_WORKSPACE_ROOT), async () => await startTestServer({
      port: 0,
      grantedTier: "render_motion",
      useDefaultTemplateRoots: false,
      artifactRoots: [artifactRoot],
      context: {
        scratchRoot: artifactRoot,
        renderPackageRoots: [EDITABLE_LOWER_THIRD],
        browserFrameRenderer: async (pkg, options) => {
          const outputPath = options.outputPath ?? join(options.outDir, "frame.png");
          await writeFile(outputPath, PNG_SIGNATURE);
          return {
            ok: true,
            output: {
              path: outputPath, sha256: "a".repeat(64), format: "png", width: pkg.motion.width, height: pkg.motion.height,
              atMs: options.atMs, browser: { name: "workbench-session-test", version: "1" },
              viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
            },
            receipt: {
              schema: "shellx-motion/receipt@1", id: `preview-${options.atMs}`, operation: "preview.frame", status: "passed",
              packageId: pkg.manifest.id, inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-28T00:00:00.000Z",
              lane: "browser", output: { path: outputPath }, warnings: []
            }
          };
        }
      }
    }));
    const establishSession = async () => {
      const response = await fetch(new URL("/workbench/artifact-session", server.url), { method: "POST" });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("Path=/;");
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      expect(cookie).toMatch(/^shellx_motion_workbench_artifact_session=/);
      return cookie!;
    };
    const preview = async (cookie: string) => {
      const response = await fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command: "motion.preview.frame", requestedTier: "render_motion", args: { packageRoot: EDITABLE_LOWER_THIRD, atMs: 0 } })
      });
      const responseText = await response.text();
      expect(response.status, responseText).toBe(200);
      const body = JSON.parse(responseText) as { workbenchArtifact?: { handle?: string } };
      expect(body.workbenchArtifact?.handle).toMatch(/^wa_/);
      return body.workbenchArtifact!.handle!;
    };
    try {
      const callerA = await establishSession();
      const callerB = await establishSession();
      expect(callerA).not.toBe(callerB);
      const handleA = await preview(callerA);

      const ownerRead = await fetch(new URL(`/workbench/artifact?handle=${encodeURIComponent(handleA)}`, server.url), { headers: { cookie: callerA } });
      expect(ownerRead.status).toBe(200);
      expect(ownerRead.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await ownerRead.arrayBuffer())).toEqual(PNG_SIGNATURE);

      const crossCallerRead = await fetch(new URL(`/workbench/artifact?handle=${encodeURIComponent(handleA)}`, server.url), { headers: { cookie: callerB } });
      expect(crossCallerRead.status).toBe(403);
      expect(await crossCallerRead.json()).toMatchObject({ error: { code: "artifact_not_visible" } });
    } finally {
      await server.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("Workbench poster session ownership", () => {
  // Host-parity guard for the defect that shipped: the July 2026 pack replaced the
  // hand-drawn SVG mockups with real 1920x1080 PNG renders, but the poster endpoint
  // still allowed only ".svg", so agent consumers could not load the pack posters.
  it("serves every poster the shipped product pack declares", async () => {
    const workspaceRoot = await mkdtemp(join(TEST_WORKSPACE_ROOT, "node_modules/shellx-motion-product-pack-posters-workspace-"));
    const server = await withTrustedWorkspaceAnchor(
      await createTrustedWorkspaceAnchor(TEST_WORKSPACE_ROOT),
      async () => await startTestServer({ port: 0, templateRoots: [PRODUCT_PACK_ROOT], useDefaultTemplateRoots: false, context: { scratchRoot: workspaceRoot } })
    );
    try {
      const session = await fetch(new URL("/workbench/artifact-session", server.url), { method: "POST" });
      expect(session.status).toBe(200);
      expect(session.headers.get("set-cookie")).toContain("Path=/;");
      const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
      expect(cookie).toMatch(/^shellx_motion_workbench_artifact_session=/);
      const catalog = await fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({ command: "motion.template.catalog", args: { templateRoot: PRODUCT_PACK_ROOT }, requestedTier: "read_motion" })
      });
      const catalogBody = await catalog.json() as {
        result: { templates: Array<{ packageRoot: string; metadata: { preview?: { poster?: string } } }> };
        workbenchPosters?: Array<{ packageRoot: string; handle: string }>;
      };
      const templates = catalogBody.result.templates;
      const posterHandles = new Map((catalogBody.workbenchPosters ?? []).map((entry) => [entry.packageRoot, entry.handle]));
      expect(templates).toHaveLength(await productPackFamilyCount());

      for (const template of templates) {
        const declared = template.metadata.preview?.poster;
        expect(typeof declared).toBe("string");
        const posterPath = join(template.packageRoot, declared as string);
        const handle = posterHandles.get(template.packageRoot);
        expect(handle, `${posterPath} must have a Workbench handle`).toMatch(/^wp_/);
        let response: Response;
        try {
          response = await fetch(new URL(`/workbench/poster?handle=${encodeURIComponent(handle!)}`, server.url), {
            headers: { connection: "close", cookie: cookie! }
          });
        } catch (error) {
          throw new Error(`Poster request failed for ${posterPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        expect(response.status, `${posterPath} must be servable`).toBe(200);
        expect(response.headers.get("content-type")).toMatch(/^image\/(png|jpeg|svg\+xml)$/);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("content-security-policy")).toContain("sandbox");
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.byteLength).toBeGreaterThan(0);
        expect(bytes).toEqual(await readFile(posterPath));
      }
    } finally {
      await server.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("serves safe package-local posters and refuses traversal, absolute, and backslash metadata", async () => {
    const workspaceRoot = await mkdtemp(join(TEST_WORKSPACE_ROOT, "node_modules/shellx-motion-agent-posters-workspace-"));
    const templateRoot = await mkdtemp(join(workspaceRoot, "templates-"));
    const callerArtifactRoot = await mkdtemp(join(workspaceRoot, "caller-artifacts-"));
    const callerArtifactPosterPath = join(callerArtifactRoot, "preview.png");
    await writeFile(callerArtifactPosterPath, PNG_SIGNATURE);
    const safePackage = await writePosterTemplatePackage(templateRoot, "safe", "preview/poster.svg", SAFE_POSTER_SVG);
    const scriptedPackage = await writePosterTemplatePackage(templateRoot, "scripted", "preview/poster.svg", SCRIPTED_POSTER_SVG);
    const rasterPackage = await writePosterTemplatePackage(templateRoot, "raster", "preview/poster.png", PNG_SIGNATURE);
    const forgedRasterPackage = await writePosterTemplatePackage(templateRoot, "forged-raster", "preview/poster.png", "<html><script>alert(1)</script></html>");
    const rasterNamedSvgPackage = await writePosterTemplatePackage(templateRoot, "raster-named-svg", "preview/poster.svg", PNG_SIGNATURE);
    const gifPackage = await writePosterTemplatePackage(templateRoot, "gif", "preview/poster.gif", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"));
    const siblingPackage = await writePosterTemplatePackage(templateRoot, "sibling", "preview/private.png", PNG_SIGNATURE);
    const traversalPackage = await writePosterTemplatePackage(templateRoot, "traversal", "../sibling/preview/private.png");
    const absolutePackage = await writePosterTemplatePackage(templateRoot, "absolute", callerArtifactPosterPath);
    const backslashPackage = await writePosterTemplatePackage(templateRoot, "backslash", "preview\\poster.png");
    const server = await withTrustedWorkspaceAnchor(
      await createTrustedWorkspaceAnchor(TEST_WORKSPACE_ROOT),
      async () => await startTestServer({ port: 0, templateRoots: [templateRoot], artifactRoots: [callerArtifactRoot], useDefaultTemplateRoots: false, context: { scratchRoot: callerArtifactRoot } })
    );
    try {
      const establishSession = async () => {
        const response = await fetch(new URL("/workbench/artifact-session", server.url), { method: "POST" });
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toContain("Path=/;");
        const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
        expect(cookie).toMatch(/^shellx_motion_workbench_artifact_session=/);
        return cookie!;
      };
      const catalog = async (cookie: string) => {
        const response = await fetch(new URL("/debug", server.url), {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ command: "motion.template.catalog", args: { templateRoot }, requestedTier: "read_motion" })
        });
        expect(response.status).toBe(200);
        const body = await response.json() as { result?: unknown; workbenchPosters?: Array<{ packageRoot: string; handle: string }> };
        if (!body.workbenchPosters?.length) throw new Error(`Catalog did not return poster handles: ${JSON.stringify(body)}`);
        return new Map((body.workbenchPosters ?? []).map((entry) => [entry.packageRoot, entry.handle]));
      };
      const callerA = await establishSession();
      const callerB = await establishSession();
      const handles = await catalog(callerA);
      const handleFor = (packageRoot: string) => {
        const handle = handles.get(packageRoot);
        if (!handle) throw new Error(`${packageRoot} must have a poster handle; received ${JSON.stringify([...handles.keys()])}`);
        expect(handle).toMatch(/^wp_/);
        return handle;
      };
      const poster = async (handle: string, cookie = callerA) => await fetch(
        new URL(`/workbench/poster?handle=${encodeURIComponent(handle)}`, server.url),
        { headers: { cookie } }
      );

      const anonymous = await globalThis.fetch(new URL(`/workbench/poster?path=${encodeURIComponent(join(safePackage, "preview/poster.svg"))}`, server.url));
      expect(anonymous.status).toBe(401);

      const rawPath = await fetch(new URL(`/workbench/poster?path=${encodeURIComponent(join(safePackage, "preview/poster.svg"))}`, server.url));
      expect(rawPath.status).toBe(403);
      expect(await rawPath.json()).toMatchObject({ error: { code: "poster_not_visible" } });

      const safe = await poster(handleFor(safePackage));
      expect(safe.status).toBe(200);
      expect(safe.headers.get("content-type")).toBe("image/svg+xml");
      expect(safe.headers.get("content-security-policy")).toContain("sandbox");
      expect(safe.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await safe.text()).toBe(SAFE_POSTER_SVG);

      const sibling = await poster(handleFor(siblingPackage));
      expect(sibling.status).toBe(200);
      expect(Buffer.from(await sibling.arrayBuffer())).toEqual(PNG_SIGNATURE);

      const crossCaller = await poster(handleFor(safePackage), callerB);
      expect(crossCaller.status).toBe(403);
      expect(await crossCaller.json()).toMatchObject({ error: { code: "poster_not_visible" } });

      const scripted = await poster(handleFor(scriptedPackage));
      expect(scripted.status).toBe(400);
      expect(await scripted.json()).toMatchObject({ error: { code: "unsafe_poster" } });

      const raster = await poster(handleFor(rasterPackage));
      expect(raster.status).toBe(200);
      expect(raster.headers.get("content-type")).toBe("image/png");
      expect(raster.headers.get("x-content-type-options")).toBe("nosniff");
      expect(raster.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(Buffer.from(await raster.arrayBuffer())).toEqual(PNG_SIGNATURE);

      const forgedRaster = await poster(handleFor(forgedRasterPackage));
      expect(forgedRaster.status).toBe(400);
      expect(await forgedRaster.json()).toMatchObject({ error: { code: "unsafe_poster" } });

      const rasterNamedSvg = await poster(handleFor(rasterNamedSvgPackage));
      expect(rasterNamedSvg.status).toBe(400);
      expect(await rasterNamedSvg.json()).toMatchObject({ error: { code: "unsafe_poster" } });

      const gifPoster = await poster(handleFor(gifPackage));
      expect(gifPoster.status).toBe(400);
      expect(await gifPoster.json()).toMatchObject({ error: { code: "unsupported_poster" } });

      expect(handles.has(traversalPackage)).toBe(false);
      expect(handles.has(absolutePackage)).toBe(false);
      expect(handles.has(backslashPackage)).toBe(false);
    } finally {
      await server.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("refuses a package replaced after catalog discovery while preserving legitimate poster handles", async () => {
    const workspaceRoot = await mkdtemp(join(TEST_WORKSPACE_ROOT, "node_modules/shellx-motion-poster-swap-workspace-"));
    const templateRoot = await mkdtemp(join(workspaceRoot, "templates-"));
    const replacementRoot = await mkdtemp(join(workspaceRoot, "replacement-"));
    const originalBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("catalog-original", "utf8")]);
    const replacementBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("replacement", "utf8")]);
    const stableBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("stable", "utf8")]);
    const catalogPackage = await writePosterTemplatePackage(templateRoot, "catalog-package", "preview/original.png", originalBytes);
    const stablePackage = await writePosterTemplatePackage(templateRoot, "stable-package", "preview/stable.png", stableBytes);
    const replacementPackage = await writePosterTemplatePackage(replacementRoot, "replacement-package", "preview/replacement.png", replacementBytes);
    const displacedPackage = join(workspaceRoot, "catalog-package-before-swap");
    let swapped = false;
    const server = await withTrustedWorkspaceAnchor(
      await createTrustedWorkspaceAnchor(TEST_WORKSPACE_ROOT),
      async () => await startTestServer({
        port: 0,
        templateRoots: [templateRoot],
        useDefaultTemplateRoots: false,
        context: { scratchRoot: workspaceRoot },
        onWorkbenchPosterPackageAdmission: async (packageRoot) => {
          if (swapped || packageRoot !== catalogPackage) return;
          await rename(catalogPackage, displacedPackage);
          await rename(replacementPackage, catalogPackage);
          swapped = true;
        }
      })
    );
    try {
      const session = await fetch(new URL("/workbench/artifact-session", server.url), { method: "POST" });
      expect(session.status).toBe(200);
      const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
      expect(cookie).toMatch(/^shellx_motion_workbench_artifact_session=/);

      const catalog = await fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({ command: "motion.template.catalog", args: { templateRoot }, requestedTier: "read_motion" })
      });
      expect(catalog.status).toBe(200);
      const body = await catalog.json() as { workbenchPosters?: Array<{ packageRoot: string; handle: string }> };
      const handles = new Map((body.workbenchPosters ?? []).map((entry) => [entry.packageRoot, entry.handle]));

      expect(swapped).toBe(true);
      expect(await readFile(join(catalogPackage, "preview/replacement.png"))).toEqual(replacementBytes);
      expect(handles.has(catalogPackage)).toBe(false);
      const rawReplacement = await fetch(new URL(`/workbench/poster?path=${encodeURIComponent(join(catalogPackage, "preview/replacement.png"))}`, server.url), {
        headers: { cookie: cookie! }
      });
      expect(rawReplacement.status).toBe(403);
      expect(await rawReplacement.json()).toMatchObject({ error: { code: "poster_not_visible" } });

      const stableHandle = handles.get(stablePackage);
      expect(stableHandle).toMatch(/^wp_/);
      const stablePoster = await fetch(new URL(`/workbench/poster?handle=${encodeURIComponent(stableHandle!)}`, server.url), {
        headers: { cookie: cookie! }
      });
      expect(stablePoster.status).toBe(200);
      expect(Buffer.from(await stablePoster.arrayBuffer())).toEqual(stableBytes);
    } finally {
      await server.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

async function productPackFamilyCount(): Promise<number> {
  const entries = await readdir(PRODUCT_PACK_ROOT, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
}

async function writePosterTemplatePackage(root: string, id: string, poster: string, bytes?: Buffer | string): Promise<string> {
  const packageRoot = join(root, id);
  await mkdir(join(packageRoot, "preview"), { recursive: true });
  await writeFile(join(packageRoot, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: `pkg_${id}`, name: `Poster ${id}`,
    motion: "motion.json", template: "template.json", sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] }
  }));
  await writeFile(join(packageRoot, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1", id: `motion_${id}`, name: `Poster ${id}`,
    durationMs: 1000, fps: 30, width: 1280, height: 720, background: "#000000", layers: [],
    provenance: { sourceApp: "test", createdBy: "test", workflow: "test" }
  }));
  await writeFile(join(packageRoot, "template.json"), JSON.stringify({
    schema: "shellx-motion/template@1", id: `template_${id}`, name: `Poster ${id}`, motion: "motion.json",
    compatibleLanes: ["browser"], compatibleHosts: ["shellx-motion"], metadata: { preview: { poster } },
    groups: [], params: [], controls: [], bindings: []
  }));
  if (bytes !== undefined) await writeFile(join(packageRoot, poster), bytes);
  return packageRoot;
}
