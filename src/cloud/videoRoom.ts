import type { SupabaseClient } from "@supabase/supabase-js";
import type { Version } from "../lib/types";
import { deleteUploadSession, saveUploadSession } from "../lib/store";
import { sha256Blob, uploadAsset, versionPath } from "./assets";
import { SUPABASE_URL } from "./config";
import { CloudError } from "./errors";
import { addVideoVersion } from "./roomRepository";
import { classifyOptimizeNeed, transcodeVideoIfNeeded } from "./videoOptimize";
import {
  isUploadCancelled,
  signedVideoUrl,
  tusFingerprint,
  uploadVideoWithProgress,
  videoPath,
  type UploadHandle,
} from "./videoAssets";
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
 *   3. optimize / transcode only when needed (original bytes stay untouched),
 *   4. TUS resumable upload, reporting real byte progress,
 *   5. upload the cover,
 *   6. only then write the row.
 */

export type VideoUploadPhase = "preparing" | "optimizing" | "uploading" | "paused" | "retrying" | "processing";

export type VideoUploadInput = {
  roomId: string;
  versionId: string;
  branchId?: string;
  label: string;
  sortOrder: number;
  file: File;
  mime: string;
  /** Used only for the fallback cover when no frame can be captured. */
  roomTitle: string;
  resumeUploadUrl?: string;
};

export type VideoUploadHandle = {
  done: Promise<Version>;
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  retry: () => void;
};

export function uploadVideoVersion(
  supabase: SupabaseClient,
  input: VideoUploadInput,
  onPhase: (phase: VideoUploadPhase, progress: number) => void,
): VideoUploadHandle {
  let cancelUpload: (() => void) | null = null;
  let pauseUpload: (() => void) | null = null;
  let resumeUpload: (() => void) | null = null;
  let retryUpload: (() => void) | null = null;
  let cancelled = false;
  let lastProgress = 0;
  const optimizeSignal = { cancelled: false };

  const done = (async (): Promise<Version> => {
    const objectUrl = URL.createObjectURL(input.file);
    const ext = extForVideoMime(input.mime);
    const path = videoPath(input.roomId, input.versionId, ext);
    let rowLanded = false;
    let posterPath: string | null = null;
    let uploadPayload: Blob = input.file;
    let uploadMime = input.mime;
    let optimized = false;

    try {
      onPhase("preparing", 0);
      const meta = await probeVideo(objectUrl);
      if (cancelled) throw new CloudError("upload-cancelled", "storage");
      const tooLong = rejectByDuration(meta.duration);
      if (tooLong) throw new CloudError(tooLong, "storage");

      const poster =
        (await capturePoster(objectUrl, posterTimeFor(meta.duration))) ??
        (await fallbackPoster(input.roomTitle));
      if (cancelled) throw new CloudError("upload-cancelled", "storage");

      const plan = classifyOptimizeNeed(input.file);
      if (plan.plan !== "direct") {
        onPhase("optimizing", 0);
        const result = await transcodeVideoIfNeeded(input.file, (fraction) => onPhase("optimizing", fraction), {
          duration: meta.duration,
          signal: optimizeSignal,
        });
        uploadPayload = result.file;
        uploadMime = result.mime;
        optimized = result.optimized;
      }

      const fingerprint = tusFingerprint({
        origin: SUPABASE_URL.replace(/\/+$/, ""),
        objectName: path,
        fileName: input.file.name,
        fileSize: input.file.size,
        lastModified: input.file.lastModified,
      });
      const session = {
        id: input.versionId,
        roomId: input.roomId,
        versionId: input.versionId,
        objectName: path,
        fileName: input.file.name,
        fileSize: input.file.size,
        lastModified: input.file.lastModified,
        mime: input.mime,
        fingerprint,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: "uploading",
      };
      await saveUploadSession(session).catch(() => undefined);

      onPhase("uploading", 0);
      const handle: UploadHandle = uploadVideoWithProgress(
        supabase,
        path,
        uploadPayload,
        uploadMime,
        (fraction) => {
          lastProgress = fraction;
          onPhase("uploading", fraction);
        },
        {
          uploadUrl: input.resumeUploadUrl,
          onUploadUrl: (url) => {
            void saveUploadSession({ ...session, uploadUrl: url, state: "uploading" }).catch(() => undefined);
          },
        },
      );
      cancelUpload = handle.cancel;
      pauseUpload = () => {
        handle.pause();
        onPhase("paused", lastProgress);
      };
      resumeUpload = () => {
        handle.resume();
        onPhase("uploading", 0);
      };
      retryUpload = handle.retry;
      await handle.done;
      cancelUpload = null;

      onPhase("processing", 1);
      if (cancelled) throw new CloudError("upload-cancelled", "storage");
      if (poster) {
        posterPath = await uploadAsset(
          supabase,
          versionPath(input.roomId, input.versionId, poster.mime),
          poster.blob,
          poster.mime,
        ).catch(() => null);
      }

      if (cancelled) throw new CloudError("upload-cancelled", "storage");
      const contentHash = input.file.size <= 32 * 1024 * 1024
        ? await sha256Blob(input.file).catch(() => undefined)
        : undefined;
      await addVideoVersion(supabase, input.roomId, {
        id: input.versionId,
        branchId: input.branchId,
        label: input.label,
        sortOrder: input.sortOrder,
        videoPath: path,
        posterPath,
        mimeType: uploadMime,
        duration: meta.duration > 0 ? meta.duration : null,
        fileSize: uploadPayload.size,
        width: meta.width || null,
        height: meta.height || null,
        contentHash,
        optimized,
        sourceFileSize: input.file.size,
      });

      rowLanded = true;
      await deleteUploadSession(input.versionId).catch(() => undefined);

      return {
        id: input.versionId,
        label: input.label,
        kind: "video",
        imageDataUrl: posterPath ? await signedOrEmpty(supabase, posterPath) : "",
        videoUrl: await signedVideoUrl(supabase, path).catch(() => ""),
        videoPath: path,
        duration: meta.duration > 0 ? meta.duration : undefined,
        mimeType: uploadMime,
        fileSize: uploadPayload.size,
        width: meta.width || undefined,
        height: meta.height || undefined,
        optimized,
        sourceFileSize: input.file.size,
      };
    } catch (err) {
      if (!rowLanded) {
        await removeQuietly(supabase, [path, ...(posterPath ? [posterPath] : [])]);
        await deleteUploadSession(input.versionId).catch(() => undefined);
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
      optimizeSignal.cancelled = true;
      cancelUpload?.();
    },
    pause: () => pauseUpload?.(),
    resume: () => resumeUpload?.(),
    retry: () => retryUpload?.(),
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { error } = await supabase.storage.from("room-assets").remove(paths);
      if (!error) return;
    } catch {
      /* Retry below; the original upload error remains the user-facing error. */
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
  }
}
