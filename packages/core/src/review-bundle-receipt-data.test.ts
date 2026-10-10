import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withReviewBundleReceiptTraversalTestHooks } from "./internal/review-bundle-receipt-traversal-test-hooks";
import { ExistingDirectoryAuthority } from "./output-path-topology";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import {
  MAX_REVIEW_BUNDLE_RECEIPT_TREE_DIRECTORIES,
  MAX_REVIEW_BUNDLE_RECEIPT_TREE_ENTRIES,
  MAX_REVIEW_BUNDLE_RECEIPT_BYTES,
  readReviewBundleReceiptEntries,
  REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS
} from "./review-bundle-receipt-data";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("direct review-bundle receipt admission", () => {
  it("refuses an over-full receipt tree before ingesting all candidate receipts", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-bound-"));
      roots.push(receiptsRoot);

      await Promise.all(Array.from({ length: 257 }, async (_, index) => {
        await writeFile(join(receiptsRoot, `${String(index).padStart(3, "0")}.receipt.json`), receiptBytes("review-receipt-bound"));
      }));

      await expect(readReviewBundleReceiptEntries(receiptsRoot))
        .rejects.toThrow(/Review bundle receipt traversal exceeds the 256-file limit/);
    });
  });

  it("refuses a receipt tree that exceeds the retained path-depth boundary", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-depth-"));
      roots.push(receiptsRoot);
      let nested = receiptsRoot;
      for (let index = 0; index < REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS.maxPathDepth; index += 1) {
        nested = join(nested, `nested-${index}`);
        await mkdir(nested);
      }

      await expect(readReviewBundleReceiptEntries(receiptsRoot))
        .rejects.toThrow(/Review bundle receipt traversal exceeds the 16-component path-depth limit/);
    });
  });

  it("refuses directory fan-out before it becomes unbounded traversal work", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-directories-"));
      roots.push(receiptsRoot);
      await Promise.all(Array.from({ length: MAX_REVIEW_BUNDLE_RECEIPT_TREE_DIRECTORIES }, async (_, index) => {
        await mkdir(join(receiptsRoot, `directory-${index}`));
      }));

      await expect(readReviewBundleReceiptEntries(receiptsRoot))
        .rejects.toThrow(new RegExp(`Review bundle receipt traversal exceeds the ${MAX_REVIEW_BUNDLE_RECEIPT_TREE_DIRECTORIES}-directory limit`));
    });
  });

  it("refuses non-receipt tree noise after the bounded entry scan", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-entries-"));
      roots.push(receiptsRoot);
      await Promise.all(Array.from({ length: MAX_REVIEW_BUNDLE_RECEIPT_TREE_ENTRIES + 1 }, async (_, index) => {
        await writeFile(join(receiptsRoot, `noise-${index}.txt`), "noise", "utf8");
      }));

      await expect(readReviewBundleReceiptEntries(receiptsRoot))
        .rejects.toThrow(new RegExp(`Review bundle receipt traversal exceeds the ${MAX_REVIEW_BUNDLE_RECEIPT_TREE_ENTRIES}-entry limit`));
    });
  }, 45_000);

  it("refuses a selected root that was replaced after its authority was retained", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-root-"));
      const originalRoot = `${receiptsRoot}-original`;
      roots.push(receiptsRoot, originalRoot);
      const authority = await ExistingDirectoryAuthority.acquire(receiptsRoot);

      await rename(receiptsRoot, originalRoot);
      await mkdir(receiptsRoot, { mode: 0o700 });
      await writeFile(join(receiptsRoot, "replacement.receipt.json"), receiptBytes("replacement-root"));

      await expect(readReviewBundleReceiptEntries(receiptsRoot, authority))
        .rejects.toThrow(/changed after (Motion captured its identity|admission|topology)/);
    });
  });

  it.runIf(process.platform === "linux")("refuses a nested directory substituted after Dirent classification", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-directory-race-"));
      const nested = join(receiptsRoot, "nested");
      const displaced = join(receiptsRoot, "nested-admitted");
      const outside = await mkdtemp(join(parent, "shellx-motion-review-receipt-directory-outside-"));
      roots.push(receiptsRoot, outside);
      await mkdir(nested, { mode: 0o700 });
      await writeFile(join(nested, "render.receipt.json"), receiptBytes("nested-admitted"));
      await writeFile(join(outside, "replacement.receipt.json"), receiptBytes("outside-replacement"));
      let substituted = false;

      await expect(withReviewBundleReceiptTraversalTestHooks({
        afterDirectoryClassifiedBeforeOpen: async (path) => {
          if (substituted || !path.endsWith("/nested")) return;
          await rename(nested, displaced);
          await symlink(outside, nested, "dir");
          substituted = true;
        }
      }, async () => await readReviewBundleReceiptEntries(receiptsRoot)))
        .rejects.toThrow(/directory changed while it was opened|symbolic link/i);
      expect(substituted).toBe(true);
    });
  });

  it("refuses a regular nested directory replacement after identity admission", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-directory-identity-race-"));
      const nested = join(receiptsRoot, "nested");
      const displaced = join(receiptsRoot, "nested-admitted");
      const replacement = join(receiptsRoot, "nested-replacement");
      roots.push(receiptsRoot);
      await Promise.all([mkdir(nested, { mode: 0o700 }), mkdir(replacement, { mode: 0o700 })]);
      await writeFile(join(nested, "render.receipt.json"), receiptBytes("nested-admitted"));
      await writeFile(join(replacement, "render.receipt.json"), receiptBytes("nested-replacement"));
      let substituted = false;

      await expect(withReviewBundleReceiptTraversalTestHooks({
        afterDirectoryClassifiedBeforeOpen: async (path) => {
          if (substituted || !path.endsWith("/nested")) return;
          await rename(nested, displaced);
          await rename(replacement, nested);
          substituted = true;
        }
      }, async () => await readReviewBundleReceiptEntries(receiptsRoot)))
        .rejects.toThrow(/directory changed while it was verified/i);
      expect(substituted).toBe(true);
    });
  });

  it("refuses a retained nested directory replacement before post-recursion recheck", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-directory-post-recursion-race-"));
      const nested = join(receiptsRoot, "nested");
      const displaced = join(receiptsRoot, "nested-admitted");
      const replacement = join(receiptsRoot, "nested-replacement");
      const receiptName = "render.receipt.json";
      roots.push(receiptsRoot);
      await Promise.all([mkdir(nested, { mode: 0o700 }), mkdir(replacement, { mode: 0o700 })]);
      await writeFile(join(nested, receiptName), receiptBytes("nested-admitted"));
      await writeFile(join(replacement, receiptName), receiptBytes("nested-replacement"));
      let substituted = false;

      await expect(withReviewBundleReceiptTraversalTestHooks({
        afterDirectoryTraversedBeforeRecheck: async (path) => {
          if (substituted || !path.endsWith("/nested")) return;
          await rename(nested, displaced);
          await rename(replacement, nested);
          substituted = true;
        }
      }, async () => await readReviewBundleReceiptEntries(receiptsRoot)))
        .rejects.toThrow(/directory changed while it was verified/i);
      expect(substituted).toBe(true);
    });
  });

  it("keeps the admitted nested receipt root-relative", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-nested-"));
      const nested = join(receiptsRoot, "nested");
      roots.push(receiptsRoot);
      await mkdir(nested, { mode: 0o700 });
      await writeFile(join(nested, "render.receipt.json"), receiptBytes("nested-receipt"));

      await expect(readReviewBundleReceiptEntries(receiptsRoot)).resolves.toMatchObject([
        { relativePath: "nested/render.receipt.json", receipt: { id: "nested-receipt" } }
      ]);
    });
  });

  it("refuses an oversized receipt before allocating or parsing it", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-per-file-"));
      roots.push(receiptsRoot);
      await writeFile(join(receiptsRoot, "oversized.receipt.json"), receiptBytes("oversized", MAX_REVIEW_BUNDLE_RECEIPT_BYTES + 1));

      await expect(readReviewBundleReceiptEntries(receiptsRoot))
        .rejects.toThrow(/Review bundle receipt exceeds its byte limit and must be a bounded regular non-symlink file/);
    });
  });

  it("refuses malformed receipt JSON without treating it as an omission", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-malformed-"));
      roots.push(receiptsRoot);
      await writeFile(join(receiptsRoot, "malformed.receipt.json"), "{", "utf8");

      await expect(readReviewBundleReceiptEntries(receiptsRoot)).rejects.toThrow(SyntaxError);
    });
  });

  it("does not execute an untyped third public-call argument", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-public-signature-"));
      roots.push(receiptsRoot);
      await writeFile(join(receiptsRoot, "render.receipt.json"), receiptBytes("public-signature"));
      let callbackRan = false;

      const result = Reflect.apply(readReviewBundleReceiptEntries, undefined, [receiptsRoot, undefined, {
        afterReceiptPreflight: () => { callbackRan = true; }
      }]) as Promise<unknown>;
      await expect(result).resolves.toBeDefined();
      expect(callbackRan).toBe(false);
    });
  });

  it("refuses a receipt leaf replaced between metadata admission and the stable read", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-leaf-race-"));
      const receiptPath = join(receiptsRoot, "render.receipt.json");
      const displaced = join(receiptsRoot, "render-admitted.receipt.json");
      const outside = await mkdtemp(join(parent, "shellx-motion-review-receipt-leaf-outside-"));
      roots.push(receiptsRoot, outside);
      await writeFile(receiptPath, receiptBytes("leaf-admitted"));
      await writeFile(join(outside, "replacement.receipt.json"), receiptBytes("leaf-replacement"));
      let substituted = false;

      await expect(withReviewBundleReceiptTraversalTestHooks({
        afterReceiptPreflight: async (path) => {
          if (substituted || path !== receiptPath) return;
          await rename(receiptPath, displaced);
          await symlink(join(outside, "replacement.receipt.json"), receiptPath, "file");
          substituted = true;
        }
      }, async () => await readReviewBundleReceiptEntries(receiptsRoot)))
        .rejects.toThrow(/bounded regular non-symlink|changed while it was read/i);
      expect(substituted).toBe(true);
    });
  });

  it("reserves the aggregate byte budget before reading another receipt", async () => {
    await withinWorkspace(async (parent) => {
      const receiptsRoot = await mkdtemp(join(parent, "shellx-motion-review-receipt-aggregate-"));
      roots.push(receiptsRoot);
      const receiptBytesPerFile = Math.floor(REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS.maxAggregateBytes / 5) + 1;
      await Promise.all(Array.from({ length: 5 }, async (_, index) => {
        await writeFile(join(receiptsRoot, `${index}.receipt.json`), receiptBytes(`aggregate-${index}`, receiptBytesPerFile));
      }));

      await expect(readReviewBundleReceiptEntries(receiptsRoot))
        .rejects.toThrow(new RegExp(`Review bundle receipt traversal exceeds the ${REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS.maxAggregateBytes}-byte aggregate limit`));
    });
  });
});

function receiptBytes(id: string, minimumByteLength?: number): Buffer {
  const receipt = Buffer.from(`${JSON.stringify({
    schema: "shellx-motion/receipt@1",
    id,
    operation: "render.final",
    status: "passed",
    packageId: "pkg_review",
    inputHashes: {},
    createdAt: "2026-08-31T00:00:00.000Z",
    lane: "ffmpeg",
    output: {},
    warnings: []
  })}\n`, "utf8");
  if (minimumByteLength === undefined) return receipt;
  const bytes = Buffer.alloc(minimumByteLength, 0x20);
  receipt.copy(bytes);
  return bytes;
}

async function withinWorkspace<T>(action: (parent: string) => Promise<T>): Promise<T> {
  const parent = resolve(".scratch");
  await mkdir(parent, { recursive: true });
  if (process.platform === "win32") return await action(parent);
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(parent), async () => await action(parent));
}
