import { ASSET_BUCKET } from "./assets";
import { CloudError } from "./errors";

function envString(name: "VITE_SUPABASE_URL" | "VITE_SUPABASE_PUBLISHABLE_KEY"): string {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    return (env?.[name] ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Minimal TUS 1.0 client for Supabase Storage `/storage/v1/upload/resumable`.
 *
 * Chunk size is 6MB because that is what Supabase currently requires. Auth is
 * always the signed-in user's token — never a service-role key.
 */

export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
export const TUS_RETRY_DELAYS_MS = [0, 1000, 3000, 5000, 10000] as const;
export const TUS_VERSION = "1.0.0";

export type TusUploadState =
  | "preparing"
  | "uploading"
  | "paused"
  | "retrying"
  | "completed"
  | "cancelled"
  | "failed";

export type TusUploadHandle = {
  done: Promise<string>;
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  retry: () => void;
  getState: () => TusUploadState;
  getOffset: () => number;
};

export type TusUploadInput = {
  path: string;
  file: Blob;
  mime: string;
  accessToken: string;
  onProgress: (fraction: number) => void;
  /** Resume a previously created TUS URL (same fingerprint / version). */
  uploadUrl?: string;
  onUploadUrl?: (url: string) => void;
  fetchImpl?: typeof fetch;
  supabaseUrl?: string;
  apiKey?: string;
};

const CANCELLED = "upload-cancelled";

export function isTusCancelled(err: unknown): boolean {
  return err instanceof CloudError && err.message === CANCELLED;
}

export function tusFingerprint(input: {
  origin: string;
  bucket?: string;
  objectName: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
}): string {
  const bucket = input.bucket ?? ASSET_BUCKET;
  return [input.origin, bucket, input.objectName, input.fileName, String(input.fileSize), String(input.lastModified)].join("|");
}

export function encodeTusMetadata(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key} ${btoaUtf8(value)}`)
    .join(",");
}

function btoaUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function classifyStorageUploadError(status: number, body: string): CloudError {
  const lower = body.toLowerCase();
  if (status === 413 || /payload too large|entity too large|maximum allowed size|file size/i.test(lower)) {
    return new CloudError("影片超過目前雲端可接受的大小", "storage");
  }
  if (status === 401 || status === 403 || /row-level security|permission|not allowed|jwt/i.test(lower)) {
    return new CloudError("你目前沒有上傳這個房間影片的權限", "storage");
  }
  if (status === 0 || status === 408 || status >= 500) {
    return new CloudError("網路中斷，可從目前進度繼續", "storage");
  }
  if (/codec|unsupported|invalid.*format|not a video/i.test(lower)) {
    return new CloudError("這支影片需要先最佳化", "storage");
  }
  if (status >= 400) {
    return new CloudError(`影片上傳失敗（${status}）`, "storage");
  }
  return new CloudError("影片上傳中斷，請檢查網路後重試。", "storage");
}

function sleep(ms: number, signal: { cancelled: boolean; paused: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (signal.cancelled) {
        reject(new CloudError(CANCELLED, "storage"));
        return;
      }
      if (signal.paused) {
        resolve();
        return;
      }
      if (Date.now() - started >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(50, ms));
    };
    setTimeout(tick, Math.min(50, ms));
  });
}

/**
 * Upload `file` to the given Storage object path using TUS, with pause / resume
 * / retry. The object path is unchanged so 0007 Storage policies still apply.
 */
export function uploadResumableVideo(input: TusUploadInput): TusUploadHandle {
  const fetchImpl = input.fetchImpl ?? fetch;
  const origin = (input.supabaseUrl ?? envString("VITE_SUPABASE_URL")).replace(/\/+$/, "");
  const apiKey = input.apiKey ?? envString("VITE_SUPABASE_PUBLISHABLE_KEY");
  const signal = { cancelled: false, paused: false };
  let state: TusUploadState = "preparing";
  let offset = 0;
  let uploadUrl = input.uploadUrl ?? "";
  let resumeWait: (() => void) | null = null;
  let failWait: ((err: unknown) => void) | null = null;

  const waitWhilePaused = () =>
    new Promise<void>((resolve, reject) => {
      if (signal.cancelled) {
        reject(new CloudError(CANCELLED, "storage"));
        return;
      }
      if (!signal.paused) {
        resolve();
        return;
      }
      resumeWait = resolve;
      failWait = reject;
    });

  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${input.accessToken}`,
    apikey: apiKey,
    "tus-resumable": TUS_VERSION,
    ...extra,
  });

  const done = (async () => {
    try {
      if (!uploadUrl) {
        const created = await createUpload();
        uploadUrl = created;
      }
      input.onUploadUrl?.(uploadUrl);
      offset = await readOffset(uploadUrl);
      input.onProgress(progressOf(offset, input.file.size));

      while (offset < input.file.size) {
        if (signal.cancelled) throw new CloudError(CANCELLED, "storage");
        if (signal.paused) {
          state = "paused";
          await waitWhilePaused();
          if (signal.cancelled) throw new CloudError(CANCELLED, "storage");
          offset = await readOffset(uploadUrl);
        }
        state = "uploading";
        const end = Math.min(input.file.size, offset + TUS_CHUNK_BYTES);
        const chunk = input.file.slice(offset, end);
        await patchWithRetry(uploadUrl, chunk, offset);
        offset = end;
        input.onProgress(progressOf(offset, input.file.size));
      }

      state = "completed";
      input.onProgress(1);
      return input.path;
    } catch (err) {
      if (signal.cancelled || isTusCancelled(err)) {
        state = "cancelled";
        throw err instanceof CloudError ? err : new CloudError(CANCELLED, "storage");
      }
      state = "failed";
      throw err;
    }
  })();

  async function createUpload(): Promise<string> {
    const metadata = encodeTusMetadata({
      bucketName: ASSET_BUCKET,
      objectName: input.path,
      contentType: input.mime || "application/octet-stream",
      cacheControl: "3600",
    });
    const response = await fetchImpl(`${origin}/storage/v1/upload/resumable`, {
      method: "POST",
      headers: headers({
        "upload-length": String(input.file.size),
        "upload-metadata": metadata,
        "x-upsert": "true",
      }),
    });
    if (!response.ok) {
      throw classifyStorageUploadError(response.status, await safeText(response));
    }
    const location = response.headers.get("location") || response.headers.get("Location");
    if (!location) throw new CloudError("無法開始可續傳上傳", "storage");
    return new URL(location, `${origin}/storage/v1/upload/resumable`).toString();
  }

  async function readOffset(url: string): Promise<number> {
    const response = await fetchImpl(url, { method: "HEAD", headers: headers() });
    if (!response.ok) {
      throw classifyStorageUploadError(response.status, await safeText(response));
    }
    const raw = response.headers.get("upload-offset") || response.headers.get("Upload-Offset") || "0";
    const next = Number(raw);
    return Number.isFinite(next) && next >= 0 ? next : 0;
  }

  async function patchWithRetry(url: string, chunk: Blob, expectedOffset: number): Promise<void> {
    let lastError: unknown = new CloudError("網路中斷，可從目前進度繼續", "storage");
    for (let attempt = 0; attempt < TUS_RETRY_DELAYS_MS.length; attempt += 1) {
      if (signal.cancelled) throw new CloudError(CANCELLED, "storage");
      if (signal.paused) return;
      const delay = TUS_RETRY_DELAYS_MS[attempt];
      if (delay > 0) {
        state = "retrying";
        await sleep(delay, signal);
        if (signal.paused || signal.cancelled) return;
      }
      try {
        const response = await fetchImpl(url, {
          method: "PATCH",
          headers: headers({
            "content-type": "application/offset+octet-stream",
            "upload-offset": String(expectedOffset),
          }),
          body: chunk,
        });
        if (response.status === 204 || response.status === 200) return;
        if (response.status === 409) {
          offset = await readOffset(url);
          return;
        }
        if (response.status === 401 || response.status === 403 || response.status === 413) {
          throw classifyStorageUploadError(response.status, await safeText(response));
        }
        lastError = classifyStorageUploadError(response.status, await safeText(response));
      } catch (err) {
        if (err instanceof CloudError && (err.message === CANCELLED || err.message.includes("權限") || err.message.includes("大小"))) {
          throw err;
        }
        lastError = err instanceof CloudError ? err : new CloudError("網路中斷，可從目前進度繼續", "storage");
      }
    }
    throw lastError;
  }

  return {
    done,
    cancel: () => {
      signal.cancelled = true;
      signal.paused = false;
      state = "cancelled";
      failWait?.(new CloudError(CANCELLED, "storage"));
      resumeWait = null;
      failWait = null;
    },
    pause: () => {
      if (state === "completed" || state === "cancelled") return;
      signal.paused = true;
      state = "paused";
    },
    resume: () => {
      if (state === "completed" || state === "cancelled") return;
      signal.paused = false;
      state = "uploading";
      resumeWait?.();
      resumeWait = null;
      failWait = null;
    },
    retry: () => {
      signal.paused = false;
      if (state === "failed" || state === "paused" || state === "retrying") state = "uploading";
      resumeWait?.();
      resumeWait = null;
      failWait = null;
    },
    getState: () => state,
    getOffset: () => offset,
  };
}

function progressOf(loaded: number, total: number): number {
  if (!total) return 0;
  return Math.min(1, loaded / total);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
