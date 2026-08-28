# Agent-authored procedural scripts

Read the public [agent-authored procedural script cookbook](../../../docs/public/agent-authored-scripts.md)
before proposing or writing a package-local `web`, `html`, or `canvas` script.

It is a set of composable primitives, not a template catalog. First classify the requested effect:

1. **Works today as Motion data** — prefer typed layers, keyframes, particles (including bounded
   analytic radial/vortex deflection), gradients, glow, environments, constrained shaders, scene
   3D, compositing, ordered `points`, static bounded `effects.trail` on points/particles, bounded
   scalar `sin` / `cos`, browser-only single-subpath stroked `pathReveal`, and the separate strict
   hardware GPU points PNG preview (`preview --lane gpu`) when they express it.
   Native refuses `pathReveal`; it is not a fallback or a full-stroke approximation.
2. **Works today in package-local canvas** — only under operator-approved local authority, with an
   explicit seed, fixed timestep, entity/field/link caps, and browser-lane preview/render proof.
3. **Bake at author time** — generate deterministic coordinates or keyframes, then keep the package
   data-only.
4. **The GPU points route is preview-only.** It requires a verified hardware WebGPU adapter and
   admits one PNG still only when every active visible layer is static `points`; it has no CPU or
   browser fallback and is not a final-video lane, FFmpeg frame source, general WebGPU renderer,
   or broad GPU-performance claim. WSL is not hardware proof; obtain hardware evidence on a
   physical supported host.
5. **Planned engine work (not yet an API)** — do not imply that the current CPU `points`, strict
   GPU-points preview, scalar `sin` / `cos`, analytic particle deflection, or narrow browser
   `pathReveal` route provide general/dense GPU instancing, a general physics field, collision,
   persistent state, arbitrary-layer or persistent trails, multi-subpath reveal, or geometry
   generation/morph.

Script import is blocked in supported authoring/import workflows. Never fetch, import, execute, or
reproduce foreign source; the HTML snippet importer strips scripts. A directly opened package can
still contain executable web/html/canvas content and remains blocked unless the host resolves its
approved-agent-entry provenance. The only authoring route is the server-observed-agent, host-gated
`motion.package.script.author` command. The server establishes its opaque session fact only after
the first valid `2025-06-18` legacy MCP `initialize` on a persistent WebSocket; the fact is
connection-local and never serialized. Stateless legacy/modern MCP HTTP, malformed or duplicate
initialize, a first WebSocket `tools/call`, local location, and package claims alone are not trust
evidence. Its receipt attests admitted bytes, not semantic review or human authorship. Treat any
unresolved package as untrusted executable code even though the renderer fences network and
filesystem access. Do not hand-edit Motion JSON: use the typed package/timeline contracts, preview
representative timestamps, then inspect the receipt.
