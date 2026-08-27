import type { SupabaseClient } from "@supabase/supabase-js";
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
