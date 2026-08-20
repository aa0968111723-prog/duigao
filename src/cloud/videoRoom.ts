import type { SupabaseClient } from "@supabase/supabase-js";
import type { Version } from "../lib/types";
import { uploadAsset, versionPath } from "./assets";
import { CloudError } from "./errors";
import { addVideoVersion } from "./roomRepository";
import { isUploadCancelled, signedVideoUrl, uploadVideoWithProgress, videoPath } from "./videoAssets";
import {
  capturePoster,
  extForVideoMime,
  fallbackPoster,
  posterTimeFor,
  probeVideo,
  rejectByDuration,
} from "../features/video-review/media";

/**
 * Turning a picked file into a reviewable cut.
 *
 * The order is deliberate and the failure handling is the point:
 *
 *   1. measure the file locally (never blocks on a missing number),
 *   2. take a cover frame from the LOCAL file — no CORS, no signed URL,
 *   3. upload the video, reporting real byte progress,
 *   4. upload the cover,
 *   5. only then write the row.
 *
 * The row lands last so a version can never exist without its video. If the row
 * fails anyway, the uploaded objects are removed rather than left as orphans in
 * a private bucket nobody will ever look at again.
 */

export type VideoUploadPhase = "preparing" | "uploading" | "processing";

export type VideoUploadInput = {
  roomId: string;
  versionId: string;
  label: string;
  sortOrder: number;
  file: File;
  mime: string;
  /** Used only for the fallback cover when no frame can be captured. */
  roomTitle: string;
};

export type VideoUploadHandle = {
  done: Promise<Version>;
  cancel: () => void;
};

export function uploadVideoVersion(
  supabase: SupabaseClient,
  input: VideoUploadInput,
  onPhase: (phase: VideoUploadPhase, progress: number) => void,
): VideoUploadHandle {
  let cancelUpload: (() => void) | null = null;
  let cancelled = false;

  const done = (async (): Promise<Version> => {
    const objectUrl = URL.createObjectURL(input.file);
    const ext = extForVideoMime(input.mime);
    const path = videoPath(input.roomId, input.versionId, ext);
    let videoLanded = false;
    let rowLanded = false;
    let posterPath: string | null = null;

    try {
      onPhase("preparing", 0);
      const meta = await probeVideo(objectUrl);
      if (cancelled) throw new CloudError("upload-cancelled", "storage");
      // The only check that needs the file's own metadata; refusing here costs
      // the user nothing, refusing after a 100MB upload would cost them a lot.
      const tooLong = rejectByDuration(meta.duration);
      if (tooLong) throw new CloudError(tooLong, "storage");

      // The cover comes from the local file: capturing it later from a signed
      // URL would need CORS and would taint the canvas on some browsers.
      const poster =
        (await capturePoster(objectUrl, posterTimeFor(meta.duration))) ??
        (await fallbackPoster(input.roomTitle));
      if (cancelled) throw new CloudError("upload-cancelled", "storage");

      onPhase("uploading", 0);
      const handle = uploadVideoWithProgress(supabase, path, input.file, input.mime, (fraction) =>
        onPhase("uploading", fraction),
      );
      cancelUpload = handle.cancel;
      await handle.done;
      videoLanded = true;
      cancelUpload = null;

      onPhase("processing", 1);
      if (poster) {
        // A cover that fails to upload costs a thumbnail, never the cut.
        posterPath = await uploadAsset(
          supabase,
          versionPath(input.roomId, input.versionId, poster.mime),
          poster.blob,
          poster.mime,
        ).catch(() => null);
      }

      await addVideoVersion(supabase, input.roomId, {
        id: input.versionId,
        label: input.label,
        sortOrder: input.sortOrder,
        videoPath: path,
        posterPath,
        mimeType: input.mime,
        // Deliberately null, never 0: the column rejects a non-positive
        // duration, and "we could not measure it" is a real answer.
        duration: meta.duration > 0 ? meta.duration : null,
        fileSize: input.file.size,
        width: meta.width || null,
        height: meta.height || null,
      });

      rowLanded = true;

      return {
        id: input.versionId,
        label: input.label,
        kind: "video",
        imageDataUrl: posterPath ? await signedOrEmpty(supabase, posterPath) : "",
        // Best-effort: the row already exists, so a signing hiccup must not be
        // allowed to unwind an upload that succeeded. The player re-signs.
        videoUrl: await signedVideoUrl(supabase, path).catch(() => ""),
        videoPath: path,
        duration: meta.duration > 0 ? meta.duration : undefined,
        mimeType: input.mime,
        fileSize: input.file.size,
        width: meta.width || undefined,
        height: meta.height || undefined,
      };
    } catch (err) {
      // Nothing half-created survives: a stored object with no row is invisible
      // to the app and would sit in the bucket forever. Once the row exists the
      // opposite is true — deleting the object would leave a version pointing
      // at nothing — so cleanup stops the moment the row lands.
      if (videoLanded && !rowLanded) {
        await removeQuietly(supabase, [path, ...(posterPath ? [posterPath] : [])]);
      }
      throw err;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  })();

  return {
    done,
    cancel: () => {
      cancelled = true;
      cancelUpload?.();
    },
  };
}

export { isUploadCancelled };

async function signedOrEmpty(supabase: SupabaseClient, path: string): Promise<string> {
  try {
    const { data } = await supabase.storage.from("room-assets").createSignedUrl(path, 60 * 60);
    return data?.signedUrl ?? "";
  } catch {
    return "";
  }
}

async function removeQuietly(supabase: SupabaseClient, paths: string[]): Promise<void> {
  try {
    await supabase.storage.from("room-assets").remove(paths);
  } catch {
    /* the row never landed either way; a retry will upsert over these */
  }
}
