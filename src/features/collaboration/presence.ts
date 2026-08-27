import type { PresenceEditor, WhiteboardNode } from "./types";

export const PRESENCE_WINDOW_MS = 30_000;

export type PresenceWriter = { id: string; name: string };

/** Stamp the last writer onto node content. Does not write to the database by itself. */
export function stampWriter(node: WhiteboardNode, writer: PresenceWriter, now = Date.now()): WhiteboardNode {
  const name = writer.name.trim();
  if (!name) return { ...node, updatedAt: now };
  return {
    ...node,
    updatedAt: now,
    content: {
      ...node.content,
      lastWriterId: writer.id,
      lastWriterName: name,
    },
  };
}

/**
 * Mobile-safe editors: names of people who recently wrote a node.
 * Does not emit cursors or 16ms presence rows.
 */
export function collectBoardEditors(
  nodes: WhiteboardNode[],
  current?: PresenceWriter | null,
  options?: { whiteboardId?: string; now?: number; windowMs?: number },
): PresenceEditor[] {
  const now = options?.now ?? Date.now();
  const windowMs = options?.windowMs ?? PRESENCE_WINDOW_MS;
  const byId = new Map<string, PresenceEditor>();
  for (const node of nodes) {
    if (options?.whiteboardId && node.whiteboardId !== options.whiteboardId) continue;
    const name = node.content.lastWriterName?.trim();
    const id = node.content.lastWriterId || name;
    if (!name || !id) continue;
    if (now - node.updatedAt > windowMs) continue;
    if (current && (id === current.id || name === current.name)) continue;
    if (!byId.has(id)) {
      byId.set(id, { userId: id, name, whiteboardId: node.whiteboardId });
    }
  }
  return [...byId.values()];
}

export function formatEditorLine(editor: PresenceEditor | undefined, boardTitle?: string): string {
  if (!editor?.name) return "";
  const title = editor.whiteboardTitle || boardTitle;
  return title ? `${editor.name}正在編輯「${title}」` : `${editor.name}正在編輯`;
}
