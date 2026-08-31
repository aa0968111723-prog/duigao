/**
 * duigao ⇄ canva-bridge（edge function）的請求/回應契約（PR-05 第一階段）。
 *
 * 邊界：
 *  - Canva 的 client id/secret 與使用者 access/refresh token 只活在
 *    canva-bridge 的環境與 service-role 專用表（0020）；client 端只認識
 *    這裡的動作詞彙與布林／匯入結果。
 *  - OAuth 授權在 Canva 官方頁完成（connect-url 開新分頁）；bridge 的
 *    callback 消費 state，client 從不經手 code 或 token。
 */

export type CanvaBridgeRequest =
  | { action: "health" }
  | { action: "status" }
  | { action: "connect-url" }
  | { action: "disconnect" }
  | { action: "list-designs" }
  | { action: "list-pages"; designId: string }
  | {
      action: "import-design";
      roomId: string;
      /** Canva design id — 從清單挑選；bridge 端會驗形狀。 */
      designId: string;
      branchId?: string;
      label?: string;
      /** 1-based page in the same Canva design. Absent = page 1. */
      pageNumber?: number;
      /** Stable page id from list-pages; stored on the version when present. */
      pageId?: string;
    };

export type CanvaBridgeHealth = {
  ok: boolean;
  /** 未設定 env 時 false＋此碼；入口仍可見，只是不能連。 */
  code?: "CANVA_NOT_CONFIGURED" | "CANVA_UNREACHABLE";
};

export type CanvaEntryState = "loading" | "not-configured" | "unreachable" | "connect" | "picker";

/** 內容面板 Canva 三態。health 沒過不准假裝已連。 */
export function canvaEntryState(
  health: CanvaBridgeHealth | null | undefined,
  connected: boolean | null,
): CanvaEntryState {
  if (!health) return "loading";
  if (!health.ok && health.code === "CANVA_NOT_CONFIGURED") return "not-configured";
  if (!health.ok) return "unreachable";
  if (connected) return "picker";
  return "connect";
}

export type CanvaBridgeStatus = { ok: true; connected: boolean } | { ok: false; code: string };

export type CanvaDesignSummary = {
  id: string;
  title: string;
  thumbnailUrl: string;
  updatedAt: number | null;
};

export type CanvaBridgeDesignList =
  | { ok: true; designs: CanvaDesignSummary[] }
  | { ok: false; code: "NOT_CONNECTED" | "CANVA_UNREACHABLE" | "CANVA_NOT_CONFIGURED" };

export type CanvaPageSummary = {
  /** Present when Canva returned a stable page id; otherwise null. */
  id: string | null;
  pageNumber: number;
  thumbnailUrl: string;
};

export type CanvaBridgePageList =
  | { ok: true; pages: CanvaPageSummary[] }
  | {
      ok: false;
      code: "NOT_CONNECTED" | "CANVA_UNREACHABLE" | "CANVA_NOT_CONFIGURED" | "PAGES_UNAVAILABLE" | "INVALID_REQUEST";
    };

export type CanvaBridgeImportResult =
  | { ok: true; versionId: string; label: string; fileSize: number; pageNumber: number; pageId: string | null }
  | {
      ok: false;
      code:
        | "CANVA_NOT_CONFIGURED"
        | "CANVA_UNREACHABLE"
        | "NOT_CONNECTED"
        | "EXPORT_FAILED"
        | "EXPORT_PENDING"
        | "TOO_LARGE"
        | "FORBIDDEN"
        | "ROOM_NOT_FOUND"
        | "IMPORT_FAILED"
        | "INVALID_REQUEST";
    };

export type CanvaDesignRef = {
  designId: string;
  pageNumber?: number;
  pageId?: string;
};

const DESIGN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function isSafeCanvaDesignId(value: string): boolean {
  return DESIGN_ID_RE.test(value);
}

export function isSafeCanvaPageId(value: string): boolean {
  return PAGE_ID_RE.test(value);
}

export function isSafeCanvaPageNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 500;
}

/**
 * 從使用者貼的 Canva 設計網址抽 design id（也接受直接貼 id）。
 * 網址形如 https://www.canva.com/design/DAF.../edit — 第二段就是 id。
 */
export function extractCanvaDesignId(input: string): string | null {
  return parseCanvaDesignRef(input)?.designId ?? null;
}

/**
 * 同一份 Canva 設計的某一頁。page 查詢參數（page / pageNumber）有就帶上；
 * 沒有就只回 design id，匯入端預設第 1 頁。
 */
export function parseCanvaDesignRef(input: string): CanvaDesignRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fromUrl = /canva\.com\/design\/([A-Za-z0-9_-]{1,80})/i.exec(trimmed)?.[1];
  const designId = fromUrl ?? trimmed;
  if (!DESIGN_ID_RE.test(designId)) return null;

  const ref: CanvaDesignRef = { designId };
  try {
    const url = new URL(trimmed);
    const rawPage = url.searchParams.get("page") ?? url.searchParams.get("pageNumber");
    if (rawPage) {
      const pageNumber = Number(rawPage);
      if (isSafeCanvaPageNumber(pageNumber)) ref.pageNumber = pageNumber;
    }
    const rawPageId = url.searchParams.get("pageId") ?? url.searchParams.get("page_id");
    if (rawPageId && isSafeCanvaPageId(rawPageId)) ref.pageId = rawPageId;
  } catch {
    // bare id — no page metadata
  }
  return ref;
}

export function canvaEditUrl(designId: string): string {
  return `https://www.canva.com/design/${designId}/edit`;
}

export function canShowCanvaSync(
  version: { canvaDesignId?: string } | null | undefined,
  canManage: boolean,
): boolean {
  return Boolean(canManage && version?.canvaDesignId);
}
