# Browser and bounded GPU path reveals

`pathReveal` is the bounded, data-only line-drawing primitive for an existing `shape: "path"`
or `shape: "freeform"` layer. It reveals a contiguous window of one stroked SVG subpath. Use it
for line drawing, laser engraving, infinity/horizon accents, growing skeleton branches, and light
traces; it does not execute code, accept formulas, create geometry, or use a GPU simulation.

```json
{
  "type": "shape",
  "shape": "path",
  "x-path": "M 40 180 C 150 20 490 20 600 180",
  "x-path-viewBox": "0 0 640 360",
  "pathReveal": { "start": 0, "end": 0.7 },
  "style": {
    "fill": "transparent",
    "stroke": "#8dfcff",
    "strokeWidth": 6,
    "strokeLinecap": "round"
  }
}
```

`start` and `end` are independent finite fractions in `[0, 1]`. The renderer draws the interval
`[start, end]`; when `end <= start`, it draws no stroke. There is no wraparound or reverse mode,
so separately keyframed values may safely cross. Exactly one SVG subpath is required, as are a
validated path/viewBox, explicit non-transparent supported `style.stroke`, and finite positive
`style.strokeWidth` (legacy `style.width` is accepted as the width). Existing path layers without
`pathReveal` remain unchanged. The two numeric tracks use normal Motion keyframe interpolation;
each sampled scalar is clamped to `[0,1]` before the empty-window rule is applied.

Browser accepts the broader validated path contract. The GPU scene lane accepts a narrower fixed
triangle lowering: one simple nonzero contour using the supported `M`/`L`/`H`/`V`/`Q`/`C` command
subset, with no arcs, smooth commands, multiple contours, holes, even-odd fill, or
self-intersection. GPU path reveal also requires the exact butt cap and miter join. Those limits are
typed refusals, not a browser fallback. GPU support is source capability only until an admitted host
records fresh adapter evidence.

The existing rich setter owns scalar changes; there is no new command:

```bash
shellx-motion actions find "reveal line"
shellx-motion actions guide motion.timeline.layer.rich.set
shellx-motion debug layer-rich-set --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/revision --layer laser \
  --path pathReveal.end --value 0.82 --created-by local-agent
```

Animate either scalar with the existing `motion.timeline.keyframe.upsert` command and targets
`pathReveal.start` or `pathReveal.end`. Query `motion.capabilities.match` before choosing a lane:
Native preview and any lane without `shape.path.reveal` return a typed unsupported-feature refusal;
they do not silently render a full line. The GPU lane applies the narrower fixed-path limits above.

## Acceptance matrix

| Surface | Proof |
|---|---|
| Core contract | Schema/runtime validate one subpath, viewBox, visible positive stroke, and independent `[0,1]` scalars. |
| Timeline and rich editing | Both targets interpolate independently; `end <= start` remains an empty sampled window; the existing rich setter initializes defaults after owner validation. |
| Browser renderer | Real Chromium PNG-pixel tests cover full, partial, moving-window, empty, and curved path windows. |
| GPU scene compiler | Fixed Core geometry parsing/tessellation lowers the admitted subset to versioned triangles; empty windows emit no draw. |
| Capability/refusal | Browser and GPU advertise `shape.path.reveal` within their distinct contracts; native does not, so capability matching refuses before rendering. |
| Debug API, CLI, SDK, MCP | Existing `motion.timeline.layer.rich.set` and generic keyframe command expose the two documented paths; generated command metadata and action discovery include reveal wording. |
