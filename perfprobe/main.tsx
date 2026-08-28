import { memo, useMemo, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { rendererFor } from "../src/features/whiteboard/registry";
import { paintOrder } from "../src/features/whiteboard/order";
import { visibleNodes } from "../src/features/whiteboard/canvas";
import type { WhiteboardNode } from "../src/features/collaboration/types";

const NodeView = memo(function NodeView({ node, selected, editing, canEdit, connectSource, onChangeText }: any) {
  const Renderer = rendererFor(node.nodeType);
  const style = { left: node.x, top: node.y, width: node.width, height: node.height };
  return (
    <div className="wb-node" style={style} data-node-type={node.nodeType}>
      <Renderer node={node} editing={editing} canEdit={canEdit} onChangeText={onChangeText} />
    </div>
  );
});

function makeNodes(count: number, pointsPer: number, withPressure: boolean): WhiteboardNode[] {
  const out: any[] = [];
  for (let n = 0; n < count; n += 1) {
    const points: [number, number][] = [];
    const pressures: number[] = [];
    for (let i = 0; i < pointsPer; i += 1) {
      points.push([8 + (i % 60) * 4, 8 + Math.floor(i / 60) * 12 + (i % 7)]);
      pressures.push(0.3 + ((i * 7) % 60) / 100);
    }
    out.push({
      id: `n${n}`, whiteboardId: "wb", roomId: "r", nodeType: "freehand",
      x: (n % 5) * 260, y: Math.floor(n / 5) * 180, width: 250, height: 170,
      content: { points, color: "#e8c27a", strokeWidth: 3, ...(withPressure ? { pressures } : {}) },
      createdBy: "l", createdAt: 0, updatedAt: 0, version: 1,
    });
  }
  return out;
}

function Board({ nodes }: { nodes: WhiteboardNode[] }) {
  const [camera, setCamera] = useState({ x: 24, y: 24, zoom: 1 });
  const viewport = useMemo(() => ({ width: 1024, height: 1366 }), []);
  const rendered = useMemo(
    () => paintOrder(visibleNodes(nodes.filter((n) => !(n as any).deletedAt), camera, viewport)),
    [nodes, camera, viewport],
  );
  (window as any).__pan = (dx: number) => flushSync(() => setCamera((c) => ({ ...c, x: c.x + dx })));
  return (
    <div style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
      {rendered.map((node) => (
        <NodeView key={node.id} node={node} selected={false} editing={false} canEdit
          connectSource={false}
          onChangeText={(text: string) => void [node, text]} />
      ))}
    </div>
  );
}

(window as any).__mount = (count: number, pointsPer: number, withPressure: boolean) => {
  const el = document.getElementById("root")!;
  el.innerHTML = "";
  const host = document.createElement("div");
  el.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<Board nodes={makeNodes(count, pointsPer, withPressure)} />));
  return document.querySelectorAll("line").length + "L/" + document.querySelectorAll("path").length + "P";
};
