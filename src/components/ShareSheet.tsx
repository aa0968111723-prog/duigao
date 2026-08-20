import { useState, type ReactNode } from "react";
import { ModalSheet } from "./BottomSheet";
import type { ShowToast } from "../toast";

/**
 * How the LINE / Messenger card for this link is doing (PR #21). It is an
 * enhancement layered on top of an already-working share URL, so every state
 * here — including the failures — still leaves the sheet fully usable.
 */
export type SharePreviewState =
  | { status: "building" }
  /** A clean poster thumbnail is live on the card. */
  | { status: "on"; thumbnailUrl: string }
  /** The user turned the poster off: the card falls back to the brand cover. */
  | { status: "off" }
  /** No card this time. The permanent share link is unaffected. */
  | { status: "unavailable" };

/**
 * What the share sheet is allowed to show. Only `ready` carries a URL that
 * survives the host closing the page — every failure path is URL-less by
 * design, so a legacy `#room=<6碼>` link can never be handed out as if it were
 * a permanent share link (PR #16).
 */
export type ShareState =
  | { kind: "creating" }
  /**
   * `url` is what the user copies: the preview landing page once one exists,
   * otherwise `appUrl`. Both carry the same `#room=…&invite=…` fragment.
   */
  | { kind: "ready"; url: string; appUrl: string; preview: SharePreviewState }
  /** Cloud room creation failed: retry, never a fallback link. */
  | { kind: "failed" }
  /** Production build without Supabase env — the deployment cannot share. */
  | { kind: "unavailable" }
  /** Opened through an old link, so this device has no room of its own to share. */
  | { kind: "legacy-guest" }
  /** Dev-only local mode: a temporary link that needs this page to stay open. */
  | { kind: "local"; url: string };

type Props = {
  title: string;
  state: ShareState;
  onRetry: () => void;
  onClose: () => void;
  onToast: ShowToast;
  /** Turn the poster thumbnail on the social card on or off. */
  onPreviewThumbnail: (next: boolean) => void;
  /** Revoke the current preview link and mint a new one. */
  onRotatePreview: () => void;
};

function Note({ children }: { children: ReactNode }) {
  return <p className="m-share-note">{children}</p>;
}

/**
 * 連結預覽 — one thumbnail, one toggle, one line of plain-language privacy.
 * Deliberately no size / quality / OpenGraph / cache knobs: the person sharing
 * a poster wants to know what LINE will show, not how it was encoded.
 */
function PreviewBlock({
  title,
  preview,
  onPreviewThumbnail,
  onRotatePreview,
}: {
  title: string;
  preview: SharePreviewState;
  onPreviewThumbnail: (next: boolean) => void;
  onRotatePreview: () => void;
}) {
  const [more, setMore] = useState(false);
  const busy = preview.status === "building";
  const on = preview.status === "on";

  if (preview.status === "unavailable") {
    return (
      <section className="m-share-preview" aria-label="連結預覽">
        <span className="m-share-preview-label">連結預覽</span>
        <Note>這次沒有產生連結預覽，但分享連結仍可使用。</Note>
      </section>
    );
  }

  return (
    <section className="m-share-preview" aria-label="連結預覽">
      <span className="m-share-preview-label">連結預覽</span>
      <div className="m-share-preview-card">
        {on ? (
          <img className="m-share-preview-thumb" src={preview.thumbnailUrl} alt={`${title} 的連結預覽縮圖`} />
        ) : (
          <div className="m-share-preview-thumb is-generic" aria-hidden>
            {busy ? "準備中…" : "文宣討論區"}
          </div>
        )}
        <strong className="m-share-preview-title">{title}</strong>
      </div>
      <label className="m-share-toggle">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => onPreviewThumbnail(e.target.checked)}
        />
        <span>顯示文宣縮圖</span>
      </label>
      <Note>
        {on
          ? "開啟後，分享平台會看到一張低解析度文宣預覽。"
          : "關閉時，分享平台只會看到「文宣討論區」的通用封面。"}
      </Note>
      {more ? (
        <button type="button" className="m-row" onClick={onRotatePreview} disabled={busy}>
          重新產生預覽連結（舊連結不再顯示文宣）
        </button>
      ) : (
        <button type="button" className="m-link m-share-more" onClick={() => setMore(true)}>
          更多
        </button>
      )}
    </section>
  );
}

