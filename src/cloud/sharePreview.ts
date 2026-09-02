import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_BUCKET } from "./assets";
import { CloudError } from "./errors";
import { SUPABASE_URL } from "./config";
import { renderShareThumbnail, type ThumbnailDecoration } from "./shareThumbnail";
import type { MediaType } from "../lib/types";
import { isCoverSource, sharePresentation, type CoverSource } from "../lib/sharePresentation";

export const PREVIEW_BUCKET = "share-previews";

export { renderShareThumbnail } from "./shareThumbnail";
export type { CoverSource } from "../lib/sharePresentation";
export { IMAGE_SHARE_DESCRIPTION, VIDEO_SHARE_DESCRIPTION } from "../lib/sharePresentation";

export type SharePreview = {
  id: string;
  roomId: string;
  versionId: string;
  title: string;
  description: string;
  thumbnailPath: string | null;
  showThumbnail: boolean;
  mediaType: MediaType;
  coverSource: CoverSource;
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
    coverSource: isCoverSource(row.cover_source) ? row.cover_source : row.show_thumbnail ? "auto" : "none",
    titleCustomized: row.title_customized === true,
    descriptionCustomized: row.description_customized === true,
    updatedAt: row.updated_at,
  };
}

export function buildPreviewShareUrl(previewId: string, appUrl: string): string {
  const hashAt = appUrl.indexOf("#");
  const hash = hashAt >= 0 ? appUrl.slice(hashAt) : "";
  return `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/share-preview/${previewId}${hash}`;
}

export function previewThumbnailUrl(path: string, updatedAt: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const version = String(Date.parse(updatedAt) || 0);
  return `${SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/public/${PREVIEW_BUCKET}/${encoded}?v=${version}`;
}

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
  if (!data?.image_path) return null;
  const signed = await supabase.storage.from(ASSET_BUCKET).createSignedUrl(data.image_path as string, 300);
  if (signed.error || !signed.data) throw new CloudError(signed.error?.message ?? "sign failed", "preview");
  return { url: signed.data.signedUrl, durationSeconds: typeof duration === "number" ? duration : null };
}

function cardDuration(seconds: number | null): string | undefined {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

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

async function removeThumbnail(supabase: SupabaseClient, path: string | null | undefined): Promise<boolean> {
  if (!path) return true;
  const { error } = await supabase.storage.from(PREVIEW_BUCKET).remove([path]);
  return !error;
}

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
  if (previousPath && previousPath !== path) await removeThumbnail(supabase, previousPath);
  return path;
}

export type SharePreviewPatch = {
  title?: string | null;
  description?: string | null;
  coverSource?: CoverSource;
  customCover?: Blob;
};

export type EnsurePreviewInput = {
  roomId: string;
  versionId: string;
  title: string;
  mediaType?: MediaType;
  showThumbnail?: boolean;
  force?: boolean;
  patch?: SharePreviewPatch;
};

function resolveTitle(
  input: EnsurePreviewInput,
  existing: SharePreview | null,
  fallback: string,
): { title: string; customized: boolean } {
  const patch = input.patch;
  if (patch && "title" in patch) {
    const next = (patch.title ?? "").trim();
    if (patch.title === null || !next) return { title: fallback, customized: false };
    return { title: next, customized: true };
  }
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
    if (input.patch?.customCover) {
      thumbnailPath = await writeThumbnail(supabase, previewId, input.patch.customCover, thumbnailPath);
    }
  } else {
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

export async function rotateRoomPreview(
  supabase: SupabaseClient,
  input: EnsurePreviewInput,
): Promise<SharePreview> {
  const existing = await loadRoomPreview(supabase, input.roomId);
  if (existing) {
    await revokeThumbnail(supabase, existing.thumbnailPath);
    const { error } = await supabase
      .from("share_previews")
      .update({ enabled: false, thumbnail_path: null })
      .eq("id", existing.id);
    if (error) throw new CloudError(error.message, "preview");
  }
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
