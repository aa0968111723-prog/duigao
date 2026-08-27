import type { Room } from "../lib/types";
import { roomMediaType } from "../lib/types";
import { UploadZone } from "./UploadZone";
import { VIDEO_ACCEPT, VIDEO_LIMIT_HINT } from "../features/video-review/media";

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

/**
 * First screen: pick what you are reviewing, then pick the file.
 *
 * Two entries rather than one smart one. Sniffing the MIME type would work, but
 * "what am I about to do" is exactly the moment to be explicit — a poster and a
 * cut lead to different screens, and the person choosing already knows which
 * they have.
 */
export function Home({ recent, isGuestSession, onFiles, onVideoFiles, videoAvailable, onOpen, onCreateProject }: Props) {
  return (
    <main className="home">
      <div className="home-hero">
        <h1 className="home-title">對稿討論區</h1>
        <p className="home-sub">把稿子傳給夥伴，直接指出哪裡需要調整。</p>
      </div>

      <div className="home-picks">
        <button type="button" className="home-pick home-pick-project" onClick={onCreateProject}>
          <span className="home-pick-icon" aria-hidden>＋</span>
          <span className="home-pick-copy">
            <b>建立活動房</b>
            <small>把文宣、影片、企劃放在同一間</small>
          </span>
        </button>
        <UploadZone onFiles={onFiles} className="home-pick">
          <span className="home-pick-icon" aria-hidden>
            🖼
          </span>
          <span className="home-pick-copy">
            <b>圖片文宣對稿</b>
            <small>海報、社群圖、簡報圖</small>
          </span>
        </UploadZone>

        {videoAvailable ? (
          <UploadZone
            onFiles={onVideoFiles}
            accept={VIDEO_ACCEPT}
            multiple={false}
            className="home-pick home-pick-video"
          >
            <span className="home-pick-icon" aria-hidden>
              ▶
            </span>
            <span className="home-pick-copy">
              <b>影片對稿</b>
              <small>短片、動畫、宣傳影片（{VIDEO_LIMIT_HINT}）</small>
            </span>
          </UploadZone>
        ) : (
          <div className="home-pick is-disabled" aria-disabled="true">
            <span className="home-pick-icon" aria-hidden>
              ▶
            </span>
            <span className="home-pick-copy">
              <b>影片對稿</b>
              <small>這台裝置目前是本機模式，影片需要雲端設定</small>
            </span>
          </div>
        )}
      </div>

      {!isGuestSession && recent.length > 0 && (
        <section className="home-recent">
          <h2 className="home-recent-title">最近討論</h2>
          {recent.map((r) => (
            <button key={r.id} type="button" className="home-recent-item" onClick={() => onOpen(r)}>
              <span className="home-recent-name">
                <span className="home-recent-kind" aria-hidden>
                  {roomMediaType(r) === "video" ? "▶" : "🖼"}
                </span>
                {r.title}
              </span>
              <span className="home-recent-meta">
                {r.versions.length} 版 · {r.comments.filter((c) => !c.resolved).length} 待處理
              </span>
            </button>
          ))}
        </section>
      )}
    </main>
  );
}
