/**
 * Everything that has to happen to a video file in the browser BEFORE it is a
 * reviewable version: check it, measure it, and take one still off it.
 *
 * Deliberately free of React and Supabase imports — this is plain DOM work, so
 * it can be exercised in a headless browser the same way shareThumbnail.ts is.
 */

/**
 * What we will accept. MP4 and WebM are the two that actually play across
 * Android Chrome, desktop and the LINE in-app browser; QuickTime is allowed
 * because iPhones produce it and it is usually H.264 inside, but a .mov can
 * still hold a codec this browser cannot decode — which is why nothing here
 * promises playback, and the player has a real "cannot play this" state.
 */
export const ACCEPTED_VIDEO_MIME = ["video/mp4", "video/webm", "video/quicktime"] as const;

/** The file picker's accept attribute. Kept next to the MIME list it mirrors. */
export const VIDEO_ACCEPT = "video/mp4,video/webm,video/quicktime,video/*";

/**
 * What one upload may weigh.
 *
 * Three different ceilings apply and the smallest wins: this one, the bucket's
 * (200MB, set in 0006), and the Supabase project's global limit — which is
 * 50MB on the free plan. This number is deliberately NOT the bucket ceiling:
 * the upload is a single POST with no resume, so a file big enough to take
 * several minutes on mobile data is a file likely to fail. Resumable (TUS)
 * uploads are what would earn a bigger number, and they are a later PR.
 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * Anything longer is a film, not a cut under review; also bounds the timeline.
 * Enforced after probing (a duration is not knowable from the file entry), and
 * only when the browser actually reported one — an unmeasurable video is still
 * allowed through, because refusing it would punish the user for a codec quirk.
 */
export const MAX_VIDEO_SECONDS = 2 * 60 * 60;

/**
 * Human form of the ceilings, for the picker and the README.
 *
 * Hedged on purpose: this is the app's own limit, and the Supabase project
 * behind it may impose a lower one (50MB on the free plan). Promising a flat
 * 100MB would make the app the liar when a 90MB file is refused by Storage.
 */
export const VIDEO_LIMIT_HINT = `一支最多 ${formatBytes(MAX_VIDEO_BYTES)}、${Math.round(MAX_VIDEO_SECONDS / 60)} 分鐘，實際上限依雲端空間設定`;

/**
 * The check that needs the video's own metadata. Returns a reason to refuse,
 * or null to carry on.
 */
export function rejectByDuration(duration: number): string | null {
  if (!Number.isFinite(duration) || duration <= 0) return null; // unknown: allow
  if (duration > MAX_VIDEO_SECONDS) {
    return `影片太長了（${formatTime(duration)}），目前上限 ${Math.round(MAX_VIDEO_SECONDS / 60)} 分鐘。`;
  }
  return null;
}

export type VideoMeta = {
  /** Seconds. 0 when the browser refused to tell us (streams, odd codecs). */
  duration: number;
  width: number;
  height: number;
};

export type VideoRejection = { ok: false; reason: string };
export type VideoAcceptance = { ok: true; file: File; mime: string; warning?: string };

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** mm:ss, or h:mm:ss once it earns the hour. Used by the player and every card. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/** File-name safe extension for a video mime; the bucket path uses it. */
export function extForVideoMime(mime: string): string {
  if (mime === "video/webm") return "webm";
  if (mime === "video/quicktime") return "mov";
  return "mp4";
}

/**
 * Gate a picked file. Type first (a wrong file is the common mistake), then
 * size — every message says what to do next, not just what went wrong.
 */
