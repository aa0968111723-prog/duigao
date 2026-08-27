import { INTAKE_PROFILES } from "./UniversalIntake";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ModalSheet } from "./BottomSheet";
import type { ShowToast } from "../toast";
import type { CoverSource, SharePresentation } from "../lib/sharePresentation";

/**
 * How the LINE / Messenger card for this link is doing (PR #21, race-fixed in
 * PR #30).
 *
 * `building` is the state that used to be a lie. The sheet showed the permanent
 * app URL the instant the room existed, while the card was still being built —
 * so a host who tapped 傳到 LINE straight away sent
 * `https://app/#room=…&invite=…`, which no crawler can turn into a card, and
 * LINE showed the generic cover. The room had a perfectly good poster frame and
 * a perfectly good preview row; the URL simply left before they were ready.
 *
 * So `building` now means "not shareable yet", and the sheet enforces it.
 */
export type SharePreviewState =
  | { status: "building" }
  /** A clean poster / poster-frame thumbnail is live on the card. */
  | { status: "on"; thumbnailUrl: string }
  /** No cover on the card: the platform falls back to the brand cover. */
  | { status: "off" }
  /** No card this time. The permanent share link is unaffected. */
  | { status: "unavailable" };

/** What the card currently says — the SHARE's own title, not the room's. */
export type ShareCard = {
  title: string;
  description: string;
  coverSource: CoverSource;
  titleCustomized: boolean;
  descriptionCustomized: boolean;
};

/** An edit to the card. `null` clears a customisation back to the default. */
export type ShareCustomization = {
  title?: string | null;
  description?: string | null;
  coverSource?: CoverSource;
  customCover?: Blob;
};

/**
 * What the share sheet is allowed to show. Only `ready` carries a URL that
 * survives the host closing the page — every failure path is URL-less by
 * design, so a legacy `#room=<6碼>` link can never be handed out as if it were
 * a permanent share link (PR #16).
 */
export type ShareState =
  | { kind: "creating" }
  /**
   * `url` is what the user shares: the preview landing page once one exists,
   * otherwise `appUrl`. Both carry the same `#room=…&invite=…` fragment, and
   * while `preview.status` is "building" NEITHER is handed out.
   */
  | { kind: "ready"; url: string; appUrl: string; preview: SharePreviewState; card: ShareCard | null }
  /** Cloud room creation failed: retry, never a fallback link. */
  | { kind: "failed" }
  /** Production build without Supabase env — the deployment cannot share. */
  | { kind: "unavailable" }
  /** Opened through an old link, so this device has no room of its own to share. */
  | { kind: "legacy-guest" }
  /** Dev-only local mode: a temporary link that needs this page to stay open. */
  | { kind: "local"; url: string };

type Props = {
  /**
   * Every string that depends on 文宣 vs 影片, resolved once by the caller —
   * including `defaultTitle`, which is the ROOM's name. The sheet never reads
   * the room directly: what travels is the CARD's title, and the two are
   * allowed to differ.
   */
  presentation: SharePresentation;
  state: ShareState;
  onRetry: () => void;
  onClose: () => void;
  onToast: ShowToast;
  /** Turn the cover on the social card on or off. */
  onPreviewThumbnail: (next: boolean) => void;
  /** Revoke the current preview link and mint a new one. */
  onRotatePreview: () => void;
  /** Write card-only changes. Never touches the room or the original media. */
  onCustomize: (patch: ShareCustomization) => void;
};

// 中央 intake registry 是 accept 白名單的單一真相（DOM 保持凍結不換元件）。
const COVER_ACCEPT = INTAKE_PROFILES["share-cover"].accept;

function Note({ children }: { children: ReactNode }) {
  return <p className="m-share-note">{children}</p>;
}

/* ------------------------------------------------------------- 連結預覽 -- */

/**
 * 連結預覽 — one thumbnail, one toggle, one line of plain-language privacy.
 * Deliberately no size / quality / OpenGraph / cache knobs: the person sharing
 * a poster wants to know what LINE will show, not how it was encoded.
 */
function PreviewBlock({
  presentation,
  cardTitle,
  preview,
  onPreviewThumbnail,
}: {
  presentation: SharePresentation;
  cardTitle: string;
  preview: SharePreviewState;
  onPreviewThumbnail: (next: boolean) => void;
}) {
  const busy = preview.status === "building";
  const on = preview.status === "on";

  if (preview.status === "unavailable") {
    return (
      <section className="m-share-preview" aria-label="連結預覽">
        <span className="m-share-preview-label">連結預覽</span>
        <Note>這次沒有產生預覽縮圖，但分享連結仍可使用。</Note>
      </section>
    );
  }

  return (
    <section className="m-share-preview" aria-label="連結預覽">
      <span className="m-share-preview-label">連結預覽</span>
      <div className="m-share-preview-card">
        {on ? (
          <img className="m-share-preview-thumb" src={preview.thumbnailUrl} alt={`${cardTitle} 的連結預覽縮圖`} />
        ) : (
          <div className="m-share-preview-thumb is-generic" aria-hidden>
            {busy ? "準備中…" : presentation.brand}
          </div>
        )}
        <strong className="m-share-preview-title">{cardTitle}</strong>
      </div>
      <label className="m-share-toggle">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => onPreviewThumbnail(e.target.checked)}
        />
        <span>{presentation.thumbnailLabel}</span>
      </label>
      <Note>{on ? presentation.privacyCopy : presentation.privacyOffCopy}</Note>
    </section>
  );
}

