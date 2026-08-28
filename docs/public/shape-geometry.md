# Shape geometry v1

Shape geometry v1 is the bounded, typed contour contract for new Motion shape
layers. It is deliberately not a general SVG or canvas-path escape hatch: Core
validates one exact record, lowers it to immutable triangles, and renderer lanes
consume those triangles rather than reinterpreting authored path text.

The record lives at `layer.geometry` and has the exact schema string
`"shellx-motion/shape-geometry@1"`. Every v1 record requires an exact
`viewBox: { x, y, width, height }`; unknown or missing keys are refused.
Coordinates must be finite, remain in the viewBox, and fit the signed
1,000,000 geometry-coordinate boundary (including each viewBox endpoint).
Arc/sector radius is positive and at most 1,000,000. A shape cannot combine
`geometry` with a legacy `shape`, `x-path`, `x-path-viewBox`, or
`x-path-fillRule` source.

## Records

All kinds use `{ schema, kind, viewBox, ...kindFields }`.

| `kind` | Exact kind fields | Topology |
| --- | --- | --- |
| `line` | `points`: exactly 2 `{ x, y }` points | Open |
| `polyline` | `points`: 2–128 ordered points | Open |
| `polygon` | `points`: 3–128 ordered points | Closed |
| `arc` | `center`, `radius`, `startAngleDeg`, `sweepAngleDeg` | Open |
| `sector` | Arc fields, plus optional `innerRadius` | Closed |
| `path` | `data`: one bounded path-data string | Closed |

Points may not be adjacent duplicates. Polygons and paths must be simple,
single nonzero-fill contours; self-intersection, holes, and even-odd fills are
refused. `path.data` is limited to 16 KiB and uses Motion's existing
one-closed-contour parser, not a second or browser-specific parser.

Arc and sector centres must be in the viewBox and their radii must fit inside
it. Radius is positive; sector `innerRadius`, when supplied, is finite,
non-negative, and strictly below radius. `startAngleDeg` is finite; zero degrees
points along +x, and a positive `sweepAngleDeg` moves clockwise in the y-down
coordinate system. Sweep is nonzero and has an absolute maximum of 360 degrees.
Core rounds generated arc vertices canonically, limits the curve to 64 segments,
and refuses a radius or sweep that collapses to adjacent duplicate vertices.

## Paint, stroke, and dashes

`line`, `polyline`, and `arc` are stroke-only. They require a non-empty
`style.stroke` and finite positive `style.strokeWidth`; authored fill, color, or
gradient is refused rather than silently ignored. Their supported stroke form is
the exact miter join with butt caps. `polygon`, `sector`, and `path` may use fill
and/or stroke. A stroked closed contour whose exact miter realization is not
admitted is refused, not approximated with disconnected segment quads.

V1 geometry may use numeric `style.strokeDasharray` with optional numeric
`style.strokeDashoffset`. A dash requires an admitted visible stroke. The array
contains 1–32 positive finite runs, each at most 4,096 rendered units; an odd
array repeats once using SVG dash semantics. Core canonicalizes numeric values,
requires a normalized pattern total no larger than 16,384, and bounds absolute
offset to 1,000,000. Offset without an array is refused.

Dash units are **rendered output-length units**: they are measured after the
viewBox-to-layer-box mapping and the existing transform scale, exactly as stroke
width is. This keeps the strict GPU and native lanes on the same observable
length convention, including non-uniform viewBox mapping. Core also bounds a
dashed contour to 256 emitted segments and 1,024 contour vertices; a static
scene that could exceed the 65,535 triangle-vertex frame ceiling, including
through scale, refuses before rendering.

## Typed Debug authoring

Create a layer with the complete v1 `geometry` record through
`motion.timeline.layer.create`. Inspect its authored record and canonical
contour through `motion.timeline.shape.geometry.inspect`.

The typed edit commands are:

- `motion.timeline.shape.geometry.replace` for a complete replacement;
- `motion.timeline.shape.geometry.point.update`, `.point.insert`,
  `.point.move`, and `.point.range.delete` for line, polyline, and polygon
  points;
- `motion.timeline.shape.geometry.arc.update` for arc or sector controls, and
  `motion.timeline.shape.geometry.path.replace` for path data;
- `motion.timeline.shape.geometry.dash.set` and
  `motion.timeline.shape.geometry.dash.remove` for the dash pair; and
- `motion.timeline.shape.geometry.legacy.migrate` to explicitly migrate an
  eligible legacy path rather than silently changing it.

These are typed copy-on-write package edits: the mutation validates the final
record, refuses semantic no-ops, and produces the ordinary edit receipt. See
the generated [Debug API command reference](DEBUG_API_COMMANDS.md) for argument
and receipt fields.

Geometry is not a topology-animation format. Changing kind, point count, path
data, or contour topology is an authored edit, not an interpolated keyframe.
Use ordinary supported layer transforms and paint animation where their renderer
capabilities allow it.

## Renderer support and evidence boundary

| Lane | V1 geometry behavior | Evidence represented here |
| --- | --- | --- |
| Direct Browser | Refuses `shape.geometry.v1` before rendering. It does not reinterpret the v1 record through a legacy path fallback. | Source-tested refusal behavior. |
| Strict GPU Browser | Accepts admitted v1 records after Core lowers them to bounded colored triangles. | Source-tested lowering and admission only. |
| Native | Consumes the same Core-compiled triangles; it does not parse v1 path data independently. | Source-tested lowering and raster behavior only. |

The strict GPU and native entries are not a claim that an installed build, a
native executable, or a hardware adapter has been run or accepted on this
machine. Runtime adapter admission, installed-product proof, and hardware/pixel
qualification require separate execution evidence.

## Compatibility

Existing `rect`, `ellipse`, `triangle`, and `star` shapes, plus legacy
`shape: "path" | "freeform"` with `x-path`, retain their existing compatibility
inputs and legacy path ABI. V1 does not widen or replace that legacy geometry
contract, and a document without new v1 geometry follows the existing path.

For broader lane behavior and runtime selection, see [Rendering lanes](rendering.md).
