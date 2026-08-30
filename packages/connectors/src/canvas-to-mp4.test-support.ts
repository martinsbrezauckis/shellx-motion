export function shapeTextFrameSelection(): unknown {
  return {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_intro",
    project: { id: "canvas_motion_export", name: "Motion Export" },
    brand: { tokens: { color: { accent: "#2563eb", ink: "#101828" } } },
    frames: [{
      id: "frame_intro",
      name: "Intro",
      durationMs: 1000,
      fps: 2,
      width: 640,
      height: 360,
      background: "#f8fafc",
      layers: [
        {
          id: "panel",
          kind: "shape",
          shape: "rectangle",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 48, y: 44, width: 250, height: 150, opacity: 1 },
          style: { fill: "#2563eb" },
          ...revealMotion()
        },
        {
          id: "title",
          kind: "text",
          text: "Canvas export",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 64, y: 240, width: 420, height: 60, opacity: 1 },
          style: { fontSize: 36, color: "#101828" },
          ...revealMotion()
        }
      ]
    }],
    imageEditorOutputs: []
  };
}

function revealMotion(): Record<string, unknown> {
  return {
    transitions: {
      in: { type: "slide", direction: "down", distance: 24, durationMs: 320, easing: "ease-out" },
      out: { type: "fade", durationMs: 260, easing: "ease-in" }
    },
    keyframes: {
      opacity: [
        { atMs: 0, value: 0, easing: "ease-out" },
        { atMs: 320, value: 1 },
        { atMs: 740, value: 1, easing: "ease-in" },
        { atMs: 1000, value: 0 }
      ]
    }
  };
}
