import { useState } from "react";
import { staticFileList } from "../../components/UniversalIntake";
import { STUDIO_ENTRY_COPY, openStudio } from "../../lib/studioEmbed";
import "./studio.css";

type Props = {
  onImage: (files: FileList | null) => void;
  onVideo: (files: FileList | null) => void;
  videoAvailable: boolean;
};

function PenIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function ClipIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m10 9 5 3-5 3V9Z" />
    </svg>
  );
}

/**
 * 首頁「做一張圖／做一段影片」。打開對稿自己的 Canva 式編輯器，
 * 匯出檔案交給既有上傳入口，不另開權限、不改原稿。
 */
export function StudioPicks({ onImage, onVideo, videoAvailable }: Props) {
  const [hint, setHint] = useState<string | null>(null);

  function start(kind: "poster" | "video") {
    setHint(null);
    const opened = openStudio({
      kind,
      name: kind === "video" ? "未命名影片" : "未命名海報",
      onExport(file) {
        const list = staticFileList([file]);
        if (kind === "video") onVideo(list);
        else onImage(list);
      },
      onCancel() {
        /* stay on home */
      },
    });
    if (!opened) setHint(STUDIO_ENTRY_COPY["not-configured"]);
  }

  return (
    <>
      <button
        type="button"
        className="home-pick home-pick-studio"
        data-testid="studio-pick-poster"
        onClick={() => start("poster")}
      >
        <span className="home-pick-icon">
          <PenIcon />
        </span>
        <span className="home-pick-copy">
          <b>做一張圖</b>
          <small>Canva 式海報編輯器，完成後變成房間新版本</small>
        </span>
        <span className="home-pick-arrow" aria-hidden="true">
          →
        </span>
      </button>
      {videoAvailable ? (
        <button
          type="button"
          className="home-pick home-pick-studio"
          data-testid="studio-pick-video"
          onClick={() => start("video")}
        >
          <span className="home-pick-icon">
            <ClipIcon />
          </span>
          <span className="home-pick-copy">
            <b>做一段影片</b>
            <small>疊字、時間軸，匯出後當成影片版本對稿</small>
          </span>
          <span className="home-pick-arrow" aria-hidden="true">
            →
          </span>
        </button>
      ) : (
        <div className="home-pick is-disabled" aria-disabled="true">
          <span className="home-pick-icon">
            <ClipIcon />
          </span>
          <span className="home-pick-copy">
            <b>做一段影片</b>
            <small>這台裝置目前是本機模式，影片需要雲端設定</small>
          </span>
        </div>
      )}
      {hint ? (
        <p className="studio-entry-hint" data-testid="studio-entry-not-configured" role="status">
          {hint}
        </p>
      ) : null}
    </>
  );
}
