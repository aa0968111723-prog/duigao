import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_BUCKET } from "./assets";
import { CloudError } from "./errors";
import { SUPABASE_URL } from "./config";
import { renderShareThumbnail } from "./shareThumbnail";

/**
 * Open Graph share previews (PR #21).
 *
 * A share link's secret lives in the URL fragment, which no browser sends to a
 * server — that is what keeps `#room=<uuid>&invite=<token>` safe, and also why
 * LINE / Facebook show a bare URL instead of a card. The fix is a separate,
 * room-free landing page that crawlers *can* read:
 *
 *   https://<project>.supabase.co/functions/v1/share-preview/<previewId>#room=…&invite=…
 *
 * This module owns the client half: turning the ORIGINAL poster into a small
 * derived thumbnail, publishing it to the dedicated public `share-previews`
 * bucket, and keeping one `share_previews` row per room in step.
 *
 * Two rules shape everything here:
 *   1. The thumbnail is rendered from the version image itself — never from a
 *      screenshot of the DOM, which would drag in pins, regions, proposal
 *      overlays and toolbars. The card must look like a clean poster.
 *   2. A preview is an enhancement. Every function below is allowed to fail;
 *      callers fall back to the plain permanent `#room=…&invite=…` URL and
 *      sharing carries on.
 */

export const PREVIEW_BUCKET = "share-previews";

export { renderShareThumbnail } from "./shareThumbnail";

export const DEFAULT_PREVIEW_DESCRIPTION =
  "幫我看一下這張文宣，點需要調整的位置留一句話就可以，不用改原稿。";

export type SharePreview = {
  id: string;
  roomId: string;
  versionId: string;
  title: string;
  description: string;
  thumbnailPath: string | null;
  showThumbnail: boolean;
  updatedAt: string;
};

type PreviewRow = {
  id: string;
  room_id: string;
  version_id: string;
  title: string;
  description: string;
  thumbnail_path: string | null;
  show_thumbnail: boolean;
  updated_at: string;
};

