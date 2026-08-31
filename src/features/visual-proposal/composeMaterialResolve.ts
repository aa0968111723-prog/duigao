/**
 * Browser-only: turn a picked room/library material into a canvas-safe data URL.
 * Storage paths / signed URLs must never land on <img src> — they CORS-taint
 * captureComposeStage. Fail honestly; never pretend the layer was placed.
 */
import { isComposeDataUrl, COMPOSE_PLACE_FAIL, type ComposeMaterial, type ComposeMaterialVersion } from "./composeMaterials";
import { prepareImageFile } from "./helpers";

const HUGE_DATA_URL = 2_000_000;

async function dataUrlThroughPrepare(dataUrl: string, name: string): Promise<string> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  if (!blob.size) throw new Error(COMPOSE_PLACE_FAIL);
  if (blob.size <= 12 * 1024 * 1024 && dataUrl.length < HUGE_DATA_URL) return dataUrl;
  const file = new File([blob], `${name || "素材"}.png`, { type: blob.type || "image/png" });
  const prepared = await prepareImageFile(file);
  if (!isComposeDataUrl(prepared.dataUrl)) throw new Error(COMPOSE_PLACE_FAIL);
  return prepared.dataUrl;
}

async function blobToPreparedDataUrl(blob: Blob, name: string): Promise<string> {
  if (!blob.size) throw new Error(COMPOSE_PLACE_FAIL);
  const file = new File([blob], `${name || "素材"}.png`, { type: blob.type || "image/png" });
  const prepared = await prepareImageFile(file);
  if (!isComposeDataUrl(prepared.dataUrl)) throw new Error(COMPOSE_PLACE_FAIL);
  return prepared.dataUrl;
}

export async function resolveComposeMaterialDataUrl(
  material: ComposeMaterial,
  versions: ComposeMaterialVersion[],
  opts?: {
    signedUrlForPath?: (path: string) => Promise<string>;
  },
): Promise<string> {
  const version = material.versionId ? versions.find((item) => item.id === material.versionId) : undefined;
  const raw = version?.imageDataUrl || material.previewUrl || "";
  try {
    if (isComposeDataUrl(raw)) {
      return await dataUrlThroughPrepare(raw, material.title);
    }
    let href = raw;
    if (version?.imagePath && opts?.signedUrlForPath && !/^https?:/i.test(raw)) {
      href = await opts.signedUrlForPath(version.imagePath);
    }
    if (!href || !/^https?:/i.test(href)) {
      throw new Error(COMPOSE_PLACE_FAIL);
    }
    const res = await fetch(href);
    if (!res.ok) throw new Error(COMPOSE_PLACE_FAIL);
    return await blobToPreparedDataUrl(await res.blob(), material.title);
  } catch (err) {
    if (err instanceof Error && err.message === COMPOSE_PLACE_FAIL) throw err;
    throw new Error(COMPOSE_PLACE_FAIL);
  }
}
