/**
 * 對稿留言素材：圖片／影片／檔案走 attachments 路徑，不走 versions／加一版。
 */

export const COMMENT_MEDIA_ACCEPT =
  "image/*,video/*,application/pdf,audio/*,.docx,.pptx,.xlsx,.txt,.csv,.zip,.json,application/json";

export const COMMENT_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export type CommentAttachKind = "image" | "video" | "file";

export type CommentAttachDraft = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: CommentAttachKind;
  previewUrl?: string;
  file: File;
};

export type CommentAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: CommentAttachKind;
  path: string;
  previewUrl?: string;
};

export function commentAttachKind(mime: string, name = ""): CommentAttachKind {
  const lower = `${mime} ${name}`.toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return "image";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(name)) return "video";
  if (lower.includes("application/pdf") || name.toLowerCase().endsWith(".pdf")) return "file";
  return "file";
}

export function canSubmitPin(form: { body?: string; attachments?: { id: string }[] | null }): boolean {
  return Boolean(form.body?.trim()) || Boolean(form.attachments?.length);
}

export function pinBodyForCommit(form: { body?: string; attachments?: { name?: string }[] | null }): string {
  const body = form.body?.trim() ?? "";
  if (body) return body;
  const first = form.attachments?.[0]?.name?.trim();
  return first || "附件";
}

export function draftsFromFiles(files: FileList | File[] | null): CommentAttachDraft[] {
  if (!files) return [];
  const list = Array.from(files);
  return list.map((file) => {
    const kind = commentAttachKind(file.type, file.name);
    const draft: CommentAttachDraft = {
      id: `att_${Math.random().toString(36).slice(2, 10)}`,
      name: file.name || (kind === "image" ? "圖片" : kind === "video" ? "影片" : "附件"),
      mime: file.type || "application/octet-stream",
      size: file.size,
      kind,
      file,
    };
    if (kind === "image" || kind === "video") {
      try {
        draft.previewUrl = URL.createObjectURL(file);
      } catch {
        /* old webview */
      }
    }
    return draft;
  });
}

export function revokeAttachPreview(draft: { previewUrl?: string }): void {
  if (draft.previewUrl?.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(draft.previewUrl);
    } catch {
      /* ignore */
    }
  }
}
