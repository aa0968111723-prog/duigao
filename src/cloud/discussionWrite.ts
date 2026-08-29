/**
 * Discussion send / attachment upload honesty (PR-GAP-02, stacked on #95).
 *
 * SPA catch-all and empty `{ok:true}` must never become 送出成功 or 上傳完成.
 * The same client mutation id (message.id) is idempotent: a duplicate-key
 * retry is success, a second distinct id is a second message.
 */

import { isDuplicateKey } from "./errors";
import { looksLikeSpaHtml } from "./apiResponse";

export { looksLikeSpaHtml };

export type DiscussionInsertAccept =
  | { ok: true; reason: "inserted" | "duplicate" }
  | { ok: false; code: "SPA_HTML" | "FAILED" };

export type StorageUploadAccept =
  | { ok: true }
  | { ok: false; code: "SPA_HTML" | "FAILED" | "INCOMPLETE" };

export type DiscussionUploadPhase = "idle" | "validating" | "preview" | "uploading" | "complete" | "failed";

export type DiscussionAttachUpload = {
  phase: "preview" | "uploading" | "failed";
  name: string;
  previewUrl?: string;
  percent: number;
  message: string;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) return String((error as { message: unknown }).message);
  if (typeof error === "string") return error;
  return "";
}

/** Insert result: HTML / missing API is failure. Duplicate key of the same id is success. */
export function acceptDiscussionInsert(input: {
  error: unknown;
  data?: unknown;
  contentType?: string | null;
}): DiscussionInsertAccept {
  if (looksLikeSpaHtml(input.data, input.contentType) || looksLikeSpaHtml(errorText(input.error), input.contentType)) {
    return { ok: false, code: "SPA_HTML" };
  }
  if (input.error) {
    if (isDuplicateKey(input.error)) return { ok: true, reason: "duplicate" };
    return { ok: false, code: "FAILED" };
  }
  return { ok: true, reason: "inserted" };
}

/**
 * Storage upload: no error is not enough. SPA HTML, null data, or a path that
 * does not match the object we asked to write is incomplete — never complete.
 */
export function acceptStorageUpload(input: {
  error: unknown;
  data?: { path?: string; fullPath?: string; Key?: string } | string | null;
  expectedPath: string;
  contentType?: string | null;
}): StorageUploadAccept {
  if (looksLikeSpaHtml(input.data, input.contentType) || looksLikeSpaHtml(errorText(input.error), input.contentType)) {
    return { ok: false, code: "SPA_HTML" };
  }
  if (input.error) return { ok: false, code: "FAILED" };
  if (input.data == null || typeof input.data !== "object") return { ok: false, code: "INCOMPLETE" };
  const path = typeof input.data.path === "string" ? input.data.path : "";
  const fullPath = typeof input.data.fullPath === "string" ? input.data.fullPath : "";
  const key = typeof input.data.Key === "string" ? input.data.Key : "";
  if (path === input.expectedPath || fullPath.endsWith(input.expectedPath) || key.endsWith(input.expectedPath)) return { ok: true };
  return { ok: false, code: "INCOMPLETE" };
}

/** Progress may approach 99 while uploading; 100 only after acceptStorageUpload.ok. */
export function honestUploadPercent(phase: DiscussionUploadPhase, reported: number): number {
  if (phase === "complete") return 100;
  if (phase === "failed" || phase === "idle") return 0;
  if (phase === "uploading" || phase === "preview" || phase === "validating") {
    return Math.max(0, Math.min(99, Math.floor(reported)));
  }
  return 0;
}

export function uploadIsComplete(phase: DiscussionUploadPhase): boolean {
  return phase === "complete";
}

/**
 * Same client mutation id lands once. A duplicate-key retry does not grow the
 * server id set. A failed / SPA result does not land.
 */
export function applyIdempotentInsert(
  landedIds: ReadonlySet<string>,
  messageId: string,
  result: DiscussionInsertAccept,
): { landedIds: Set<string>; created: boolean } {
  const next = new Set(landedIds);
  if (!result.ok) return { landedIds: next, created: false };
  if (next.has(messageId)) return { landedIds: next, created: false };
  next.add(messageId);
  return { landedIds: next, created: true };
}
