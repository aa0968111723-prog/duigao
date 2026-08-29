import type { CollabStatus } from "../../lib/peer";
import { useIsMobile } from "../../hooks/useIsMobile";
import { syncStatusLabel, type SyncStatus } from "../../cloud/types";
import type { WorkspaceApi } from "../../components/api";
import { BrandMark } from "../../components/BrandMark";
import { MobileWorkspace } from "./MobileWorkspace";
import { DesktopWorkspace } from "./DesktopWorkspace";

/**
 * 圖片文宣對稿 — the poster workspace, whole.
 *
 * This is the shell App used to inline: phone gets the one-handed layout,
 * desktop gets the topbar plus the two-pane workspace. Lifting it out of App
 * verbatim is what lets video review be a sibling rather than a set of branches
 * threaded through this one. Nothing about how posters are reviewed changed.
 */

type Props = {
  api: WorkspaceApi;
  presence: { status: CollabStatus | null; peers: number };
  /**
   * Cloud sync badge for the desktop header. Absent in local-only mode, where
   * the peer-connection badge in `presence` is the only one there has ever been.
   */
  cloud?: { status: SyncStatus; online: number } | null;
};

export function ImageWorkspace({ api, presence, cloud }: Props) {
  const isMobile = useIsMobile();
  const { room, guest } = api;

  if (isMobile) return <MobileWorkspace api={api} presence={presence} />;

  return (
    <div className="app">
      <header className="topbar">
        <button className="workspace-brand" onClick={api.goHome} aria-label="回到對稿首頁">
          <BrandMark compact context="圖片" />
        </button>
        <input
          className="title-input"
          value={room.title}
          onChange={(e) => api.setTitle(e.target.value)}
          aria-label="文宣名稱"
        />
        <div className="topbar-right">
          {api.saveState !== "idle" && (
            <span className={`save-status save-${api.saveState}`} title="資料自動保存在這台裝置">
              {api.saveState === "saving" ? "儲存中…" : api.saveState === "saved" ? "已儲存" : "儲存失敗"}
            </span>
          )}
          {cloud
            ? cloud.status !== "local-only" && (
                <span
                  className={`badge badge-${presence.status ?? "closed"}`}
                  title="資料保存在雲端，主辦方不用保持頁面開著"
                  onClick={
                    cloud.status === "error" || cloud.status === "offline-pending"
                      ? () => window.location.reload()
                      : undefined
                  }
                >
                  {cloud.online > 1 && cloud.status === "synced"
                    ? `已同步 · ${cloud.online} 人`
                    : syncStatusLabel(cloud.status)}
                </span>
              )
            : presence.status && (
                <span
                  className={`badge badge-${presence.status}`}
                  title={
                    presence.status === "online"
                      ? "已與其他人同步"
                      : presence.status === "connecting" || presence.status === "waiting"
                        ? "正在建立同步連線，會自動重試"
                        : "目前離線，內容已保存在這台裝置"
                  }
                >
                  {presence.status === "online"
                    ? presence.peers > 0
                      ? `已同步 · ${presence.peers} 人`
                      : "已同步"
                    : presence.status === "connecting"
                      ? "正在同步"
                      : presence.status === "waiting"
                        ? "等待連線"
                        : "目前離線"}
                </span>
              )}
          <span className="me" style={{ background: guest.color }} title={guest.name}>
            {guest.name.slice(0, 1)}
          </span>
          <button className="btn btn-primary" onClick={api.openShare}>
            分享
          </button>
        </div>
      </header>

      {!api.coachSeen && room.comments.length === 0 && (
        <div className="coach" role="note">
          <span className="coach-icon">💡</span>
          <span className="coach-text">第一次用嗎？選「修改點」 → 點文宣上需要調整的位置 → 留下意見。</span>
          <button className="coach-dismiss" onClick={api.markCoachSeen}>
            知道了
          </button>
        </div>
      )}

      <DesktopWorkspace api={api} />
    </div>
  );
}
