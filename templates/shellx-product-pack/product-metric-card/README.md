# ShellX Product Metric Card

Data-driven metric card for campaign and product reporting videos. A finished
1920x1080 report card out of the box, plus three shipped rows for batch runs:
two FHD 16:9 rows and one 1:1 square social row, each with its own copy,
palette, chart geometry, and canvas size.

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

`data/product-metrics.batch.json` does not re-supply the layout. Each row carries
only what differs from the shipped design, under a `layers` map keyed by layer id:

```jsonc
{
  "id": "cut_generate_lane",
  "motion": { "width": 1920, "height": 1080, "background": "#050c16" },
  "layers": {
    "metric-value": { "text": "3.2" },
    "progress-fill": { "width": 558, "fill": "#f7b93f" }
  }
}
```

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

Every bar width is the percentage its own label claims, against its own track:

- `progress-fill` 496 of a 744 track = 66.7% = the `1,200 of 1,800` it prints;
- `channel-1-fill` 434 of 700 = 62%, `channel-2-fill` 336 = 48%, `channel-3-fill` 245 = 35%;
- `timeline-progress` 485 of 700 = 69.2% = `Week 9 of 13`.

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
