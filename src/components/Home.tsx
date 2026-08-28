import type { Room } from "../lib/types";
import { roomMediaType } from "../lib/types";
import { VIDEO_LIMIT_HINT } from "../features/video-review/media";
import { BrandMark } from "./BrandMark";
import { UniversalIntake } from "./UniversalIntake";

type Props = {
  recent: Room[];
  isGuestSession: boolean;
  onFiles: (files: FileList | null) => void;
  /** Video review lives behind its own entry, never behind a MIME sniff. */
  onVideoFiles: (files: FileList | null) => void;
  /** Video rooms need the cloud; without it the entry says so instead of failing. */
  videoAvailable: boolean;
  onOpen: (room: Room) => void;
  onCreateProject: () => void;
};

function ProjectIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 4.5h5l1.8 2H19a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m5.5 17 4.2-4 3.1 2.8 2.4-2.2 3.3 3.4" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m10 9 5 3-5 3V9Z" />
    </svg>
  );
}

/** First screen: choose the collaboration space before choosing a file. */
export function Home({ recent, isGuestSession, onFiles, onVideoFiles, videoAvailable, onOpen, onCreateProject }: Props) {
  return (
    <main className="home">
      <header className="home-header">
        <BrandMark />
        <span className="home-safety"><span aria-hidden="true">●</span> 原稿安全，不會被修改</span>
      </header>

      <section className="home-hero">
        <div className="home-hero-copy">
          <span className="home-kicker">清楚對稿，快速定稿</span>
          <h1 className="home-title">把每一次修改<br /><em>說得更清楚。</em></h1>
          <p className="home-sub">圖片、影片與企劃集中在同一個空間。夥伴直接在作品上標記，意見不再散落在聊天室。</p>
          <div className="home-flow" aria-label="三步驟開始對稿">
            <span><b>1</b> 上傳作品</span><i aria-hidden="true">→</i>
            <span><b>2</b> 分享連結</span><i aria-hidden="true">→</i>
            <span><b>3</b> 集中定稿</span>
          </div>
        </div>
        <div className="home-preview" aria-hidden="true">
          <span className="home-preview-pill">活動主視覺 · v2</span>
          <div className="home-preview-art">
            <span className="home-preview-shape home-preview-shape-a" />
            <span className="home-preview-shape home-preview-shape-b" />
            <strong>SUMMER<br />STUDIO</strong>
            <small>Creative festival 2026</small>
          </div>
          <span className="home-preview-pin home-preview-pin-one">1</span>
          <span className="home-preview-pin home-preview-pin-two">2</span>
          <div className="home-preview-note"><b>嘉怡</b><span>標題可以再往上一點</span></div>
        </div>
      </section>

      <section className="home-start">
        <div className="home-section-heading">
          <div><span>開始新的工作</span><h2>今天要對什麼？</h2></div>
          <small>選擇最適合的空間</small>
        </div>
        <div className="home-picks">
          <button type="button" className="home-pick home-pick-project" onClick={onCreateProject}>
            <span className="home-pick-icon"><ProjectIcon /></span>
            <span className="home-pick-copy"><b>建立活動房</b><small>把文宣、影片、企劃放在同一間</small></span>
            <span className="home-pick-arrow" aria-hidden="true">→</span>
          </button>
          <UniversalIntake profile="poster" mode="zone" onFiles={onFiles} className="home-pick">
            <span className="home-pick-icon"><ImageIcon /></span>
            <span className="home-pick-copy"><b>圖片文宣對稿</b><small>海報、社群圖、簡報圖</small></span>
            <span className="home-pick-arrow" aria-hidden="true">→</span>
          </UniversalIntake>
          {videoAvailable ? (
            <UniversalIntake profile="video" mode="zone" onFiles={onVideoFiles} className="home-pick home-pick-video">
              <span className="home-pick-icon"><VideoIcon /></span>
              <span className="home-pick-copy"><b>影片對稿</b><small>短片、動畫、宣傳影片（{VIDEO_LIMIT_HINT}）</small></span>
              <span className="home-pick-arrow" aria-hidden="true">→</span>
            </UniversalIntake>
          ) : (
            <div className="home-pick is-disabled" aria-disabled="true">
              <span className="home-pick-icon"><VideoIcon /></span>
              <span className="home-pick-copy"><b>影片對稿</b><small>這台裝置目前是本機模式，影片需要雲端設定</small></span>
            </div>
          )}
        </div>
      </section>

      {!isGuestSession && recent.length > 0 && (
        <section className="home-recent">
          <div className="home-section-heading home-recent-heading"><div><span>接著上次進度</span><h2>最近討論</h2></div></div>
          {recent.map((r) => (
            <button key={r.id} type="button" className="home-recent-item" onClick={() => onOpen(r)}>
              <span className="home-recent-name"><span className="home-recent-kind" aria-hidden>{roomMediaType(r) === "video" ? "▶" : "▧"}</span>{r.title}</span>
              <span className="home-recent-meta">{r.versions.length} 版 · {r.comments.filter((c) => !c.resolved).length} 待處理</span>
            </button>
          ))}
        </section>
      )}
    </main>
  );
}
