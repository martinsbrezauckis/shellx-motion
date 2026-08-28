export function scriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1", id: "launch-demo", name: "Launch Demo", sourceApp: "shellx-cut", workflow: "generate", width: 1280, height: 720, fps: 24,
    frames: [
      { id: "hook", title: "Hook", body: "Show the new workflow", durationMs: 1000, background: "#0f172a", accent: "#38bdf8" },
      { id: "cta", title: "Cut edits it", caption: "Rendered by Motion", durationMs: 1500, background: "#111827", accent: "#22c55e" }
    ]
  };
}

export function storyboardGraphCollisionScriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1", id: "collision-demo", name: "Collision Demo", sourceApp: "shellx-motion", workflow: "source-to-scripted-video", review: { status: "needs-review", required: true }, width: 1280, height: 720, fps: 30,
    frames: [
      { id: "first", title: "First", body: "First colliding frame.", durationMs: 1000, assetRefs: ["assets/foo_bar.png"], sourceRefs: [{ type: "article", title: "First", url: "https://example.com/articles/collision#first" }], template: { id: "tpl_hero", engine: "native" }, engine: { id: "engine_html" } },
      { id: "second", title: "Second", body: "Second colliding frame.", durationMs: 1000, assetRefs: ["assets/foo-bar.png"], sourceRefs: [{ type: "article", title: "Second", url: "https://example.com/articles/collision#second" }], template: { id: "tpl-hero", engine: "native" }, engine: { id: "engine-html" } }
    ]
  };
}
