import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandMotionPackageRows, filterMotionDataRows, loadDataRowsFile, loadMotionPackage, loadPackageDataRows, parseMotionDataRows, parseMotionDataRowsCsv } from "./index";

describe("motion data rows", () => {
  const fixtureRoot = resolve("../../fixtures/packages/batch-card");
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads package-local rows and expands a Motion package per row", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    const rows = await loadPackageDataRows(pkg);
    const jobs = expandMotionPackageRows(pkg, rows);

    expect(rows.map((row) => row.id)).toEqual(["ada", "grace"]);
    expect(rows[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(jobs.map((job) => job.manifest.id)).toEqual(["pkg_batch_card_ada", "pkg_batch_card_grace"]);
    expect(jobs[0].motion.id).toBe("motion_batch_card_ada");
    expect(jobs[0].motion.name).toBe("Batch Card Ada");
    expect(jobs[0].motion.background).toBe("#0f172a");
    expect(jobs[0].motion.layers[1].text).toBe("Hello Ada");
    expect(jobs[0].motion.layers[1].style).toMatchObject({ color: "#38bdf8" });
    expect(jobs[0].motion.provenance).toMatchObject({
      dataRowId: "ada",
      dataRowKey: rows[0].key,
      dataRowHash: rows[0].hash
    });
  });

  it("filters motion data rows by normalized row ID while preserving source order", async () => {
    const rows = parseMotionDataRows({
      rows: [
        { id: "Ada", name: "Ada" },
        { id: "Grace Hopper", name: "Grace" },
        { id: "Katherine", name: "Katherine" }
      ]
    });

    const result = filterMotionDataRows(rows, ["katherine", "Grace Hopper", "grace_hopper"]);

    expect(result).toMatchObject({
      ok: true,
      requestedRowIds: ["katherine", "grace_hopper"]
    });
    if (result.ok) {
      expect(result.rows.map((row) => row.id)).toEqual(["grace_hopper", "katherine"]);
      expect(result.rows.map((row) => row.index)).toEqual([1, 2]);
    }
  });

  it("reports missing motion data row selections with normalized IDs", async () => {
    const rows = parseMotionDataRows({
      rows: [
        { id: "Ada", name: "Ada" }
      ]
    });

    const result = filterMotionDataRows(rows, ["missing row"]);

    expect(result).toEqual({
      ok: false,
      requestedRowIds: ["missing_row"],
      missingRowIds: ["missing_row"],
      message: "Motion data row IDs not found: missing_row."
    });
  });

  it("preserves exact row-token value types and nested row paths for variant expansion", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    const variantPackage = {
      ...pkg,
      motion: {
        ...pkg.motion,
        layers: [
          {
            ...pkg.motion.layers[0],
            width: "{{variant.panel.width}}",
            height: "{{variant.panel.height}}",
            style: { fill: "{{theme.background}}" }
          },
          {
            ...pkg.motion.layers[1],
            text: "{{title}} launch",
            source: "{{media.hero}}",
            style: { color: "{{theme.accent}}", width: "{{variant.titleWidth}}" }
          }
        ]
      }
    } as any;
    const rows = parseMotionDataRows({
      rows: [
        {
          id: "portrait",
          title: "Portrait",
          motion: {
            width: 1080,
            height: 1920,
            fps: 30,
            durationMs: 1500,
            background: "#101828"
          },
          variant: {
            panel: { width: 960, height: 640 },
            titleWidth: 820
          },
          theme: { background: "#101828", accent: "#f97316" },
          media: { hero: "assets/hero.png" }
        }
      ]
    });

    const [job] = expandMotionPackageRows(variantPackage, rows);

    expect(job.motion).toMatchObject({
      width: 1080,
      height: 1920,
      durationMs: 1500,
      fps: 30,
      background: "#101828",
      layers: [
        {
          width: 960,
          height: 640,
          style: { fill: "#101828" }
        },
        {
          text: "Portrait launch",
          source: "assets/hero.png",
          style: { color: "#f97316", width: 820 }
        }
      ]
    });
  });

  it("resolves locale string maps for JSON and CSV row variants", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    const localizedPackage = {
      ...pkg,
      motion: {
        ...pkg.motion,
        layers: [
          {
            ...pkg.motion.layers[0],
            style: { fill: "{{background}}" }
          },
          {
            ...pkg.motion.layers[1],
            text: "{{strings.greeting}}, {{name}}",
            style: { ...pkg.motion.layers[1].style, color: "{{accent}}" }
          },
          {
            id: "cta",
            type: "text",
            text: "{{strings.cta}}",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 64, y: 220, scale: 1 },
            style: { color: "{{accent}}", fontSize: 32 }
          }
        ]
      }
    } as any;
    const rows = parseMotionDataRows({
      rows: [
        {
          id: "spanish",
          locale: "es",
          name: "Ada",
          background: "#0f172a",
          accent: "#38bdf8",
          strings: {
            greeting: { en: "Hello", es: "Hola" },
            cta: { default: "Start", es: "Empezar" }
          }
        },
        {
          id: "latvian",
          locale: "lv",
          name: "Grace",
          background: "#111827",
          accent: "#22c55e",
          strings: {
            greeting: { en: "Hello", lv: "Sveiki" },
            cta: { default: "Start" }
          }
        }
      ]
    });

    const [spanish, latvian] = expandMotionPackageRows(localizedPackage, rows);
    const csvRows = parseMotionDataRowsCsv([
      "id,locale,name,background,accent,strings.greeting.en,strings.greeting.es,strings.cta.default,strings.cta.es",
      "csv,es,CSV,#0f172a,#38bdf8,Hello,Hola,Start,Empezar"
    ].join("\n"));
    const [csv] = expandMotionPackageRows(localizedPackage, csvRows);

    expect(spanish.motion.layers[1].text).toBe("Hola, Ada");
    expect(spanish.motion.layers[2].text).toBe("Empezar");
    expect(latvian.motion.layers[1].text).toBe("Sveiki, Grace");
    expect(latvian.motion.layers[2].text).toBe("Start");
    expect(csv.motion.layers[1].text).toBe("Hola, CSV");
    expect(csv.motion.layers[2].text).toBe("Empezar");
  });

  it("applies row replacement maps to text and media layers", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    const replaceablePackage = {
      ...pkg,
      manifest: {
        ...pkg.manifest,
        assets: ["assets/default-product.png"]
      },
      motion: {
        ...pkg.motion,
        layers: [
          {
            ...pkg.motion.layers[1],
            id: "headline",
            text: "Default headline"
          },
          {
            id: "product",
            type: "image",
            source: "assets/default-product.png",
            assetRef: "assets/default-product.png",
            src: "assets/default-product.png",
            startMs: 0,
            durationMs: 1000,
            width: 320,
            height: 180
          }
        ]
      }
    } as any;
    const rows = parseMotionDataRows({
      rows: [
        {
          id: "json",
          replace: {
            text: { headline: "JSON headline" },
            media: { product: "assets/json-product.png" }
          }
        }
      ]
    });
    const csvRows = parseMotionDataRowsCsv([
      "id,replace.text.headline,replace.media.product",
      "csv,CSV headline,assets/csv-product.png"
    ].join("\n"));

    const [jsonJob] = expandMotionPackageRows(replaceablePackage, rows);
    const [csvJob] = expandMotionPackageRows(replaceablePackage, csvRows);

    expect(jsonJob.motion.layers).toEqual([
      expect.objectContaining({ id: "headline", text: "JSON headline" }),
      expect.objectContaining({
        id: "product",
        source: "assets/json-product.png",
        assetRef: "assets/json-product.png",
        src: "assets/json-product.png"
      })
    ]);
    expect(jsonJob.manifest.assets).toEqual(["assets/default-product.png", "assets/json-product.png"]);
    expect(csvJob.motion.layers).toEqual([
      expect.objectContaining({ id: "headline", text: "CSV headline" }),
      expect.objectContaining({
        id: "product",
        source: "assets/csv-product.png",
        assetRef: "assets/csv-product.png",
        src: "assets/csv-product.png"
      })
    ]);
    expect(csvJob.manifest.assets).toEqual(["assets/default-product.png", "assets/csv-product.png"]);
  });

  it("loads CSV rows with quoted values and stable row keys", async () => {
    const rows = parseMotionDataRowsCsv([
      "id,name,background,accent",
      "ada,Ada Lovelace,#0f172a,#38bdf8",
      "grace,\"Grace, Hopper\",#111827,#22c55e"
    ].join("\n"));

    expect(rows.map((row) => ({ id: row.id, index: row.index, values: row.values }))).toEqual([
      {
        id: "ada",
        index: 0,
        values: { id: "ada", name: "Ada Lovelace", background: "#0f172a", accent: "#38bdf8" }
      },
      {
        id: "grace",
        index: 1,
        values: { id: "grace", name: "Grace, Hopper", background: "#111827", accent: "#22c55e" }
      }
    ]);
    expect(rows[0].key).toBe(`ada-${rows[0].hash.slice(0, 16)}`);
    expect(rows[1].key).toBe(`grace-${rows[1].hash.slice(0, 16)}`);
  });

  it("loads package-local CSV rows by ref", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    const rows = await loadPackageDataRows(pkg, "data/rows.csv");

    expect(rows.map((row) => row.id)).toEqual(["ada", "grace"]);
    expect(rows.map((row) => row.key)).toEqual(rows.map((row) => `${row.id}-${row.hash.slice(0, 16)}`));
  });

  it("loads external row files by content type", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-data-csv-"));
    tempDirs.push(root);
    const rowsPath = join(root, "rows.csv");
    await writeFile(rowsPath, "id,name\nada,Ada\n", "utf8");

    const rows = await loadDataRowsFile(rowsPath);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "ada", values: { id: "ada", name: "Ada" } });
  });

  it("rejects empty or malformed row data", () => {
    expect(() => parseMotionDataRows({ rows: [] })).toThrow(/at least one row/);
    expect(() => parseMotionDataRows({ rows: ["bad"] })).toThrow(/must be an object/);
    expect(() => parseMotionDataRowsCsv("id,name\n")).toThrow(/at least one row/);
    expect(() => parseMotionDataRowsCsv("id,\nada,Ada\n")).toThrow(/header 2 must be non-empty/);
  });

  it("rejects row IDs that collide after sanitization", () => {
    expect(() => parseMotionDataRows({ rows: [{ id: "a-b" }, { id: "a_b" }] })).toThrow(
      "Motion data row IDs must be unique after sanitization; duplicate id: a_b."
    );
  });

  it("rejects row refs that escape the package root", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    await expect(loadPackageDataRows(pkg, "../rows.json")).rejects.toThrow(/escapes package root/);
  });

  // ---------------------------------------------------------------------------------------------
  // Row layer patches (`row.layers`). These let a package ship a LITERAL motion.json that already
  // renders — no `{{tokens}}` — while rows still diverge per row.
  // `templates/shellx-product-pack/product-metric-card` is the reference user.
  // ---------------------------------------------------------------------------------------------

  /** Two-layer literal package used by the layer-patch tests. No tokens anywhere. */
  async function literalPackage(): Promise<Awaited<ReturnType<typeof loadMotionPackage>>> {
    const pkg = await loadMotionPackage(fixtureRoot);
    return {
      ...pkg,
      motion: {
        ...pkg.motion,
        layers: [
          {
            ...pkg.motion.layers[0],
            id: "panel",
            type: "shape",
            width: 640,
            height: 320,
            transform: { x: 40, y: 60 },
            style: { fill: "#0f172a", radius: 24 }
          },
          {
            ...pkg.motion.layers[1],
            id: "headline",
            type: "text",
            text: "Base headline",
            transform: { x: 80, y: 120 },
            style: { color: "#f8fafc", fontSize: 64 }
          }
        ]
      }
    } as unknown as Awaited<ReturnType<typeof loadMotionPackage>>;
  }

  it("deep-merges row layer patches onto a literal motion document", async () => {
    const pkg = await literalPackage();
    const rows = parseMotionDataRows({
      rows: [
        { id: "base" },
        {
          id: "square",
          motion: { width: 1080, height: 1080, background: "#050c16" },
          layers: {
            panel: { width: 936, transform: { x: 72 }, style: { fill: "#111f35" } },
            headline: { text: "Square headline", visible: false }
          }
        }
      ]
    });

    const [baseJob, squareJob] = expandMotionPackageRows(pkg, rows);

    // A row without patches leaves the shipped design untouched — that is what makes the literal
    // document both the default render AND row 0 of the batch.
    expect(baseJob.motion.layers).toEqual(pkg.motion.layers);
    expect(squareJob.motion).toMatchObject({ width: 1080, height: 1080, background: "#050c16" });
    expect(squareJob.motion.layers[0]).toMatchObject({
      id: "panel",
      width: 936,
      // `transform.y` and `style.radius` survive: objects merge key-by-key rather than replacing.
      transform: { x: 72, y: 60 },
      style: { fill: "#111f35", radius: 24 }
    });
    expect(squareJob.motion.layers[0].height).toBe(320);
    expect(squareJob.motion.layers[1]).toMatchObject({ id: "headline", text: "Square headline", visible: false });
    // Patching one row must not mutate the source package for the next one.
    expect(pkg.motion.layers[0]).toMatchObject({ width: 640, transform: { x: 40, y: 60 } });
  });

  it("replaces rather than merges arrays inside a row layer patch", async () => {
    const pkg = await literalPackage();
    pkg.motion.layers[1].keyframes = {
      opacity: [{ atMs: 0, value: 0 }, { atMs: 400, value: 1 }]
    };
    const rows = parseMotionDataRows({
      rows: [{ id: "late", layers: { headline: { keyframes: { opacity: [{ atMs: 900, value: 1 }] } } } }]
    });

    const [job] = expandMotionPackageRows(pkg, rows);

    expect(job.motion.layers[1].keyframes).toEqual({ opacity: [{ atMs: 900, value: 1 }] });
  });

  it("lets a row layer patch win over the coarser replace.text map for the same layer", async () => {
    const pkg = await literalPackage();
    const rows = parseMotionDataRows({
      rows: [{ id: "both", replace: { text: { headline: "From replace map" } }, layers: { headline: { text: "From layer patch" } } }]
    });

    const [job] = expandMotionPackageRows(pkg, rows);

    expect(job.motion.layers[1].text).toBe("From layer patch");
  });

  it("rejects row layer patches that cannot do what they claim", async () => {
    const pkg = await literalPackage();

    // A typo'd layer id would otherwise be a silent no-op: the document stays valid, the change the
    // author asked for never happens, and nothing fails. Same defect class as a token that expands
    // to an empty string.
    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({
      rows: [{ id: "typo", layers: { headlin: { text: "oops" } } }]
    }))).toThrow(/unknown layer id\(s\): headlin\. Known layer ids: panel, headline\./);

    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({
      rows: [{ id: "scalar", layers: { headline: "just a string" } }]
    }))).toThrow("Motion data row layer patch for headline must be an object.");

    // Renaming a layer would break every template binding and replace.* map that targets it.
    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({
      rows: [{ id: "rename", layers: { headline: { id: "headline-2" } } }]
    }))).toThrow("Motion data row layer patch for headline must not change the layer id.");

    // A patch cannot smuggle in a layer field the renderer would only reject mid-render.
    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({
      rows: [{ id: "bad-timing", layers: { headline: { startMs: "soon" } } }]
    }))).toThrow(/motion\.layers\.1\.startMs must be a finite number/);
  });
});
