import type { Room } from "../lib/types";
import { UploadZone } from "./UploadZone";

type Props = {
  recent: Room[];
  isGuestSession: boolean;
  onFiles: (files: FileList | null) => void;
  onOpen: (room: Room) => void;
};

/** First screen: one sentence, one action, then whatever was discussed lately. */
export function Home({ recent, isGuestSession, onFiles, onOpen }: Props) {
  return (
    <main className="home">
      <div className="home-hero">
        <h1 className="home-title">文宣討論區</h1>
        <p className="home-sub">把文宣傳給夥伴，直接在畫面上指出哪裡需要調整。</p>
      </div>

      <UploadZone onFiles={onFiles} className="home-cta">
        <span className="home-cta-icon" aria-hidden>
          ＋
        </span>
        <span className="home-cta-text">上傳文宣</span>
      </UploadZone>

      {!isGuestSession && recent.length > 0 && (
        <section className="home-recent">
          <h2 className="home-recent-title">最近討論</h2>
          {recent.map((r) => (
            <button key={r.id} type="button" className="home-recent-item" onClick={() => onOpen(r)}>
              <span className="home-recent-name">{r.title}</span>
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
