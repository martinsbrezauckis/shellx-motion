export interface CanvasBridgeLayer {
  id: string;
  kind: "shape" | "text";
  shape?: string;
  text?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  font?: string;
  size?: number;
  color?: string;
  bold?: boolean;
  style?: Record<string, unknown>;
}

export interface CanvasBridgeSmokeDoc {
  width: number;
  height: number;
  layers: Array<{
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    opacity: number;
    ops: CanvasBridgeLayer[];
  }>;
  activeLayerId: string;
}

export function buildCanvasBridgeSmokeDoc(): CanvasBridgeSmokeDoc {
  return {
    width: 1280,
    height: 800,
    activeLayerId: "layer-main",
    layers: [
      {
        id: "layer-main",
        name: "Page",
        visible: true,
        locked: false,
        opacity: 1,
        ops: [
          {
            id: "rect-blue",
            kind: "shape",
            shape: "rectangle",
            x: 140,
            y: 150,
            w: 240,
            h: 150,
            style: { stroke: "#1e3a5f", fill: "#3b82f6", width: 2, opacity: 1 }
          },
          {
            id: "heading",
            kind: "text",
            x: 150,
            y: 560,
            text: "ShellX Canvas",
            font: "Georgia, serif",
            size: 64,
            color: "#111827",
            bold: true
          }
        ]
      }
    ]
  };
}
