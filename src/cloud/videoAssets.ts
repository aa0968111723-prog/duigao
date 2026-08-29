import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_BUCKET } from "./assets";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";
import { CloudError } from "./errors";
import {
  classifyStorageUploadError,
  tusFingerprint,
  uploadResumableVideo,
  type TusUploadHandle,
  type TusUploadState,
} from "./tusUpload";

/**
 * Uploading the video itself.
 *
 * Preferred path is TUS resumable upload against Supabase Storage. A single
 * XMLHttpRequest POST remains as fallback when the resumable endpoint is
 * missing (older projects / tests). Both keep:
 *
 *   * the user's own access token, so Storage applies membership RLS,
 *   * the path `rooms/<room-id>/…`, which is what those policies read,
 *   * room-assets private — nothing here widens access.
 */

/** Where a version's video lives. Depth matters: [2] must stay the room id. */
export function videoPath(roomId: string, versionId: string, ext: string): string {
  return `rooms/${roomId}/videos/${versionId}/original.${ext}`;
}

/** Compatible / transcode proxy. Original `video_path` is never rewritten. */
export function optimizedVideoPath(roomId: string, versionId: string): string {
  return `rooms/${roomId}/videos/${versionId}/optimized.mp4`;
}

export type UploadHandle = {
  /** Resolves with the object path once Storage has the bytes. */
  done: Promise<string>;
  /** Stop an upload in flight; `done` rejects with a cancelled CloudError. */
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  retry: () => void;
  getState: () => TusUploadState | "preparing" | "uploading" | "completed" | "cancelled" | "failed";
};

export function isUploadCancelled(err: unknown): boolean {
  return err instanceof CloudError && err.message === CANCELLED;
}

const CANCELLED = "upload-cancelled";

export { classifyStorageUploadError, tusFingerprint };

export type UploadVideoOptions = {
  uploadUrl?: string;
  onUploadUrl?: (url: string) => void;
  preferTus?: boolean;
};

/**
 * PUT/PATCH the file to Storage with progress.
 *
 * Tries TUS resumable upload first (6MB chunks, pause/resume/retry). Falls
 * back to a single XHR POST when the resumable endpoint is unavailable so
 * existing rooms keep working.
 */
export function uploadVideoWithProgress(
  supabase: SupabaseClient,
  path: string,
  file: Blob,
  mime: string,
  onProgress: (fraction: number) => void,
  options: UploadVideoOptions = {},
): UploadHandle {
  let active: UploadHandle | null = null;
  let cancelled = false;

  const done = (async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new CloudError("尚未登入，無法上傳影片", "storage");
    if (cancelled) throw new CloudError(CANCELLED, "storage");
    const token = data.session.access_token;
    const preferTus = options.preferTus !== false;

    if (preferTus) {
      try {
        const tus = startTus(path, file, mime, token, onProgress, options.uploadUrl, options.onUploadUrl);
        active = tus;
        return await tus.done;
      } catch (err) {
        if (cancelled || isUploadCancelled(err)) throw err;
        if (!shouldFallbackToXhr(err)) throw err;
      }
    }

    if (cancelled) throw new CloudError(CANCELLED, "storage");
    const xhr = startXhr(path, file, mime, token, onProgress);
    active = xhr;
    return await xhr.done;
  })();

  return {
    done,
    cancel: () => {
      cancelled = true;
      active?.cancel();
    },
    pause: () => active?.pause(),
    resume: () => active?.resume(),
    retry: () => active?.retry(),
    getState: () => active?.getState() ?? "preparing",
  };
}

function startTus(
  path: string,
  file: Blob,
  mime: string,
  token: string,
  onProgress: (fraction: number) => void,
  uploadUrl?: string,
  onUploadUrl?: (url: string) => void,
): UploadHandle {
  const handle: TusUploadHandle = uploadResumableVideo({
    path,
    file,
    mime,
    accessToken: token,
    onProgress,
    uploadUrl,
    onUploadUrl,
  });
  return {
    done: handle.done,
    cancel: handle.cancel,
    pause: handle.pause,
    resume: handle.resume,
    retry: handle.retry,
    getState: handle.getState,
  };
}

function startXhr(
  path: string,
  file: Blob,
  mime: string,
  token: string,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  let cancelled = false;
  const done = new Promise<string>((resolve, reject) => {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = `${SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/${ASSET_BUCKET}/${encodedPath}`;
    xhr.open("POST", url, true);
    xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", SUPABASE_PUBLISHABLE_KEY);
    xhr.setRequestHeader("content-type", mime || "application/octet-stream");
    xhr.setRequestHeader("x-upsert", "true");
    xhr.setRequestHeader("cache-control", "max-age=3600");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(path);
        return;
      }
      reject(classifyStorageUploadError(xhr.status, xhr.responseText || ""));
    };
    xhr.onerror = () => reject(new CloudError("網路中斷，可從目前進度繼續", "storage"));
    xhr.onabort = () => reject(new CloudError(CANCELLED, "storage"));
    xhr.send(file);
  });
  return {
    done,
    cancel: () => {
      cancelled = true;
      try {
        xhr.abort();
      } catch {
        /* never started */
      }
    },
    pause: () => {
      if (!cancelled) xhr.abort();
    },
    resume: () => undefined,
    retry: () => undefined,
    getState: () => (cancelled ? "cancelled" : "uploading"),
  };
}

function shouldFallbackToXhr(err: unknown): boolean {
  if (!(err instanceof CloudError)) return false;
  return /無法開始可續傳|失敗（404）|失敗（405）/.test(err.message);
}

/**
 * A longer-lived signed URL than the app's default hour.
 *
 * A review session runs long, and a video that stops halfway with a 400 is a
 * bug the viewer cannot diagnose. Six hours plus the player's own re-sign on
 * error covers a realistic session; the URL is still short-lived, still
 * unguessable, and still only issued to a room member.
 */
export const VIDEO_URL_TTL = 6 * 60 * 60;

export async function signedVideoUrl(supabase: SupabaseClient, path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(ASSET_BUCKET).createSignedUrl(path, VIDEO_URL_TTL);
  if (error || !data) throw new CloudError(error?.message ?? "影片連結取得失敗", "storage");
  return data.signedUrl;
}
