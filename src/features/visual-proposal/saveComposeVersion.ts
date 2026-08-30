/**
 * 「存成新版本」的純規則：永遠 append，禁止覆蓋舊 version 的 id / 圖。
 * 討論釘打在 versionId 上；新版出現時舊版待處理數必須還在。
 */
import { uid } from "../../lib/id";
import { VERSION_LABELS } from "../../lib/types";
import type { VisualProposal, ProposalItem } from "./store";

export type VersionIdentity = {
  id: string;
  label: string;
  imageDataUrl: string;
  /** Cloud Storage path when known. Local-only rooms may omit it. */
  imagePath?: string;
};

export function nextPosterVersionLabel(existingCount: number): string {
  return VERSION_LABELS[existingCount] ?? `改${existingCount}`;
}

export function composeHasContent(doc: VisualProposal | null | undefined): boolean {
  if (!doc) return false;
  if (doc.items.some((item) => item.visible)) return true;
  if (doc.background.imageDataUrl) return true;
  if (doc.background.colorOpacity > 0) return true;
  if (doc.background.gradient !== "none" && doc.background.gradientOpacity > 0) return true;
  return false;
}

export function canSaveComposeVersion(doc: VisualProposal | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (!composeHasContent(doc)) {
    return { ok: false, reason: "畫布還是空的，先丟一張圖或加文字再存成新版本。" };
  }
  return { ok: true };
}

function itemPrefix(type: ProposalItem["type"]): string {
  return type === "text" ? "vpt_" : type === "image" ? "vpi_" : "vps_";
}

/** 複製工作層到新 versionId。舊 version 的提案列原封不動。 */
export function cloneProposalDocsToVersion(
  docs: VisualProposal[],
  fromVersionId: string,
  toVersionId: string,
): VisualProposal[] {
  if (fromVersionId === toVersionId) return docs;
  const now = Date.now();
  const copies = docs
    .filter((doc) => doc.versionId === fromVersionId)
    .map((doc) => ({
      ...doc,
      id: uid("vp_"),
      versionId: toVersionId,
      items: doc.items.map((item) => ({ ...item, id: uid(itemPrefix(item.type)) })),
      background: { ...doc.background },
      supports: [...doc.supports],
      comments: [...doc.comments],
      createdAt: now,
      updatedAt: now,
    }));
  return [...docs, ...copies];
}

/**
 * Append a new version. Existing rows are not mutated — id and storage path stay.
 * 空檔禁止寫入。
 */
export function appendVersionWithoutOverwrite(
  versions: VersionIdentity[],
  next: VersionIdentity,
): { ok: true; versions: VersionIdentity[] } | { ok: false; reason: string } {
  if (!next.id || versions.some((v) => v.id === next.id)) {
    return { ok: false, reason: "新版本 id 不能跟舊的一樣，原稿不會被覆蓋。" };
  }
  if (!next.imageDataUrl || next.imageDataUrl.length < 32) {
    return { ok: false, reason: "匯出是空的，沒有存成新版本。" };
  }
  return { ok: true, versions: [...versions, next] };
}

export function versionIdentitiesUnchanged(
  before: VersionIdentity[],
  after: VersionIdentity[],
  oldId: string,
): boolean {
  const prev = before.find((v) => v.id === oldId);
  const next = after.find((v) => v.id === oldId);
  if (!prev || !next) return false;
  return prev.id === next.id && prev.imageDataUrl === next.imageDataUrl && prev.imagePath === next.imagePath;
}

export async function captureComposeStage(): Promise<Blob> {
  const stage = document.querySelector("[data-testid='poster-compose-stage']") as HTMLElement | null;
  if (!stage) throw new Error("找不到畫布，請回到文宣再試一次。");
  stage.classList.add("is-exporting");
  try {
    const { domToBlob } = await import("modern-screenshot");
    const blob = await domToBlob(stage, { type: "image/png", scale: 2 });
    if (!blob || blob.size < 32) throw new Error("匯出是空的，沒有存成新版本。");
    return blob;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/taint|insecure|cors/i.test(text)) {
      throw new Error("這張圖暫時無法匯出，請重新上傳。");
    }
    if (err instanceof Error) throw err;
    throw new Error("匯出失敗，請再試一次。");
  } finally {
    stage.classList.remove("is-exporting");
  }
}