// VideoAcceptance 的 warning：可上傳但值得先講的事（如 .mov/HEVC 相容性）。
export function acceptVideoFile(file: File): VideoAcceptance | VideoRejection {
  const mime = (file.type || "").toLowerCase();
  if (!mime.startsWith("video/")) {
    return { ok: false, reason: "這個檔案不是影片，選一支 MP4 或 WebM 試試。" };
  }
  if (!ACCEPTED_VIDEO_MIME.includes(mime as (typeof ACCEPTED_VIDEO_MIME)[number])) {
    return { ok: false, reason: "這種影片格式可能播不出來，建議先轉成 MP4（H.264）。" };
  }
  // .mov 收，但在「選檔當下」把話說清楚（PR-01c）：iPhone 預設 HEVC，
  // 房主自己播得動不代表 Windows/Android 的對稿對象播得動。瀏覽器拿不到
  // codec 事實，所以是警告不是拒絕 — 上傳照走。
  if (mime === "video/quicktime") {
    return {
      ok: true,
      file,
      mime,
      warning: "iPhone 的 .mov 若是 HEVC 編碼，部分對稿對象的瀏覽器會播不出來；保險做法是轉成 MP4（H.264）再上傳。",
    };
  }
  if (file.size > MAX_VIDEO_BYTES) {
    return {
      ok: false,
      reason: `影片太大了（${formatBytes(file.size)}），目前一支上限 ${formatBytes(MAX_VIDEO_BYTES)}。`,
    };
  }
  if (file.size === 0) {
    return { ok: false, reason: "這個檔案是空的，請重新選一次。" };
  }
  return { ok: true, file, mime };
}

/**
 * Read duration and pixel size without decoding the whole file.
 *
 * `preload="metadata"` is the cheap path, but some Android builds report
 * `duration: Infinity` for WebM written by MediaRecorder (no duration in the
 * container). The documented trick is to seek far past the end and let the
 * browser correct itself, which is what the Infinity branch does.
 *
 * Never rejects: a video whose metadata cannot be read is still uploadable, it
 * just gets a timeline without a total. Refusing the upload over a missing
 * number would be the app's problem becoming the user's.
 */
export function probeVideo(objectUrl: string, timeoutMs = 15000): Promise<VideoMeta> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    let settled = false;

    const finish = (meta: VideoMeta) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.ondurationchange = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(meta);
    };

    const timer = window.setTimeout(() => finish({ duration: 0, width: 0, height: 0 }), timeoutMs);

    const report = () =>
      finish({
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
      });

    video.onloadedmetadata = () => {
      if (video.duration === Infinity) {
        // Force the browser to compute the real length, then wait for it.
        video.ondurationchange = () => {
          if (Number.isFinite(video.duration)) {
            video.currentTime = 0;
            report();
          }
        };
        video.currentTime = 1e101;
        return;
      }
      report();
    };
    video.onerror = () => finish({ duration: 0, width: 0, height: 0 });
    video.src = objectUrl;
  });
}

/**
 * Where to take the cover frame: a tenth of the way in, capped at three
 * seconds so a long video is not represented by its opening fade. Very short
 * clips get their middle, which is the only frame guaranteed to have content.
 */
export function posterTimeFor(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (duration <= 1) return duration / 2;
  return Math.min(duration * 0.1, 3);
}

export type PosterResult = { blob: Blob; mime: string; width: number; height: number };

/** Seek and wait for the frame, or give up quickly and let the caller move on. */
function seekTo(video: HTMLVideoElement, seconds: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - seconds) < 0.05) {
      resolve(true);
      return;
    }
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      video.onseeked = null;
      resolve(ok);
    };
    video.onseeked = () => finish(true);
    try {
      video.currentTime = seconds;
    } catch {
      finish(false);
    }
  });
}

/**
 * Is this frame effectively a blank screen? Samples a coarse grid rather than
 * every pixel — a cover frame only has to be *not* pure black or pure white for
 * the card to be worth showing.
 */
function isMostlyBlank(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const step = Math.max(1, Math.floor(Math.min(w, h) / 16));
    let min = 255;
    let max = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luma < min) min = luma;
        if (luma > max) max = luma;
      }
    }
    // A frame with almost no contrast anywhere is a black (or white) screen.
    return max - min < 12;
  } catch {
    // A tainted canvas cannot be sampled; assume the frame is fine rather than
    // discarding a poster we already drew.
    return false;
  }
}