/* -------------------------------------------------------- 自訂分享內容 -- */

/**
 * Progressive disclosure, collapsed by default: most shares never open this.
 * Everything inside writes to the CARD only — 分享自訂 ≠ 改房間. The room keeps
 * its name, the version keeps its image, the video keeps its poster frame.
 */
function CustomizeBlock({
  presentation,
  card,
  busy,
  onCustomize,
  onToast,
}: {
  presentation: SharePresentation;
  card: ShareCard;
  busy: boolean;
  onCustomize: (patch: ShareCustomization) => void;
  onToast: ShowToast;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // The row is the source of truth: a save, a reset or a reopen on another
  // device must show what the cloud actually holds, not a stale local draft.
  // Only re-sync while the fields are not being edited, so a save in flight
  // cannot yank the caret out of a half-typed title.
  const saved = useRef({ title: card.title, description: card.description });
  useEffect(() => {
    if (saved.current.title !== card.title) {
      saved.current.title = card.title;
      setTitle(card.title);
    }
    if (saved.current.description !== card.description) {
      saved.current.description = card.description;
      setDescription(card.description);
    }
  }, [card.title, card.description]);

  const dirty = title.trim() !== card.title.trim() || description.trim() !== card.description.trim();

  const save = () => {
    onCustomize({ title: title.trim() || null, description: description.trim() || null });
  };

  const pickCover = (file: File | null) => {
    if (!file) return;
    if (!COVER_ACCEPT.split(",").includes(file.type)) {
      onToast("封面只支援 JPG、PNG 或 WebP 圖片。", { tone: "error" });
      return;
    }
    onCustomize({ coverSource: "custom", customCover: file });
  };

  const coverOptions: { value: CoverSource; label: string }[] = [
    { value: "auto", label: presentation.coverAutoLabel },
    { value: "custom", label: "上傳自訂封面" },
    { value: "none", label: "不顯示封面" },
  ];

  if (!open) {
    return (
      <button type="button" className="m-link m-share-more" onClick={() => setOpen(true)}>
        自訂分享內容
      </button>
    );
  }

  return (
    <section className="m-share-custom" aria-label={`自訂${presentation.sectionTitle}內容`}>
      <div className="m-share-custom-head">
        <span className="m-share-preview-label">自訂分享內容</span>
        <button type="button" className="m-link" onClick={() => setOpen(false)}>
          收合
        </button>
      </div>
      <Note>只會改分享出去的卡片，不會改到房間名稱或原始檔案。</Note>

      <label className="m-share-field">
        <span>分享標題</span>
        <input
          className="m-input"
          value={title}
          maxLength={70}
          placeholder={presentation.titlePlaceholder}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label className="m-share-field">
        <span>分享說明</span>
        <textarea
          className="m-input m-share-textarea"
          value={description}
          maxLength={160}
          rows={3}
          placeholder={presentation.defaultDescription}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <button
        type="button"
        className="m-row m-row-primary m-share-save"
        disabled={busy || !dirty}
        onClick={save}
      >
        {dirty ? "儲存分享內容" : "已儲存"}
      </button>

      <div className="m-share-field">
        <span>分享封面</span>
        <div className="m-share-covers" role="radiogroup" aria-label="分享封面">
          {coverOptions.map((opt) => (
            <label key={opt.value} className="m-share-toggle">
              <input
                type="radio"
                name="m-share-cover"
                value={opt.value}
                checked={card.coverSource === opt.value}
                disabled={busy}
                onChange={() => {
                  if (opt.value === "custom") fileRef.current?.click();
                  else onCustomize({ coverSource: opt.value });
                }}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
        <input
          ref={fileRef}
          className="m-share-file"
          type="file"
          accept={COVER_ACCEPT}
          onChange={(e) => {
            pickCover(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
        {card.coverSource === "custom" && (
          <button
            type="button"
            className="m-link m-share-more"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            換一張自訂封面
          </button>
        )}
      </div>

      <button
        type="button"
        className="m-row"
        disabled={busy}
        onClick={() => onCustomize({ title: null, description: null, coverSource: "auto" })}
      >
        恢復預設
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------ 主體 -- */

/** Share is a bottom sheet on every size: copy, LINE, or the OS share sheet. */
export function ShareSheet({
  presentation,
  state,
  onRetry,
  onClose,
  onToast,
  onPreviewThumbnail,
  onRotatePreview,
  onCustomize,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [acceptedNoCard, setAcceptedNoCard] = useState(false);
  const [more, setMore] = useState(false);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  // Acknowledging "this one will have no thumbnail" covers THIS attempt only.
  // Every new build starts the sheet honest again, so a later failure cannot
  // ride out on a consent the host gave for a different card.
  const previewStatus = state.kind === "ready" ? state.preview.status : null;
  useEffect(() => {
    if (previewStatus === "building") setAcceptedNoCard(false);
  }, [previewStatus]);

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

  const permanent = state.kind === "ready";
  const preview: SharePreviewState | null = state.kind === "ready" ? state.preview : null;
  const card = state.kind === "ready" ? state.card : null;

  /**
   * THE RACE FIX.
   *
   * While the card is still being built there is exactly one URL available —
   * the plain app URL — and handing it over is the bug this whole PR exists to
   * close. So nothing that sends a link is offered until either the preview URL
   * is ready, or the host has been told, in words, that this share will have no
   * thumbnail and has said 仍要分享 anyway.
   */
  const building = preview?.status === "building";
  const previewFailed = preview?.status === "unavailable";
  const shareable = !building && (!previewFailed || acceptedNoCard);
  const url = state.url;
  const cardTitle = card?.title?.trim() || presentation.defaultTitle;
  const inviteText = presentation.inviteText(cardTitle);
  const lineUrl = `https://line.me/R/msg/text/?${encodeURIComponent(`${inviteText}\n${url}`)}`;

  const copy = async (value: string, label: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value);
      onToast(label, { tone: "success" });
      return true;
    } catch {
      onToast("複製失敗，請長按下方連結手動複製。", { tone: "error" });
      return false;
    }
  };

  const copyShare = async () => {
    // Only the primary action flips the button's label: copying the raw
    // fallback URL from 更多 must not make 複製連結 claim it did the work.
    const done = await copy(url, "分享連結已複製");
    setCopied(done);
    if (done) window.setTimeout(onClose, 700);
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title: cardTitle, text: inviteText, url });
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

        {building && <Note>{presentation.preparingCopy}</Note>}
        {previewFailed && (
          <Note>這次沒有產生預覽縮圖，但分享連結仍可使用。傳出去的連結不會有縮圖。</Note>
        )}

        <button type="button" className="m-row m-row-primary" onClick={copyShare} disabled={!shareable}>
          {building ? "正在準備分享連結…" : copied ? "已複製連結" : "複製連結"}
        </button>

        {shareable ? (
          <a className="m-row m-row-line" href={lineUrl} target="_blank" rel="noreferrer" onClick={onClose}>
            傳到 LINE
          </a>
        ) : (
          <button type="button" className="m-row m-row-line" disabled>
            {building ? presentation.preparingActionCopy : "傳到 LINE"}
          </button>
        )}

        {canNativeShare && (
          <button type="button" className="m-row" onClick={nativeShare} disabled={!shareable}>
            其他方式分享
          </button>
        )}

        {previewFailed && !acceptedNoCard && (
          <button type="button" className="m-row" onClick={() => setAcceptedNoCard(true)}>
            仍要分享（這次沒有縮圖）
          </button>
        )}

        {/* Above the raw URL: seeing what LINE will show matters more than the
            link text, but the two primary actions still come first. */}
        {preview && (
          <PreviewBlock
            presentation={presentation}
            cardTitle={cardTitle}
            preview={preview}
            onPreviewThumbnail={onPreviewThumbnail}
          />
        )}

        {card && (
          <CustomizeBlock
            presentation={presentation}
            card={card}
            busy={Boolean(building)}
            onCustomize={onCustomize}
            onToast={onToast}
          />
        )}

        {state.kind === "ready" ? (
          more ? (
            <section className="m-share-advanced" aria-label="更多分享選項">
              <button type="button" className="m-row" onClick={onRotatePreview} disabled={Boolean(building)}>
                重新產生預覽連結（舊連結不再顯示縮圖）
              </button>
              {/* An escape hatch, not a primary action: the raw app URL always
                  opens the room, but a platform can make no card out of it. */}
              <button
                type="button"
                className="m-row"
                onClick={() => void copy(state.appUrl, "已複製原始安全連結")}
              >
                複製原始安全連結（不含預覽卡片）
              </button>
              <Note>原始連結一樣只把邀請碼放在網址 # 之後，不會傳給任何伺服器。</Note>
            </section>
          ) : (
            <button type="button" className="m-link m-share-more" onClick={() => setMore(true)}>
              更多
            </button>
          )
        ) : null}

        {shareable && (
          <input className="m-input m-share-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        )}
      </div>
    </ModalSheet>
  );
}
