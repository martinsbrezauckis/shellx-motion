# Bounded analytic particle fields

Use the existing typed `layer-create` path for a seeded `particles` layer; this adds no action,
MCP method, import, or script surface. `emitter.field` accepts one to three ordered radial/vortex
sources with `centerX`/`centerY` normalized to 0…1, `strength` in -1…1, and `softening` in
0.01…1. Browser and native use the same Core CPU evaluator. It resolves the seeded ballistic
sample first, then applies a lifetime-progress-weighted visual deflection. It is analytic kinematic
deflection, not collision/velocity physics, noise, trails, arbitrary formulas/callbacks, or GPU.

```bash
shellx-motion debug layer-create \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/with-particles --created-by local-agent \
  --layer-json '{
    "id":"field-debris","type":"particles","startMs":0,"durationMs":1600,
    "transform":{"x":0,"y":0,"width":1920,"height":1080},
    "emitter":{"seed":20260809,"count":96,"lifetimeMs":1200,"minSpeed":180,"maxSpeed":320,
      "minSize":2,"maxSize":4,"color":"#8be9fd","field":{"schema":"shellx-motion/particle-field@1","sources":[
        {"kind":"radial","centerX":0.5,"centerY":0.5,"strength":0.55,"softening":0.2},
        {"kind":"vortex","centerX":0.5,"centerY":0.5,"strength":0.2,"softening":0.35}
      ]}}
  }'
```

The scalar rich controls retain the generic path: `emitter.field.sources.0.centerX`,
`centerY`, `strength`, or `softening`. For example:

```bash
shellx-motion debug layer-rich-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/with-particles --out /path/to/stronger-field \
  --layer field-debris --path emitter.field.sources.0.strength --value 0.72
```

Unknown source fields, fourth sources, a different schema, and out-of-range values refuse during
validation. Preview a start, active, and end timestamp and read the lane receipt; a native frame is
CPU-raster evidence, not a cross-engine pixel-equivalence or GPU claim.
