import { staticFileList } from "../../components/UniversalIntake";

/** 常見文宣直式。空白／紙底 version 用這張當 files，走既有建立流程拿真正的 versionId。 */
export const COMPOSE_PAPER_WIDTH = 1080;
export const COMPOSE_PAPER_HEIGHT = 1350;
export const COMPOSE_PAPER_COLOR = "#f4f1ea";
export const COMPOSE_PAPER_FILENAME = "紙底.png";
export const COMPOSE_PAPER_LABEL = "紙底";

/**
 * Paper draft is a carrier, not a pickable finished poster.
 * Only explicit COMPOSE_PAPER_* label / filename / data-URL features count.
 * Do not infer from 「初稿」 or canvas emptiness.
 */
export function isComposePaperVersion(version: {
  label?: string;
  filename?: string;
  imageDataUrl?: string;
}): boolean {
  if (version.label === COMPOSE_PAPER_FILENAME || version.label === COMPOSE_PAPER_LABEL) return true;
  if (version.filename === COMPOSE_PAPER_FILENAME || version.filename === COMPOSE_PAPER_LABEL) return true;
  const url = version.imageDataUrl ?? "";
  return url.includes(COMPOSE_PAPER_FILENAME) || url.includes(COMPOSE_PAPER_LABEL);
}

/**
 * 前端生一張固定比例紙底 PNG。這不是成品，只是為了讓既有
 * createBranch + addVersion 路徑拿到一個不會被之後「存成新版本」覆蓋的初稿。
 */
export async function makeComposePaperFile(
  width = COMPOSE_PAPER_WIDTH,
  height = COMPOSE_PAPER_HEIGHT,
  color = COMPOSE_PAPER_COLOR,
): Promise<File> {
  if (typeof document === "undefined") {
    throw new Error("紙底只能在瀏覽器裡產生。");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("這台裝置畫不出紙底，請改上傳成品。");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob || blob.size < 32) throw new Error("紙底是空的，沒有建立文宣。");
  return new File([blob], COMPOSE_PAPER_FILENAME, { type: "image/png" });
}

export async function makeComposePaperList(): Promise<FileList> {
  const file = await makeComposePaperFile();
  return staticFileList([file]);
}
