import type { WhiteboardNode } from "../collaboration/types";

export type Camera = { x: number; y: number; zoom: number };

export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 2.4;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(camera: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - camera.x) / camera.zoom, y: (sy - camera.y) / camera.zoom };
}

export function worldToScreen(camera: Camera, x: number, y: number): { x: number; y: number } {
  return { x: x * camera.zoom + camera.x, y: y * camera.zoom + camera.y };
}

export function visibleNodes(
  nodes: WhiteboardNode[],
  camera: Camera,
  viewport: { width: number; height: number },
  pad = 80,
): WhiteboardNode[] {
  const left = -camera.x / camera.zoom - pad;
  const top = -camera.y / camera.zoom - pad;
  const right = left + viewport.width / camera.zoom + pad * 2;
  const bottom = top + viewport.height / camera.zoom + pad * 2;
  return nodes.filter((node) =>
    node.x + node.width >= left &&
    node.x <= right &&
    node.y + node.height >= top &&
    node.y <= bottom,
  );
}

export function focusCamera(node: WhiteboardNode, viewport: { width: number; height: number }, zoom = 1.15): Camera {
  const nextZoom = clampZoom(zoom);
  return {
    zoom: nextZoom,
    x: viewport.width / 2 - (node.x + node.width / 2) * nextZoom,
    y: viewport.height / 2 - (node.y + node.height / 2) * nextZoom,
  };
}

export function zoomAt(camera: Camera, sx: number, sy: number, nextZoom: number): Camera {
  const zoom = clampZoom(nextZoom);
  const world = screenToWorld(camera, sx, sy);
  return {
    zoom,
    x: sx - world.x * zoom,
    y: sy - world.y * zoom,
  };
}

export function nodeHit(nodes: WhiteboardNode[], worldX: number, worldY: number): WhiteboardNode | undefined {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (worldX >= node.x && worldX <= node.x + node.width && worldY >= node.y && worldY <= node.y + node.height) {
      return node;
    }
  }
  return undefined;
}

export function marqueeHits(nodes: WhiteboardNode[], a: { x: number; y: number }, b: { x: number; y: number }): string[] {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);
  return nodes
    .filter((node) => node.x < right && node.x + node.width > left && node.y < bottom && node.y + node.height > top)
    .map((node) => node.id);
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const DRAG_PERSIST_MS = 120;
export const BROADCAST_THROTTLE_MS = 80;
export const LONG_PRESS_MS = 420;
