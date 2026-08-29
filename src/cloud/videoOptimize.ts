import { CloudError } from "./errors";
import { formatBytes } from "../features/video-review/media";

/**
 * Browser-side video optimize / transcode planning.
 *
 * Original bytes are never mutated. When a file needs a compatible proxy we
 * produce a *new* Blob and upload that; the source File stays on the device.
 */

export const DEFAULT_DIRECT_UPLOAD_MB = 50;
export const OPTIMIZE_TARGET_BYTES = 44 * 1024 * 1024;
export const UNSAFE_TRANSCODE_BYTES = 220 * 1024 * 1024;

export type TranscodePlan = "direct" | "browser-optimize" | "needs-fallback";

export type OptimizeResult = {
  file: Blob;
  mime: string;
  optimized: boolean;
  sourceFileSize: number;
  note?: string;
};

export function envUploadCeilingMb(): number {
  const raw = readEnvMb();
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DIRECT_UPLOAD_MB;
}

export function directUploadLimitBytes(): number {
  return Math.round(envUploadCeilingMb() * 1024 * 1024);
}

function readEnvMb(): number {
  try {
    const value = (import.meta as { env?: { VITE_MAX_VIDEO_UPLOAD_MB?: string } }).env?.VITE_MAX_VIDEO_UPLOAD_MB;
    return Number(value);
  } catch {
    return Number.NaN;
  }
}

export function shouldOptimizeVideo(input: { size: number; mime: string; name?: string }): boolean {
  if (input.size > directUploadLimitBytes()) return true;
  const mime = (input.mime || "").toLowerCase();
  const name = (input.name || "").toLowerCase();
  return mime === "video/quicktime" || name.endsWith(".mov");
}

export function planVideoTranscode(input: { size: number; mime: string; name?: string; canEncode?: boolean }): TranscodePlan {
  if (!shouldOptimizeVideo(input)) return "direct";
  if (input.size > UNSAFE_TRANSCODE_BYTES) return "needs-fallback";
  if (input.canEncode === false) return "needs-fallback";
  return "browser-optimize";
}

export function targetBitrate(durationSeconds: number, targetBytes = OPTIMIZE_TARGET_BYTES, audioBitrate = 128_000): number {
  const duration = Math.max(1, durationSeconds);
  const totalBits = targetBytes * 8;
  const audioBits = audioBitrate * duration;
  const video = Math.floor((totalBits - audioBits) / duration);
  return Math.min(6_000_000, Math.max(400_000, video));
}

export function classifyOptimizeNeed(file: File): { plan: TranscodePlan; message: string } {
  const plan = planVideoTranscode({ size: file.size, mime: file.type, name: file.name });
  if (plan === "direct") return { plan, message: "可以直接上傳。" };
  if (plan === "needs-fallback") {
    return { plan, message: "這台裝置無法直接最佳化這支影片，請先壓縮或改選較小的檔案。" };
  }
  return { plan, message: `這支影片較大（${formatBytes(file.size)}），會先最佳化後再上傳。` };
}

/**
 * Best-effort in-browser transcode using the playback pipeline + MediaRecorder.
 *
 * WebCodecs + a muxer would be nicer, but that is a large download on every
 * phone. MediaRecorder is already present and keeps the original file intact.
 */
export async function transcodeVideoIfNeeded(
  file: File,
  onProgress: (fraction: number) => void,
  options: { duration?: number; signal?: { cancelled: boolean } } = {},
): Promise<OptimizeResult> {
  const sourceFileSize = file.size;
  const plan = planVideoTranscode({ size: file.size, mime: file.type, name: file.name });
  if (plan === "direct") {
    onProgress(1);
    return { file, mime: file.type || "video/mp4", optimized: false, sourceFileSize };
  }
  if (plan === "needs-fallback") {
    throw new CloudError("這台裝置無法直接最佳化這支影片，請先壓縮或改選較小的檔案。", "storage");
  }

  const optimized = await transcodeWithMediaRecorder(file, onProgress, options);
  return { file: optimized.blob, mime: optimized.mime, optimized: true, sourceFileSize, note: "browser-optimize" };
}

async function transcodeWithMediaRecorder(
  file: File,
  onProgress: (fraction: number) => void,
  options: { duration?: number; signal?: { cancelled: boolean } },
): Promise<{ blob: Blob; mime: string }> {
  if (typeof document === "undefined" || typeof MediaRecorder === "undefined") {
    throw new CloudError("這台裝置無法直接最佳化這支影片，請先壓縮或改選較小的檔案。", "storage");
  }

  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = objectUrl;

  try {
    await waitForLoaded(video);
    if (options.signal?.cancelled) throw cancelled();
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : options.duration ?? 0;
    const mime = pickRecorderMime();
    if (!mime) throw new CloudError("這台裝置無法直接最佳化這支影片，請先壓縮或改選較小的檔案。", "storage");

    const stream = captureVideoStream(video);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: targetBitrate(duration || 30) });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    const stopped = new Promise<Blob>((resolve, reject) => {
      recorder.onerror = () => reject(new CloudError("這支影片需要先最佳化", "storage"));
      recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    });

    recorder.start(250);
    await video.play().catch(() => undefined);
    await waitUntilEnded(video, duration, (fraction) => {
      if (options.signal?.cancelled) {
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
        throw cancelled();
      }
      onProgress(Math.min(0.99, fraction));
    });
    if (recorder.state !== "inactive") recorder.stop();
    stopStream(stream);
    const blob = await stopped;
    if (!blob.size) throw new CloudError("這支影片需要先最佳化", "storage");
    onProgress(1);
    return { blob, mime };
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute("src");
    video.load();
  }
}

function captureVideoStream(video: HTMLVideoElement): MediaStream {
  const withCapture = video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  if (typeof withCapture.captureStream === "function") return withCapture.captureStream();
  if (typeof withCapture.mozCaptureStream === "function") return withCapture.mozCaptureStream();
  throw new CloudError("這台裝置無法直接最佳化這支影片，請先壓縮或改選較小的檔案。", "storage");
}

function pickRecorderMime(): string | null {
  const candidates = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime.startsWith("video/mp4") ? "video/mp4" : "video/webm";
  }
  return null;
}

function waitForLoaded(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new CloudError("這支影片需要先最佳化", "storage")), 20000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      reject(new CloudError("這支影片需要先最佳化", "storage"));
    };
  });
}

async function waitUntilEnded(
  video: HTMLVideoElement,
  duration: number,
  onProgress: (fraction: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      const total = duration || video.duration || 0;
      if (total > 0) onProgress(Math.min(0.99, video.currentTime / total));
    };
    const timer = window.setInterval(tick, 200);
    video.onended = () => {
      window.clearInterval(timer);
      resolve();
    };
    video.onerror = () => {
      window.clearInterval(timer);
      reject(new CloudError("這支影片需要先最佳化", "storage"));
    };
  });
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function cancelled(): CloudError {
  return new CloudError("upload-cancelled", "storage");
}
