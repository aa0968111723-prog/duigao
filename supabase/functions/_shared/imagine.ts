/**
 * Grok Imagine request/response helpers.
 * Image/video land in proposal Storage (`rooms/.../proposals/...`), never
 * `rooms/.../versions/...`. Video generation is refused until the UI confirms 估價.
 */
import { asObject, asText } from "./roomContext.ts";

export const IMAGINE_IMAGE_URL = "https://api.x.ai/v1/images/generations";
export const IMAGINE_VIDEO_URL = "https://api.x.ai/v1/videos/generations";
export const DEFAULT_IMAGE_MODEL = "grok-imagine-image";
export const DEFAULT_VIDEO_MODEL = "grok-imagine-video";

export type ImagineFetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

export function imagineImageRequest(input: { prompt: string; size?: string; model?: string }): { url: string; body: Record<string, unknown> } {
  return {
    url: IMAGINE_IMAGE_URL,
    body: {
      model: (input.model || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL,
      prompt: input.prompt.slice(0, 4000),
      n: 1,
      response_format: "b64_json",
      ...(input.size ? { size: input.size } : {}),
    },
  };
}

export function imagineVideoRequest(input: { prompt: string; seconds?: number; resolution?: string; model?: string }): { url: string; body: Record<string, unknown> } {
  const seconds = Math.max(1, Math.min(15, Math.floor(input.seconds ?? 6)));
  const resolution = input.resolution === "480p" ? "480p" : "720p";
  return {
    url: IMAGINE_VIDEO_URL,
    body: {
      model: (input.model || DEFAULT_VIDEO_MODEL).trim() || DEFAULT_VIDEO_MODEL,
      prompt: input.prompt.slice(0, 4000),
      duration: seconds,
      resolution,
    },
  };
}

export function imagineWorkLayerPath(roomId: string, proposalId: string, assetId: string, ext: string): string {
  return `rooms/${roomId}/proposals/${proposalId}/${assetId}.${ext}`;
}

export function pathTouchesVersionOriginal(path: string): boolean {
  return /\/versions\//.test(path);
}

function looksLikeHtml(body: string, contentType: string | null): boolean {
  if (contentType && /text\/html/i.test(contentType)) return true;
  return /^\s*<(!doctype\s+html|html[\s>])/i.test(body);
}

function b64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/^data:[^,]+,/, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function parseImagineImageResponse(raw: unknown): { bytes: Uint8Array; mime: string } | { error: string } {
  const data = asObject(raw);
  const rows = Array.isArray(data.data) ? data.data : [];
  const first = asObject(rows[0]);
  const b64 = asText(first.b64_json || first.b64);
  if (b64) return { bytes: b64ToBytes(b64), mime: "image/png" };
  const url = asText(first.url);
  if (url && /^https:\/\//i.test(url) && !/invite/i.test(url)) return { error: `url:${url}` };
  return { error: "IMAGINE_EMPTY" };
}

export async function executeImagineImage(input: {
  prompt: string;
  size?: string;
  model?: string;
  apiKey: string;
  fetchFn?: ImagineFetch;
}): Promise<{ ok: true; bytes: Uint8Array; mime: string; model: string } | { ok: false; refused?: boolean; error: string }> {
  const req = imagineImageRequest({ prompt: input.prompt, size: input.size, model: input.model });
  const fetchFn = input.fetchFn ?? (fetch as ImagineFetch);
  const response = await fetchFn(req.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify(req.body),
  });
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  if (looksLikeHtml(text, contentType)) return { ok: false, error: "SPA_HTML" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "INVALID_PAYLOAD" }; }
  const image = parseImagineImageResponse(parsed);
  if ("error" in image && image.error.startsWith("url:")) {
    const url = image.error.slice(4);
    const downloaded = await fetchFn(url, { method: "GET" });
    const buf = downloaded.arrayBuffer ? await downloaded.arrayBuffer() : undefined;
    if (!buf) return { ok: false, error: "IMAGINE_EMPTY" };
    return { ok: true, bytes: new Uint8Array(buf), mime: downloaded.headers.get("content-type") || "image/png", model: asText(req.body.model) };
  }
  if ("error" in image) return { ok: false, error: image.error };
  return { ok: true, bytes: image.bytes, mime: image.mime, model: asText(req.body.model) };
}

export async function executeImagineVideo(input: {
  prompt: string;
  seconds?: number;
  resolution?: string;
  model?: string;
  apiKey: string;
  confirmed: boolean;
  fetchFn?: ImagineFetch;
}): Promise<{ ok: true; bytes: Uint8Array; mime: string; model: string } | { ok: false; refused?: boolean; error: string }> {
  if (!input.confirmed) {
    return { ok: false, refused: true, error: "生影前必須先確認估價。" };
  }
  const req = imagineVideoRequest({
    prompt: input.prompt,
    seconds: input.seconds,
    resolution: input.resolution,
    model: input.model,
  });
  const fetchFn = input.fetchFn ?? (fetch as ImagineFetch);
  const response = await fetchFn(req.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify(req.body),
  });
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  if (looksLikeHtml(text, contentType)) return { ok: false, error: "SPA_HTML" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "INVALID_PAYLOAD" }; }
  const data = asObject(parsed);
  const url = asText(data.url || asObject(Array.isArray(data.data) ? data.data[0] : {}).url);
  if (!url || !/^https:\/\//i.test(url)) return { ok: false, error: "IMAGINE_EMPTY" };
  const downloaded = await fetchFn(url, { method: "GET" });
  const buf = downloaded.arrayBuffer ? await downloaded.arrayBuffer() : undefined;
  if (!buf) return { ok: false, error: "IMAGINE_EMPTY" };
  return { ok: true, bytes: new Uint8Array(buf), mime: downloaded.headers.get("content-type") || "video/mp4", model: asText(req.body.model) };
}

function extForImagineMime(mime: string): string {
  if (/mp4|video/i.test(mime)) return "mp4";
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  return "png";
}

export async function storeImagineAsset(input: {
  roomId: string;
  bytes: Uint8Array;
  mime: string;
  upload: (path: string, bytes: Uint8Array, mime: string) => Promise<{ error?: string }>;
  idFn?: () => string;
}): Promise<{ ok: true; proposalId: string; assetId: string; path: string } | { ok: false; error: string }> {
  const idFn = input.idFn ?? (() => crypto.randomUUID());
  const proposalId = idFn();
  const assetId = idFn();
  const path = imagineWorkLayerPath(input.roomId, proposalId, assetId, extForImagineMime(input.mime));
  if (pathTouchesVersionOriginal(path)) return { ok: false, error: "VERSION_PATH" };
  const uploaded = await input.upload(path, input.bytes, input.mime);
  if (uploaded.error) return { ok: false, error: uploaded.error };
  return { ok: true, proposalId, assetId, path };
}
