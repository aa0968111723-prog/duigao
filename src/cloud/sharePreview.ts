import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_BUCKET } from "./assets";
import { CloudError } from "./errors";
import { SUPABASE_URL } from "./config";
import { renderShareThumbnail, type ThumbnailDecoration } from "./shareThumbnail";
import type { MediaType } from "../lib/types";
import { isCoverSource, sharePresentation, type CoverSource } from "../lib/sharePresentation";

/**
 * Open Graph share previews (PR #21, made media-aware and customisable in #30).
 *
 * A share link's secret lives in the URL fragment, which no browser sends to a
 * server — that is what keeps `#room=<uuid>&invite=<token>` safe, and also why
 * LINE / Facebook show a bare URL instead of a card. The fix is a separate,
 * room-free landing page that crawlers *can* read:
 *
 *   https://<project>.supabase.co/functions/v1/share-preview/<previewId>#room=…&invite=…
 *
 * This module owns the client half: turning the ORIGINAL poster (or a video's
 * poster frame, or a cover the host picked) into a small derived thumbnail,
 * publishing it to the dedicated public `share-previews` bucket, and keeping one
 * `share_previews` row per room in step.
 *
 * Three rules shape everything here:
 *   1. The thumbnail is rendered from the version image itself — never from a
 *      screenshot of the DOM, which would drag in pins, regions, proposal
 *      overlays, the video transport bar and toolbars. The card must look like
 *      a clean poster or a clean frame.
 *   2. A preview is an enhancement. Every function below is allowed to fail;
 *      the permanent `#room=…&invite=…` URL keeps working either way.
 *   3. Customising a card is NOT editing the room. Title, description and cover
 *      written here never touch `rooms.title`, the version image, the poster
 *      frame or the original upload — a room called 未命名影片 can be shared as
 *      「淡江招生短片｜第一剪」 and stay 未命名影片.
 */

export const PREVIEW_BUCKET = "share-previews";

export { renderShareThumbnail } from "./shareThumbnail";
export type { CoverSource } from "../lib/sharePresentation";

/**
 * The card's default sentence. Re-exported from the presentation model rather
 * than re-typed here: the ShareSheet, the LINE message and the Edge Function
 * all have to say the same thing, and two copies of a sentence is how they stop.
 */
export { IMAGE_SHARE_DESCRIPTION, VIDEO_SHARE_DESCRIPTION } from "../lib/sharePresentation";

export type SharePreview = {
  id: string;
  roomId: string;
  versionId: string;
  title: string;
  description: string;
  thumbnailPath: string | null;
  showThumbnail: boolean;
  /** What the card is about — decides its copy, its glyph and its fallback. */
  mediaType: MediaType;
  coverSource: CoverSource;
  /**
   * Whether the host typed this title/description themselves. Once they have,
   * a room rename must not silently overwrite what they wrote.
   */
  titleCustomized: boolean;
  descriptionCustomized: boolean;
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
  media_type?: string | null;
  cover_source?: string | null;
  title_customized?: boolean | null;
  description_customized?: boolean | null;
  updated_at: string;
};

const ROW_COLUMNS =
  "id, room_id, version_id, title, description, thumbnail_path, show_thumbnail, media_type, cover_source, title_customized, description_customized, updated_at";

