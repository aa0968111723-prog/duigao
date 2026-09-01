/**
 * 對稿 ⇄ 圖影編輯器（Canva 式）契約。
 *
 * 邊界：
 *  - 對稿自己就是編輯器（#studio / duigao:open-studio）。VITE_STUDIO_ORIGIN 有填才走 iframe /bridge?。
 *  - 匯出永遠是新檔，走既有 onFiles / onVideoFiles，成為房間新版本。
 *  - 原稿不被修改（只標記、不改原稿）。
 *  - 沒有 OAuth、沒有 token；client 只認識 origin + postMessage。
 */

export const STUDIO_SOURCE = "inlay" as const;
export const DUIGAO_SOURCE = "duigao" as const;

export const STUDIO_ENTRY_COPY = {
  "not-configured": "圖影編輯器網址尚未設定。請在環境變數填 VITE_STUDIO_ORIGIN。",
} as const;

export const STUDIO_ENTRY_TESTID = {
  poster: "studio-pick-poster",
  video: "studio-pick-video",
  "not-configured": "studio-entry-not-configured",
} as const;

export type StudioKind = "poster" | "video";

export type OpenStudioDetail = {
  kind: StudioKind;
  name?: string;
  width?: number;
  height?: number;
  roomId?: string;
  embed?: boolean;
  onExport?: (file: File, payload: StudioExportPayload) => void;
  onCancel?: () => void;
};

export type StudioHash = {
  kind: StudioKind;
  name: string;
  embed: boolean;
};

export type StudioExportPayload = {
  kind: StudioKind;
  name: string;
  mime: string;
  filename: string;
  width: number;
  height: number;
  duration?: number;
  dataUrl?: string;
  buffer?: ArrayBuffer;
};

export type StudioToParent =
  | { source: typeof STUDIO_SOURCE; type: "inlay:ready"; payload: { version: 1 } }
  | { source: typeof STUDIO_SOURCE; type: "inlay:export"; payload: StudioExportPayload }
  | { source: typeof STUDIO_SOURCE; type: "inlay:cancel" };

export function resolveStudioOrigin(raw: string | undefined | null): string {
  return (raw ?? "").trim().replace(/\/$/, "");
}

export function isStudioOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function studioOrigin(): string {
  const fromEnv = resolveStudioOrigin(
    (import.meta.env as { VITE_STUDIO_ORIGIN?: string }).VITE_STUDIO_ORIGIN,
  );
  if (isStudioOrigin(fromEnv)) return fromEnv;
  try {
    const stored = resolveStudioOrigin(localStorage.getItem("duigaoStudioOrigin"));
    if (isStudioOrigin(stored)) return stored;
  } catch {
    /* private mode */
  }
  return "";
}

/** 對稿自己就是編輯器，入口永遠可開。VITE_STUDIO_ORIGIN 只決定 iframe 還是原生。 */
export function isStudioConfigured(): boolean {
  return true;
}

/**
 * `#studio` 開原生編輯器。`#room=` 是活動房深鏈，不跟它搶。
 * `#studio?room=` 也讓路，避免鑲入參數誤傷房間連結。
 */
export function parseStudioHash(hash: string | null | undefined): StudioHash | null {
  const raw = String(hash ?? "");
  if (!raw.startsWith("#studio")) return null;
  const rest = raw.slice("#studio".length);
  if (rest && rest[0] !== "?") return null;
  const params = new URLSearchParams(rest.startsWith("?") ? rest.slice(1) : "");
  if (params.has("room")) return null;
  return {
    kind: params.get("kind") === "video" ? "video" : "poster",
    name: params.get("name") ?? "",
    embed: params.get("embed") === "1" || params.get("embed") === "true",
  };
}

export function postStudioToParent(message: StudioToParent, targetOrigin = "*"): void {
  if (typeof window === "undefined") return;
  try {
    window.parent?.postMessage(message, targetOrigin);
  } catch {
    /* ignore */
  }
}

export function isStudioMessage(data: unknown): data is StudioToParent {
  return Boolean(
    data &&
      typeof data === "object" &&
      (data as { source?: string }).source === STUDIO_SOURCE &&
      typeof (data as { type?: string }).type === "string",
  );
}

export function fileFromStudioPayload(payload: StudioExportPayload | null | undefined): File | null {
  if (!payload) return null;
  if (payload.buffer) {
    return new File([payload.buffer], payload.filename || "studio.bin", {
      type: payload.mime || "application/octet-stream",
    });
  }
  if (payload.dataUrl) {
    const comma = payload.dataUrl.indexOf(",");
    const b64 = comma >= 0 ? payload.dataUrl.slice(comma + 1) : payload.dataUrl;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], payload.filename || "studio.png", {
        type: payload.mime || "image/png",
      });
    } catch {
      return null;
    }
  }
  return null;
}

export function openStudio(opts: OpenStudioDetail): { close: () => void } | null {
  if (typeof document === "undefined") return null;
  const origin = studioOrigin();
  if (!isStudioOrigin(origin)) {
    const detail: OpenStudioDetail = {
      kind: opts.kind === "video" ? "video" : "poster",
      name: opts.name,
      width: opts.width,
      height: opts.height,
      roomId: opts.roomId,
      embed: Boolean(opts.embed),
      onExport: opts.onExport,
      onCancel: opts.onCancel,
    };
    window.dispatchEvent(new CustomEvent<OpenStudioDetail>("duigao:open-studio", { detail }));
    return {
      close: () => {
        window.dispatchEvent(new Event("duigao:close-studio"));
      },
    };
  }

  const kind: StudioKind = opts.kind === "video" ? "video" : "poster";
  const params = new URLSearchParams();
  params.set("kind", kind);
  params.set("origin", location.origin);
  if (opts.name) params.set("name", opts.name);
  if (opts.width) params.set("w", String(opts.width));
  if (opts.height) params.set("h", String(opts.height));
  if (opts.roomId) params.set("room", opts.roomId);

  const overlay = document.createElement("div");
  overlay.setAttribute("data-studio-overlay", "");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;background:rgba(13,18,22,0.55);display:flex;flex-direction:column;";
  const iframe = document.createElement("iframe");
  iframe.src = `${origin}/bridge?${params.toString()}`;
  iframe.allow = "clipboard-write";
  iframe.title = "對稿圖影編輯器";
  iframe.style.cssText = "flex:1;width:100%;border:0;background:#fff;";
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);

  const close = () => {
    window.removeEventListener("message", onMessage);
    overlay.remove();
  };

  function onMessage(ev: MessageEvent) {
    if (ev.origin !== origin) return;
    if (!isStudioMessage(ev.data)) return;
    if (ev.data.type === "inlay:ready") {
      try {
        iframe.contentWindow?.postMessage(
          {
            source: DUIGAO_SOURCE,
            type: "duigao:hello",
            payload: { kind, name: opts.name, roomId: opts.roomId },
          },
          origin,
        );
      } catch {
        /* ignore */
      }
    }
    if (ev.data.type === "inlay:export") {
      const file = fileFromStudioPayload(ev.data.payload);
      if (file) opts.onExport?.(file, ev.data.payload);
      close();
    }
    if (ev.data.type === "inlay:cancel") {
      opts.onCancel?.();
      close();
    }
  }

  window.addEventListener("message", onMessage);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      opts.onCancel?.();
      close();
    }
  });

  return { close };
}
