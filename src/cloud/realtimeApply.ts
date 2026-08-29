/**
 * Realtime payload honesty + discussion row-patch (PR-GAP-05).
 *
 * Missed events still heal via loadRoom. This layer only decides whether a
 * single postgres_changes payload may touch local discussion state.
 * IndexedDB stays cache / draft / outbox — never the cloud source of truth.
 *
 * DELETE removes the row. Tombstone / unread (0031) is not on this tree.
 */

import { looksLikeSpaHtml } from "./apiResponse";
import type { DiscussionMessage } from "../features/collaboration/types";

export type RealtimeAccept =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; code: "SPA_HTML" | "INVALID" };

export type DiscussionRealtimeEvent =
  | { op: "upsert"; message: DiscussionMessage | null }
  | { op: "delete"; id?: string };

export function acceptRealtimePayload(payload: unknown): RealtimeAccept {
  if (looksLikeSpaHtml(payload)) return { ok: false, code: "SPA_HTML" };
  if (typeof payload === "string" && looksLikeSpaHtml(payload)) return { ok: false, code: "SPA_HTML" };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, code: "INVALID" };
  const row = payload as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return { ok: false, code: "INVALID" };
  return { ok: true, row };
}

export function applyDiscussionRealtime(
  messages: DiscussionMessage[],
  event: DiscussionRealtimeEvent,
): { messages: DiscussionMessage[]; applied: boolean } {
  if (event.op === "delete") {
    const id = event.id?.trim();
    if (!id) return { messages, applied: false };
    if (!messages.some((item) => item.id === id)) return { messages, applied: false };
    return { messages: messages.filter((item) => item.id !== id), applied: true };
  }
  const incoming = event.message;
  if (!incoming?.id) return { messages, applied: false };
  const existing = messages.find((item) => item.id === incoming.id);
  if (!existing) {
    return { messages: [...messages, incoming].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), applied: true };
  }
  if (incoming.updatedAt < existing.updatedAt) return { messages, applied: false };
  if (
    incoming.updatedAt === existing.updatedAt
    && incoming.body === existing.body
    && incoming.kind === existing.kind
  ) {
    return { messages, applied: false };
  }
  return {
    messages: messages.map((item) => (item.id === incoming.id ? incoming : item)),
    applied: true,
  };
}
