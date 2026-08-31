/**
 * Room-asset list for poster compose. Pure: versions + library rows in,
 * pickable materials out. No DOM. Library rows store no bytes — pick
 * resolves a version's imageDataUrl / Storage object later.
 */
import { isComposePaperVersion } from "./composePaper";
import { createImageItem } from "./helpers";
import type { ProposalImageItem, VisualProposal } from "./store";

export type ComposeMaterialKind = "version" | "library";

export type ComposeMaterial = {
  id: string;
  title: string;
  kind: ComposeMaterialKind;
  versionId?: string;
  libraryId?: string;
  previewUrl: string;
  sourceLabel: string;
};

export type ComposeMaterialVersion = {
  id: string;
  label: string;
  imageDataUrl: string;
  kind?: string;
  filename?: string;
  archivedAt?: string;
  imagePath?: string;
};

export type ComposeMaterialLibrary = {
  id: string;
  title: string;
  kind: string;
  linkedVersionId?: string;
  linkedAssetId?: string;
};

export const COMPOSE_SOURCE_VERSION = "房間文宣";
export const COMPOSE_SOURCE_LIBRARY = "素材庫";
export const COMPOSE_PLACE_FAIL = "這張圖暫時沒辦法放到畫布，請改現傳。";

export function isComposeDataUrl(value: string): boolean {
  return /^data:image\//i.test(value);
}

export function isImageClassVersion(version: ComposeMaterialVersion): boolean {
  if (version.archivedAt) return false;
  if (version.kind === "video") return false;
  return true;
}

export function isImageClassLibrary(row: ComposeMaterialLibrary): boolean {
  return row.kind === "image" || row.kind === "poster";
}

function previewFor(
  version: ComposeMaterialVersion,
  previewUrlFor?: (version: ComposeMaterialVersion) => string | undefined,
): string {
  if (isComposeDataUrl(version.imageDataUrl)) return version.imageDataUrl;
  return previewUrlFor?.(version) ?? "";
}

export function listComposeMaterials(input: {
  versions: ComposeMaterialVersion[];
  library: ComposeMaterialLibrary[];
  editingVersionId?: string;
  previewUrlFor?: (version: ComposeMaterialVersion) => string | undefined;
}): ComposeMaterial[] {
  const versionsById = new Map(input.versions.map((version) => [version.id, version]));
  const claimed = new Set<string>();
  const out: ComposeMaterial[] = [];

  for (const row of input.library) {
    if (!isImageClassLibrary(row)) continue;
    const version = row.linkedVersionId ? versionsById.get(row.linkedVersionId) : undefined;
    if (!version || !isImageClassVersion(version)) continue;
    if (input.editingVersionId && version.id === input.editingVersionId) continue;
    if (isComposePaperVersion(version)) continue;
    if (claimed.has(version.id)) continue;
    claimed.add(version.id);
    out.push({
      id: `lib:${row.id}`,
      title: row.title,
      kind: "library",
      versionId: version.id,
      libraryId: row.id,
      previewUrl: previewFor(version, input.previewUrlFor),
      sourceLabel: COMPOSE_SOURCE_LIBRARY,
    });
  }

  for (const version of input.versions) {
    if (!isImageClassVersion(version)) continue;
    if (input.editingVersionId && version.id === input.editingVersionId) continue;
    if (isComposePaperVersion(version)) continue;
    if (claimed.has(version.id)) continue;
    claimed.add(version.id);
    out.push({
      id: `ver:${version.id}`,
      title: version.label,
      kind: "version",
      versionId: version.id,
      previewUrl: previewFor(version, input.previewUrlFor),
      sourceLabel: COMPOSE_SOURCE_VERSION,
    });
  }

  return out;
}

/**
 * Place a resolved data URL as a new layer. Never writes a versions row
 * and never mutates versions[].imageDataUrl.
 */
export function placeComposeMaterial(
  doc: VisualProposal,
  material: ComposeMaterial,
  dataUrl: string,
): { ok: true; item: ProposalImageItem; doc: VisualProposal } | { ok: false; reason: string } {
  if (!isComposeDataUrl(dataUrl) || dataUrl.length < 32) {
    return { ok: false, reason: COMPOSE_PLACE_FAIL };
  }
  const item = createImageItem(dataUrl, material.title);
  return {
    ok: true,
    item,
    doc: { ...doc, items: [...doc.items, item], updatedAt: Date.now() },
  };
}
