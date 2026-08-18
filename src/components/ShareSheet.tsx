import { useState } from "react";
import { ModalSheet } from "./BottomSheet";
import type { ShowToast } from "../toast";

type Props = {
  title: string;
  url: string | null;
  cloud?: boolean;
  onClose: () => void;
  onToast: ShowToast;
};

/** Share is a bottom sheet on every size: copy, LINE, or the OS share sheet. */
export function ShareSheet({ title, url, cloud, onClose, onToast }: Props) {
  const [copied, setCopied] = useState(false);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  if (url == null) {
    return (
      <ModalSheet title="分享給夥伴" onClose={onClose}>
        <div className="m-more">
          <p className="m-share-note">正在建立分享連結…</p>
        </div>
      </ModalSheet>
    );
  }

  const lineUrl = `https://line.me/R/msg/text/?${encodeURIComponent(`一起討論「${title}」：${url}`)}`;

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
      await navigator.share({ title, text: `一起討論「${title}」`, url });
      onClose();
    } catch {
      /* the user dismissed the OS sheet */
    }
  };

  return (
    <ModalSheet title="分享給夥伴" onClose={onClose}>
      <div className="m-more">
        <p className="m-share-note">
          {cloud
            ? "分享連結已建立，主辦方不用保持頁面開著。夥伴打開連結、輸入名字就能一起看。"
            : "夥伴打開連結、輸入名字就能一起看，不會改到原稿。"}
        </p>
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
        <input className="m-input m-share-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      </div>
    </ModalSheet>
  );
}