/**
 * The cover shown when no frame could be captured.
 *
 * A version row's still image is what share cards, recents and the player's
 * poster all read, so "no frame" must still produce *an* image rather than a
 * hole in three different features. Warm paper, the room's name, and an honest
 * play glyph — it never pretends to be a frame of the video.
 */
export function fallbackPoster(title: string, width = 1280, height = 720): Promise<PosterResult | null> {
  return new Promise((resolve) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      const bg = ctx.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, "#1d1a17");
      bg.addColorStop(1, "#2b2521");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.arc(width / 2, height / 2 - height * 0.04, height * 0.13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      const r = height * 0.055;
      const cx = width / 2 + r * 0.18;
      const cy = height / 2 - height * 0.04;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx - r * 0.5, cy + r);
      ctx.closePath();
      ctx.fill();

      const name = (title || "影片").slice(0, 24);
      ctx.fillStyle = "rgba(244,239,230,0.92)";
      ctx.font = `600 ${Math.round(height * 0.06)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(name, width / 2, height / 2 + height * 0.2);

      canvas.toBlob(
        (blob) => resolve(blob ? { blob, mime: "image/jpeg", width, height } : null),
        "image/jpeg",
        0.85,
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Grab one frame as a JPEG, downscaled to at most 1280px wide.
 *
 * Uses a local object URL, so the canvas is never tainted and this keeps
 * working when the video itself is behind a signed URL. Resolves to null on
 * any failure — a room without a cover is a cosmetic loss, and blocking the
 * upload on a canvas quirk would be a functional one.
 */
export async function capturePoster(
  objectUrl: string,
  atSeconds: number,
  maxWidth = 1280,
): Promise<PosterResult | null> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  // Deliberately NOT setting crossOrigin: this is always a local blob: URL, and
  // some Safari builds fail the entire load when the attribute is present on
  // one. A remote poster capture would need it — and would need bucket CORS —
  // which is why capture happens here, at upload time, from the local file.

  const cleanup = () => {
    video.onseeked = null;
    video.onerror = null;
    video.onloadeddata = null;
    video.removeAttribute("src");
    video.load();
  };

  try {
    const frameReady = await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), 20000);
      const done = (ok: boolean) => {
        window.clearTimeout(timer);
        resolve(ok);
      };
      video.onerror = () => done(false);
      // Only wait for the first frame to exist; which frame to keep is decided
      // by the candidate loop below.
      video.onloadeddata = () => done(true);
      video.src = objectUrl;
    });

    if (!frameReady || !video.videoWidth || !video.videoHeight) return null;

    const scale = Math.min(1, maxWidth / video.videoWidth);
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Videos very often open on black, and a decoder can also hand back an
    // empty frame right after a seek. Try the intended moment first, then a
    // couple of alternatives, and keep the first frame that has any content.
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const candidates = [atSeconds, 1, duration > 0 ? duration / 2 : 0, 0].filter(
      (t, i, arr) => Number.isFinite(t) && t >= 0 && arr.indexOf(t) === i && (duration === 0 || t < duration),
    );
    let drawn = false;
    for (const at of candidates) {
      if (!(await seekTo(video, at))) continue;
      ctx.drawImage(video, 0, 0, w, h);
      drawn = true;
      if (!isMostlyBlank(ctx, w, h)) break;
    }
    if (!drawn) return null;

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
    if (!blob) return null;
    return { blob, mime: "image/jpeg", width: w, height: h };
  } catch {
    // Cross-origin taint, decoder refusal, out-of-memory on a huge frame — all
    // of them mean the same thing to the caller: no cover this time.
    return null;
  } finally {
    cleanup();
  }
}
