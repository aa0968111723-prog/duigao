import type { SupabaseClient } from "@supabase/supabase-js";
import { acceptStorageUpload } from "./discussionWrite";
import { CloudError } from "./errors";

export const ASSET_BUCKET = "room-assets";
const SIGNED_TTL = 60 * 60; // 1 hour

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
};

export function extForMime(mime: string): string {
  return EXT[mime] ?? "png";
}

export async function dataUrlToBlob(dataUrl: string): Promise<{ blob: Blob; mime: string }> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return { blob, mime: blob.type || "image/png" };
}

/** Hash small upload metadata without ever sending the bytes to an AI model. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function versionPath(roomId: string, versionId: string, mime: string): string {
  return `rooms/${roomId}/versions/${versionId}/poster.${extForMime(mime)}`;
}

export function proposalAssetPath(roomId: string, proposalId: string, assetId: string, mime: string): string {
  return `rooms/${roomId}/proposals/${proposalId}/${assetId}.${extForMime(mime)}`;
}

// ---- 討論附件（PR-01b Universal Intake） ------------------------------------
// 附件是 add-only：路徑帶 messageId 便於對帳，assetId 每次上傳重發，
// 搭配 upsert:false，重試永遠不會覆蓋已落地的物件。

const ATTACHMENT_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/zip": "zip",
};

/** 附件副檔名：優先沿用原始檔名的副檔名，再退 MIME 對照，最後 bin。 */
export function attachmentExt(mime: string, fileName: string): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(fileName)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  return ATTACHMENT_EXT[mime] ?? "bin";
}

export function attachmentPath(roomId: string, messageId: string, assetId: string, ext: string): string {
  return `rooms/${roomId}/attachments/${messageId}/${assetId}.${ext}`;
}

/** 附件上傳：upsert:false — 物件一旦落地不可被同名覆蓋（原稿不可變）。 */
export async function uploadAttachment(supabase: SupabaseClient, path: string, blob: Blob, mime: string): Promise<string> {
  const { data, error } = await supabase.storage.from(ASSET_BUCKET).upload(path, blob, { contentType: mime, upsert: false });
  const accepted = acceptStorageUpload({ error, data, expectedPath: path });
  if (!accepted.ok) {
    const text =
      accepted.code === "SPA_HTML"
        ? "SPA_HTML"
        : accepted.code === "INCOMPLETE"
          ? "upload incomplete"
          : error?.message ?? "storage";
    throw new CloudError(text, "storage");
  }
  return path;
}

export async function uploadAsset(supabase: SupabaseClient, path: string, blob: Blob, mime: string): Promise<string> {
  const { error } = await supabase.storage.from(ASSET_BUCKET).upload(path, blob, { contentType: mime, upsert: true });
  if (error) throw new CloudError(error.message, "storage");
  return path;
}

export async function signedUrl(supabase: SupabaseClient, path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(ASSET_BUCKET).createSignedUrl(path, SIGNED_TTL);
  if (error || !data) throw new CloudError(error?.message ?? "signed url failed", "storage");
  return data.signedUrl;
}
