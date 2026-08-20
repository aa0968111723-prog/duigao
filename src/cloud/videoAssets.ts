import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_BUCKET } from "./assets";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";
import { CloudError } from "./errors";

/**
 * Uploading the video itself.
 *
 * Everything else in this app can be handed to `storage.from().upload()` and
 * forgotten about, because a poster is small. A cut is not: a 90MB upload over
 * hotel wifi is a minute of a user staring at a spinner wondering whether the
 * app has died. supabase-js gives no progress events, so this module talks to
 * the same Storage REST endpoint directly over XMLHttpRequest — the one API
 * that still reports upload progress — and keeps every security property:
 *
 *   * the request carries the user's own access token, so Storage applies the
 *     exact same membership RLS policy as any other upload,
 *   * the path stays `rooms/<room-id>/…`, which is what those policies read,
 *   * nothing here can widen access: it is the same bucket, still private.
 */

/** Where a version's video lives. Depth matters: [2] must stay the room id. */
export function videoPath(roomId: string, versionId: string, ext: string): string {
  return `rooms/${roomId}/videos/${versionId}/original.${ext}`;
}

export type UploadHandle = {
  /** Resolves with the object path once Storage has the bytes. */
  done: Promise<string>;
  /** Stop an upload in flight; `done` rejects with a cancelled CloudError. */
  cancel: () => void;
};

export function isUploadCancelled(err: unknown): boolean {
  return err instanceof CloudError && err.message === CANCELLED;
}

const CANCELLED = "upload-cancelled";

/**
 * PUT the file to Storage with progress.
 *
 * `onProgress` receives 0..1, and is called on a real byte count — never a
 * fake timer. A browser that cannot compute the total (rare, chunked encoding)
 * simply gets fewer callbacks; the caller shows an indeterminate bar rather
 * than a lying one.
 */
export function uploadVideoWithProgress(
  supabase: SupabaseClient,
  path: string,
  file: Blob,
  mime: string,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  let cancelled = false;

  const done = (async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new CloudError("尚未登入，無法上傳影片", "storage");
    if (cancelled) throw new CloudError(CANCELLED, "storage");
    const token = data.session.access_token;

    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = `${SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/${ASSET_BUCKET}/${encodedPath}`;

    return await new Promise<string>((resolve, reject) => {
      xhr.open("POST", url, true);
      xhr.setRequestHeader("authorization", `Bearer ${token}`);
      xhr.setRequestHeader("apikey", SUPABASE_PUBLISHABLE_KEY);
      xhr.setRequestHeader("content-type", mime || "application/octet-stream");
      // Same semantics as storage-js's { upsert: true }: re-uploading the same
      // version after a failed attempt must overwrite, not 409.
      xhr.setRequestHeader("x-upsert", "true");
      // storage-js sends `max-age=<n>`; a bare number is not a directive, and a
      // response with an unparseable Cache-Control falls back to heuristic
      // caching — unbounded, for bytes that are supposed to be private.
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
        if (xhr.status === 413) {
          reject(new CloudError("影片超過這個空間允許的大小，請壓縮後再試。", "storage"));
          return;
        }
        reject(new CloudError(readError(xhr) ?? `影片上傳失敗（${xhr.status}）`, "storage"));
      };
      xhr.onerror = () => reject(new CloudError("影片上傳中斷，請檢查網路後重試。", "storage"));
      xhr.onabort = () => reject(new CloudError(CANCELLED, "storage"));
      xhr.send(file);
    });
  })();

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
  };
}

function readError(xhr: XMLHttpRequest): string | null {
  try {
    const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
    return body.message ?? body.error ?? null;
  } catch {
    return null;
  }
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
