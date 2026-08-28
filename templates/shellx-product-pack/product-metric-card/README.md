# ShellX Product Metric Card

Data-driven metric card for campaign and product reporting videos. A finished
1920x1080 report card out of the box, plus three shipped rows for batch runs:
two FHD 16:9 rows and one 1:1 square social row, each with its own copy,
palette, report data, and canvas size.

## Renders complete with no data file

`motion.json` is **literal** — every layer carries a real value, there are no
`{{token}}` placeholders anywhere in the package. Rendering the package on its
own produces the finished card:

```bash
pnpm --filter @shellx-motion/cli run cli -- render templates/shellx-product-pack/product-metric-card --lane ffmpeg --out .scratch/product-metric-card.mp4
```

`preview/poster.png` is a real browser-lane frame of that document at 5200 ms
(the `resolve` representative frame), so the catalog poster is what the template
actually renders.

## Batch rows are diffs on top of that document

`data/product-metrics.batch.json` does not re-supply the layout. Each row owns a
sealed, versioned `chartComposition` recipe (`shellx-motion/chart-composition@1`).
The ordinary batch expansion route validates that recipe and uses the existing Core
chart and typography compilers to materialize metric/report layers, data-width
keyframes, and auto-fit safe-area metadata. There is no package-id, workflow, or
canvas-size switch in Core: replace-layer ids, chart geometry, values, timing,
typography preset/safe-area mapping, and optional retained-chrome patches are row data.
The FHD rows compile a metric card plus compact table; the square row compiles a metric
card plus comparison chart.

Outer copy and the square-only canvas rearrangement remain ordinary `layers` patches
keyed by layer id:

```jsonc
{
  "id": "cut_generate_lane",
  "motion": { "width": 1920, "height": 1080, "background": "#050c16" },
  "chartComposition": {
    "schema": "shellx-motion/chart-composition@1",
    "replaceLayerIds": ["metric-panel", "metric-label", "metric-value"],
    "charts": [{
      "kind": "metric-card", "id": "campaign_metric", "startMs": 1080,
      "durationMs": 4920, "bounds": { "x": 120, "y": 520, "width": 830, "height": 340 },
      "theme": { "accent": "#f7b93f" },
      "metric": { "label": "Minutes to first cut", "value": 320, "unit": "min", "progress": 0.75 }
    }],
    "barAnimation": { "layerIdSuffixes": ["progress_fill"], "delayMs": 80, "staggerMs": 70, "durationMs": 640, "easing": "ease-out" },
    "typography": {
      "default": { "preset": "caption-reveal", "safeAreaId": "title" },
      "overrides": [{ "layerIdSuffix": "metric_value", "preset": "statistic-count-up", "safeAreaId": "title" }]
    },
    "chromePatches": [{ "layerId": "rail-title", "text": "Campaign delivery" }]
  },
  "layers": {
    "title": { "text": "Campaign cuts ship the same week" }
  }
}
```

The recipe reader rejects unknown keys, unknown compiler kinds/presets/suffixes,
invalid colors, out-of-range chart values, duplicate ids, malformed paths, and text
outside the selected preset's limits. Expansion then rejects chart bounds/timing that
leave the document, missing or conflicting replacement/chrome targets, generated-id
collisions, animation ranges that overrun a layer, and generated text that misses its
declared safe area. Within those limits, changing the row's chart data or layout is a
JSON-only change; another package can use the same recipe without a new Core hook.

Patches deep-merge (so `{ "transform": { "y": 424 } }` keeps the base `transform.x`),
scalars and arrays replace, and a patch that names an unknown layer id fails the
expansion loudly instead of doing nothing. `"visible": false` drops a layer for a
row — that is how the 1:1 square row removes the right-hand rail, the channel block
and the quarter timeline, which have no room on a square canvas.

The three rows:

| Row id | Canvas | Accent | Story |
| --- | --- | --- | --- |
| `motion_renderer_lane` | 1920x1080 | `#3fd8ff` | the shipped design, unmodified |
| `cut_generate_lane` | 1920x1080 | `#f7b93f` | campaign-launch copy, new chart geometry |
| `canvas_export_lane` | 1080x1080 | `#5fe0a4` | square social re-layout |

Run them all:

```bash
pnpm --filter @shellx-motion/cli run cli -- render-batch templates/shellx-product-pack/product-metric-card --out .scratch/template-quality/pkg_shellx_product_metric_card --min-unique-frames 2
```

`--rows` is optional: `manifest.data.rows` already points at the package-local
data file. Pass `--row-id canvas_export_lane` to render a single row.

## Numbers in the shipped rows are internally consistent

Every compiler-backed bar width is the percentage its own data value claims, against
its own track. The row data is the source of truth; generated geometry is not edited
by hand:

- `motion_renderer_lane` uses 66.7% metric progress and table shares of 62%, 48%, and 35%;
- `cut_generate_lane` uses 75% metric progress and shares of 71%, 58%, and 39%;
- `canvas_export_lane` uses 55.3% metric progress and compares 553 published posts with 467 in
  the prior period.

Keep that property when you change the sample data — a chart that contradicts its
own label is the fastest way to make a template look fake.

## Gates

`pnpm run template-pack:proof` fails this family if the rendered document leaves an
unresolved `{{token}}`, if any row fails to expand, if the poster is blank or the
wrong size, or if `quality/representative-frames.json` stops passing.

The template keeps host compatibility scoped to `shellx-motion` until Cut and
Design Studio editor panels provide matching connector receipts for this specific
catalog item.

## Typography

Text layers render in Inter. The package bundles the Latin-subset Inter weights
it actually selects (600 SemiBold, 700 Bold, 800 ExtraBold, 900 Black) under `assets/fonts/`, so the template
produces the same typeface and the same text metrics on a host with no Inter
installed. The declared stack is `Inter, Arial, Helvetica, sans-serif`: if a
host cannot load the bundled WOFF2 at all, it degrades to a sans face rather
than to the browser's default serif. The bundled files are SIL OFL 1.1 — see the
root `NOTICE` and `assets/fonts/LICENSE-Inter.txt`.

The shared chart-composition compiler applies the same declared stack to every
data-generated chart label, so a batch row cannot bypass this portability rule.