function fromRow(row: PreviewRow): SharePreview {
  return {
    id: row.id,
    roomId: row.room_id,
    versionId: row.version_id,
    title: row.title,
    description: row.description,
    thumbnailPath: row.thumbnail_path,
    showThumbnail: row.show_thumbnail,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ URLs -- */

/**
 * The shared URL: a preview landing page carrying the ORIGINAL fragment,
 * byte for byte. The fragment is never parsed, re-encoded or rebuilt here —
 * whatever `buildInviteUrl` produced is what travels.
 */
export function buildPreviewShareUrl(previewId: string, appUrl: string): string {
  const hashAt = appUrl.indexOf("#");
  const hash = hashAt >= 0 ? appUrl.slice(hashAt) : "";
  return `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/share-preview/${previewId}${hash}`;
}

/** Public URL of a derived thumbnail, versioned so social caches refresh. */
export function previewThumbnailUrl(path: string, updatedAt: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const version = String(Date.parse(updatedAt) || 0);
  return `${SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/public/${PREVIEW_BUCKET}/${encoded}?v=${version}`;
}

/* ------------------------------------------------------------ repository -- */

/** Fresh signed URL for a version's ORIGINAL image, straight from the row. */
async function versionImageUrl(supabase: SupabaseClient, roomId: string, versionId: string): Promise<string> {
  const { data, error } = await supabase
    .from("versions")
    .select("image_path")
    .eq("room_id", roomId)
    .eq("id", versionId)
    .single();
  if (error || !data?.image_path) throw new CloudError(error?.message ?? "version not found", "preview");
  const signed = await supabase.storage.from(ASSET_BUCKET).createSignedUrl(data.image_path as string, 300);
  if (signed.error || !signed.data) throw new CloudError(signed.error?.message ?? "sign failed", "preview");
  return signed.data.signedUrl;
}

/** The room's live preview, if it already has one. Members only (RLS). */
export async function loadRoomPreview(supabase: SupabaseClient, roomId: string): Promise<SharePreview | null> {
  const { data, error } = await supabase
    .from("share_previews")
    .select("id, room_id, version_id, title, description, thumbnail_path, show_thumbnail, updated_at")
    .eq("room_id", roomId)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw new CloudError(error.message, "preview");
  return data ? fromRow(data as PreviewRow) : null;
}

/**
 * Revoking a preview means the bytes go too: the bucket is public, so
 * `enabled = false` alone would leave a still-fetchable image behind.
 *
 * storage-js resolves with `{ data, error }` and never throws, so the result
 * has to be inspected — otherwise a failed delete looks exactly like a
 * successful one, and the caller goes on to forget the path.
 *
 * @returns true when the object is gone (or there was nothing to delete).
 */
async function removeThumbnail(supabase: SupabaseClient, path: string | null | undefined): Promise<boolean> {
  if (!path) return true;
  const { error } = await supabase.storage.from(PREVIEW_BUCKET).remove([path]);
  return !error;
}

/** Deleting is the privacy control, so a failure has to surface, not pass. */
async function revokeThumbnail(supabase: SupabaseClient, path: string | null | undefined): Promise<void> {
  if (!(await removeThumbnail(supabase, path))) {
    throw new CloudError("縮圖刪除失敗，預覽尚未撤銷", "preview");
  }
}

async function writeThumbnail(
  supabase: SupabaseClient,
  previewId: string,
  imageUrl: string,
  previousPath: string | null,
): Promise<string> {
  const { blob, mime } = await renderShareThumbnail(imageUrl);
  const ext = mime === "image/webp" ? "webp" : "jpg";
  const path = `${previewId}/cover.${ext}`;
  const { error } = await supabase.storage
    .from(PREVIEW_BUCKET)
    .upload(path, blob, { contentType: mime, upsert: true, cacheControl: "3600" });
  if (error) throw new CloudError(error.message, "preview");
  // Best-effort: the new object already landed, so failing here would throw
  // away a good upload to complain about a leftover the row no longer names.
  if (previousPath && previousPath !== path) await removeThumbnail(supabase, previousPath);
  return path;
}

export type EnsurePreviewInput = {
  roomId: string;
  versionId: string;
  title: string;
  /** Explicit override; otherwise an existing row's choice wins, else on. */
  showThumbnail?: boolean;
  /** Re-render the thumbnail even when nothing about the source changed. */
  force?: boolean;
};

/**
 * Create or refresh the room's share preview and return it.
 *
 * The row is written BEFORE the thumbnail: the storage policy authorises an
 * upload by looking the preview up, so the row has to exist first. It also
 * means a failed upload degrades to a text-only card instead of a broken one.
 */
export async function ensureRoomPreview(
  supabase: SupabaseClient,
  input: EnsurePreviewInput,
): Promise<SharePreview> {
  const existing = await loadRoomPreview(supabase, input.roomId);
  const showThumbnail = input.showThumbnail ?? existing?.showThumbnail ?? true;
  const title = input.title.trim() || "文宣討論區";
  const previewId = existing?.id ?? crypto.randomUUID();

  const base = {
    title,
    description: DEFAULT_PREVIEW_DESCRIPTION,
    show_thumbnail: showThumbnail,
  };

  if (existing) {
    // `version_id` is deliberately NOT written here. It moves only once the new
    // image is actually in the bucket (see the final update below): committing
    // it first would make a failed render look like a fresh card forever —
    // `stale` would read false on every retry while the old poster kept being
    // served. A fresh row has no thumbnail yet, so the insert can carry it.
    const { error } = await supabase.from("share_previews").update(base).eq("id", previewId);
    if (error) throw new CloudError(error.message, "preview");
  } else {
    const { error } = await supabase
      .from("share_previews")
      .insert({ id: previewId, room_id: input.roomId, version_id: input.versionId, enabled: true, ...base });
    if (error) throw new CloudError(error.message, "preview");
  }

  let thumbnailPath: string | null = existing?.thumbnailPath ?? null;
  // Re-sharing the same version should not re-upload an identical image; only
  // a new version, a first share, or an explicit refresh re-renders.
  const stale = !thumbnailPath || existing?.versionId !== input.versionId || Boolean(input.force);
  if (showThumbnail && stale) {
    const imageUrl = await versionImageUrl(supabase, input.roomId, input.versionId);
    thumbnailPath = await writeThumbnail(supabase, previewId, imageUrl, thumbnailPath);
  } else if (!showThumbnail && thumbnailPath) {
    await revokeThumbnail(supabase, thumbnailPath);
    thumbnailPath = null;
  }

  const { data, error } = await supabase
    .from("share_previews")
    .update({ thumbnail_path: thumbnailPath, version_id: input.versionId })
    .eq("id", previewId)
    .select("id, room_id, version_id, title, description, thumbnail_path, show_thumbnail, updated_at")
    .single();
  if (error || !data) throw new CloudError(error?.message ?? "preview update failed", "preview");
  return fromRow(data as PreviewRow);
}

/**
 * Revoke the current preview and mint a fresh id. Links already sitting in a
 * LINE thread keep working (they still carry room+invite) but fall back to the
 * generic card — the poster is no longer reachable through the old id.
 */
export async function rotateRoomPreview(
  supabase: SupabaseClient,
  input: EnsurePreviewInput,
): Promise<SharePreview> {
  const existing = await loadRoomPreview(supabase, input.roomId);
  if (existing) {
    // Delete first and refuse to continue if it fails: flipping `enabled`
    // while the object survives would revoke nothing at all.
    await revokeThumbnail(supabase, existing.thumbnailPath);
    const { error } = await supabase
      .from("share_previews")
      .update({ enabled: false, thumbnail_path: null })
      .eq("id", existing.id);
    if (error) throw new CloudError(error.message, "preview");
  }
  return ensureRoomPreview(supabase, {
    ...input,
    showThumbnail: input.showThumbnail ?? existing?.showThumbnail ?? true,
    force: true,
  });
}