function fromRow(row: PreviewRow): SharePreview {
  return {
    id: row.id,
    roomId: row.room_id,
    versionId: row.version_id,
    title: row.title,
    description: row.description,
    thumbnailPath: row.thumbnail_path,
    showThumbnail: row.show_thumbnail,
    mediaType: row.media_type === "video" ? "video" : "image",
    // Rows written before #30 carry no cover_source; `show_thumbnail` is the
    // only intent they recorded, so read it as the auto/none it always meant.
    coverSource: isCoverSource(row.cover_source) ? row.cover_source : row.show_thumbnail ? "auto" : "none",
    titleCustomized: row.title_customized === true,
    descriptionCustomized: row.description_customized === true,
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

/**
 * Fresh signed URL for a version's still image, straight from the row.
 *
 * For a video version that image is the captured poster frame — which is why
 * video rooms get real Open Graph cards without this module, the edge function
 * or the anonymous read surface changing at all. Also returns the running time
 * when there is one, so the card can wear it.
 */
async function versionImageUrl(
  supabase: SupabaseClient,
  roomId: string,
  versionId: string,
): Promise<{ url: string; durationSeconds: number | null } | null> {
  const { data, error } = await supabase
    .from("versions")
    .select("image_path, duration_seconds")
    .eq("room_id", roomId)
    .eq("id", versionId)
    .single();
  if (error) throw new CloudError(error.message, "preview");
  const duration = (data as { duration_seconds?: number | null } | null)?.duration_seconds;
  // A video version whose poster capture failed has no still image. That costs
  // a picture on the card, and nothing else: returning null here lets the
  // caller publish a text card instead of failing the whole preview, which
  // would leave the room with no card at all.
  if (!data?.image_path) return null;
  const signed = await supabase.storage.from(ASSET_BUCKET).createSignedUrl(data.image_path as string, 300);
  if (signed.error || !signed.data) throw new CloudError(signed.error?.message ?? "sign failed", "preview");
  return { url: signed.data.signedUrl, durationSeconds: typeof duration === "number" ? duration : null };
}

/** mm:ss for the card corner. Local to avoid a UI import in the cloud layer. */
function cardDuration(seconds: number | null): string | undefined {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The room's live preview, if it already has one. Members only (RLS). */
export async function loadRoomPreview(supabase: SupabaseClient, roomId: string): Promise<SharePreview | null> {
  const { data, error } = await supabase
    .from("share_previews")
    .select(ROW_COLUMNS)
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
  source: string | Blob,
  previousPath: string | null,
  decoration?: ThumbnailDecoration,
): Promise<string> {
  const { blob, mime } = await renderShareThumbnail(source, decoration);
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

/**
 * A change to what the CARD says, never to what the ROOM is.
 *
 * `undefined` leaves a field alone; `null` clears the customisation and hands
 * the field back to the room's own title / the media type's default sentence.
 */
export type SharePreviewPatch = {
  title?: string | null;
  description?: string | null;
  coverSource?: CoverSource;
  /** Bytes for a host-picked cover. Implies `coverSource: "custom"`. */
  customCover?: Blob;
};

export type EnsurePreviewInput = {
  roomId: string;
  versionId: string;
  /** The ROOM's title — only ever a default for the card. */
  title: string;
  /** "video" swaps the card's sentence and puts a play glyph on the frame. */
  mediaType?: MediaType;
  /** Legacy 顯示縮圖 toggle. Maps onto `auto` / `none`. */
  showThumbnail?: boolean;
  /** Re-render the thumbnail even when nothing about the source changed. */
  force?: boolean;
  /** Host edits to the card itself. */
  patch?: SharePreviewPatch;
};

/** What the card's title should be, given the room, the row and this edit. */
function resolveTitle(
  input: EnsurePreviewInput,
  existing: SharePreview | null,
  fallback: string,
): { title: string; customized: boolean } {
  const patch = input.patch;
  if (patch && "title" in patch) {
    const next = (patch.title ?? "").trim();
    // An explicit clear — or an edit the host emptied out — is 恢復預設, not a
    // blank card.
    if (patch.title === null || !next) return { title: fallback, customized: false };
    return { title: next, customized: true };
  }
  // A room rename should keep flowing into an untouched card, and must never
  // overwrite one the host wrote themselves.
  if (existing?.titleCustomized) return { title: existing.title, customized: true };
  return { title: fallback, customized: false };
}

function resolveDescription(
  input: EnsurePreviewInput,
  existing: SharePreview | null,
  fallback: string,
): { description: string; customized: boolean } {
  const patch = input.patch;
  if (patch && "description" in patch) {
    const next = (patch.description ?? "").trim();
    if (patch.description === null || !next) return { description: fallback, customized: false };
    return { description: next, customized: true };
  }
  if (existing?.descriptionCustomized) return { description: existing.description, customized: true };
  return { description: fallback, customized: false };
}

/**
 * Where the picture comes from after this call.
 *
 * The legacy boolean toggle still has to work — it is the one-tap control in
 * the sheet — so `true` means "show something again", which is the host's own
 * cover if they uploaded one and the room's own frame otherwise.
 */
function resolveCoverSource(input: EnsurePreviewInput, existing: SharePreview | null): CoverSource {
  const patch = input.patch;
  if (patch?.customCover) return "custom";
  if (patch?.coverSource) return patch.coverSource;
  if (typeof input.showThumbnail === "boolean") {
    if (!input.showThumbnail) return "none";
    return existing?.coverSource === "custom" ? "custom" : "auto";
  }
  return existing?.coverSource ?? "auto";
}

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
  const mediaType: MediaType = input.mediaType === "video" ? "video" : "image";
  const present = sharePresentation(mediaType, input.title);
  const previewId = existing?.id ?? crypto.randomUUID();

  const { title, customized: titleCustomized } = resolveTitle(input, existing, present.defaultTitle);
  const { description, customized: descriptionCustomized } = resolveDescription(
    input,
    existing,
    present.defaultDescription,
  );
  const coverSource = resolveCoverSource(input, existing);
  const showThumbnail = coverSource !== "none";

  const base = {
    title,
    description,
    show_thumbnail: showThumbnail,
    media_type: mediaType,
    cover_source: coverSource,
    title_customized: titleCustomized,
    description_customized: descriptionCustomized,
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

  if (coverSource === "none") {
    if (thumbnailPath) {
      await revokeThumbnail(supabase, thumbnailPath);
      thumbnailPath = null;
    }
  } else if (coverSource === "custom") {
    // Only new bytes cause a write. Without them the host's cover is left
    // exactly as it is — which is what makes it survive a version switch.
    if (input.patch?.customCover) {
      thumbnailPath = await writeThumbnail(supabase, previewId, input.patch.customCover, thumbnailPath);
    }
  } else {
    // auto: follow the room. Re-sharing the same version should not re-upload
    // an identical image; only a new version, a first share, a switch back from
    // a custom cover, or an explicit refresh re-renders.
    const stale =
      !thumbnailPath ||
      existing?.versionId !== input.versionId ||
      existing?.coverSource !== "auto" ||
      Boolean(input.force);
    if (stale) {
      const source = await versionImageUrl(supabase, input.roomId, input.versionId);
      if (source) {
        thumbnailPath = await writeThumbnail(
          supabase,
          previewId,
          source.url,
          thumbnailPath,
          mediaType === "video"
            ? { play: true, durationLabel: cardDuration(source.durationSeconds) }
            : undefined,
        );
      } else if (thumbnailPath) {
        // Nothing to render from any more: drop the stale image rather than keep
        // advertising a picture that no longer belongs to this version.
        await revokeThumbnail(supabase, thumbnailPath);
        thumbnailPath = null;
      }
    }
  }

  const { data, error } = await supabase
    .from("share_previews")
    .update({ thumbnail_path: thumbnailPath, version_id: input.versionId })
    .eq("id", previewId)
    .select(ROW_COLUMNS)
    .single();
  if (error || !data) throw new CloudError(error?.message ?? "preview update failed", "preview");
  return fromRow(data as PreviewRow);
}

/**
 * Revoke the current preview and mint a fresh id. Links already sitting in a
 * LINE thread keep working (they still carry room+invite) but fall back to the
 * generic card — the poster is no longer reachable through the old id.
 *
 * The host's customisation is NOT thrown away with the id: a rotate is about
 * defeating a stale social cache, not about undoing what they wrote.
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
  // A rotated custom cover has no bytes left to point at, so the new card falls
  // back to the room's own frame unless the host re-uploads.
  const carried: SharePreviewPatch = {
    ...(input.patch ?? {}),
    ...(existing?.titleCustomized && !(input.patch && "title" in input.patch) ? { title: existing.title } : {}),
    ...(existing?.descriptionCustomized && !(input.patch && "description" in input.patch)
      ? { description: existing.description }
      : {}),
  };
  return ensureRoomPreview(supabase, {
    ...input,
    patch: carried,
    showThumbnail: input.showThumbnail ?? existing?.showThumbnail ?? true,
    force: true,
  });
}
