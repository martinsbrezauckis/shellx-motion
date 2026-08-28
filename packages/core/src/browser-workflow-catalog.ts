import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { acquireDerivedOutputPublication } from "./derived-output-publication";
import {
  emptyBrowserWorkflowCatalog,
  normalizeBrowserWorkflowCatalog,
  prepareBrowserWorkflowCatalogUpdate,
  type BrowserWorkflowCatalog,
  type BrowserWorkflowCatalogCapture,
  type BrowserWorkflowCatalogEntry,
  type BrowserWorkflowDriftSummary
} from "./browser-workflow-catalog-model";

export {
  browserWorkflowCatalogKey,
  prepareBrowserWorkflowCatalogUpdate,
  type BrowserWorkflowCatalog,
  type BrowserWorkflowCatalogCapture,
  type BrowserWorkflowCatalogCaptureReadiness,
  type BrowserWorkflowCatalogEntry,
  type BrowserWorkflowCatalogSnapshot,
  type BrowserWorkflowDriftStatus,
  type BrowserWorkflowDriftSummary
} from "./browser-workflow-catalog-model";

export interface UpsertBrowserWorkflowCatalogInput {
  catalogPath: string;
  capture: BrowserWorkflowCatalogCapture;
}

export interface UpsertBrowserWorkflowCatalogResult {
  ok: true;
  catalogPath: string;
  drift: BrowserWorkflowDriftSummary;
  entry: BrowserWorkflowCatalogEntry;
  catalog: BrowserWorkflowCatalog;
}

/** A catalog candidate held privately until its already-committed capture may advance history. */
export interface PreparedBrowserWorkflowCatalogUpsert {
  result: UpsertBrowserWorkflowCatalogResult;
  commit(): Promise<UpsertBrowserWorkflowCatalogResult>;
  abort(): Promise<void>;
}

export async function readBrowserWorkflowCatalog(catalogPath: string): Promise<BrowserWorkflowCatalog> {
  try {
    const parsed: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
    return normalizeBrowserWorkflowCatalog(parsed);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return emptyBrowserWorkflowCatalog();
    throw error;
  }
}

export async function upsertBrowserWorkflowCatalog(input: UpsertBrowserWorkflowCatalogInput): Promise<UpsertBrowserWorkflowCatalogResult> {
  const prepared = await prepareBrowserWorkflowCatalogUpsert(input);
  try {
    return await prepared.commit();
  } catch (error) {
    await prepared.abort().catch(() => undefined);
    throw error;
  }
}

/** Prepare one exact catalog update under a retained force reservation without publishing it. */
export async function prepareBrowserWorkflowCatalogUpsert(input: UpsertBrowserWorkflowCatalogInput): Promise<PreparedBrowserWorkflowCatalogUpsert> {
  const catalogPath = resolve(input.catalogPath);
  const publication = await acquireDerivedOutputPublication({ outputPath: catalogPath, kind: "file", force: true });
  try {
    const candidate = prepareBrowserWorkflowCatalogUpdate(await readBrowserWorkflowCatalog(catalogPath), input.capture);
    await writeFile(publication.stagingPath, `${JSON.stringify(candidate.catalog, null, 2)}\n`, "utf8");
    const evidence = await publication.verifyFile();
    const result: UpsertBrowserWorkflowCatalogResult = {
      ok: true,
      catalogPath,
      drift: candidate.entry.drift,
      entry: candidate.entry,
      catalog: candidate.catalog
    };
    let finished = false;
    return {
      result,
      async commit(): Promise<UpsertBrowserWorkflowCatalogResult> {
        if (finished) throw new Error("Prepared browser workflow catalog update is already finished.");
        finished = true;
        await publication.publishFile(evidence);
        return result;
      },
      async abort(): Promise<void> {
        if (finished) return;
        finished = true;
        await publication.abort();
      }
    };
  } catch (error) {
    await publication.abort();
    throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
