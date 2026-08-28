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
  | {
      action: "import-design";
      roomId: string;
      /** Canva design id — 從清單挑選；bridge 端會驗形狀。 */
      designId: string;
      branchId?: string;
      label?: string;
    };

export type CanvaBridgeHealth = {
  ok: boolean;
  /** 未設定 env 時 false＋此碼；client 以此隱藏整個入口（誠實不可用）。 */
  code?: "CANVA_NOT_CONFIGURED" | "CANVA_UNREACHABLE";
};

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

export type CanvaBridgeImportResult =
  | { ok: true; versionId: string; label: string; fileSize: number }
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
        | "IMPORT_FAILED";
    };

/**
 * 從使用者貼的 Canva 設計網址抽 design id（也接受直接貼 id）。
 * 網址形如 https://www.canva.com/design/DAF.../edit — 第二段就是 id。
 */
export function extractCanvaDesignId(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = /canva\.com\/design\/([A-Za-z0-9_-]{1,80})/.exec(trimmed)?.[1];
  const candidate = fromUrl ?? trimmed;
  return /^[A-Za-z0-9_-]{1,80}$/.test(candidate) ? candidate : null;
}