/** Share is a bottom sheet on every size: copy, LINE, or the OS share sheet. */
export function ShareSheet({ title, state, onRetry, onClose, onToast, onPreviewThumbnail, onRotatePreview }: Props) {
  const [copied, setCopied] = useState(false);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  if (state.kind === "creating") {
    return (
      <ModalSheet title="分享給夥伴" onClose={onClose}>
        <div className="m-more">
          <Note>正在建立分享連結…</Note>
        </div>
      </ModalSheet>
    );
  }

  if (state.kind === "failed") {
    return (
      <ModalSheet title="分享給夥伴" onClose={onClose}>
        <div className="m-more">
          <Note>暫時無法建立分享連結，請稍後再試。</Note>
          <Note>目前的內容都保存在這台裝置，不會不見。連上線後再試一次就能建立。</Note>
          <button type="button" className="m-row m-row-primary" onClick={onRetry}>
            再試一次
          </button>
        </div>
      </ModalSheet>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <ModalSheet title="分享給夥伴" onClose={onClose}>
        <div className="m-more">
          <Note>分享服務目前無法使用，暫時沒辦法建立分享連結。</Note>
          <Note>內容都保存在這台裝置。請聯絡維護的人確認服務設定後再分享。</Note>
        </div>
      </ModalSheet>
    );
  }

  if (state.kind === "legacy-guest") {
    return (
      <ModalSheet title="分享給夥伴" onClose={onClose}>
        <div className="m-more">
          <Note>這是舊版分享連結，沒辦法從這裡再分享出去。</Note>
          <Note>請向主辦方取得新版分享連結，新版連結在主辦方關掉頁面後也打得開。</Note>
        </div>
      </ModalSheet>
    );
  }

  const url = state.url;
  const permanent = state.kind === "ready";
  const inviteText = `幫我看一下這張文宣「${title}」，點需要調整的位置留一句話就可以，不用改原稿 🙏`;
  const lineUrl = `https://line.me/R/msg/text/?${encodeURIComponent(`${inviteText}\n${url}`)}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      onToast("分享連結已複製", { tone: "success" });
      window.setTimeout(onClose, 700);
    } catch {
      setCopied(false);
      onToast("複製失敗，請長按下方連結手動複製。", { tone: "error" });
    }
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title, text: inviteText, url });
      onClose();
    } catch {
      /* the user dismissed the OS sheet */
    }
  };

  return (
    <ModalSheet title="分享給夥伴" onClose={onClose}>
      <div className="m-more">
        <Note>
          {permanent
            ? "分享連結已建立，主辦方不用保持頁面開著。夥伴打開連結、輸入名字就能一起看。"
            : "本機測試連結：需要這台裝置保持頁面開著，夥伴才連得上。"}
        </Note>
        <button type="button" className="m-row m-row-primary" onClick={copy}>
          {copied ? "已複製連結" : "複製連結"}
        </button>
        <a className="m-row m-row-line" href={lineUrl} target="_blank" rel="noreferrer" onClick={onClose}>
          傳到 LINE
        </a>
        {canNativeShare && (
          <button type="button" className="m-row" onClick={nativeShare}>
            其他方式分享
          </button>
        )}
        {/* Above the raw URL: seeing what LINE will show matters more than the
            link text, but the two primary actions still come first. */}
        {state.kind === "ready" && (
          <PreviewBlock
            title={title}
            preview={state.preview}
            onPreviewThumbnail={onPreviewThumbnail}
            onRotatePreview={onRotatePreview}
          />
        )}
        <input className="m-input m-share-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      </div>
    </ModalSheet>
  );
}
