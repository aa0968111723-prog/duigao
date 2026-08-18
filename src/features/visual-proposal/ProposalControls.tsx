import { useRef, useState } from "react";
import { useProposalStore } from "./store";
import { ProposalElementControls } from "./ProposalElementControls";
import { ProposalBackgroundControls } from "./ProposalBackgroundControls";
import { ProposalSummary } from "./ProposalSummary";
import { ProposalPreference } from "./ProposalPreference";
import { TEXT_ROLES, createImageItem, createTextItem, prepareImageFile } from "./helpers";
import type { ShowToast } from "../../toast";
import type { ProposalPrefBinding } from "./ProposalDock";
import "./proposal.css";

type Props = {
  roomId: string;
  versionId: string;
  authorName: string;
  showToast?: ShowToast;
  pref?: ProposalPrefBinding;
};

export function ProposalControls({ roomId, versionId, authorName, showToast, pref }: Props) {
  const proposal = useProposalStore(roomId, versionId, authorName);
  const materialRef = useRef<HTMLInputElement>(null);
  const [pickText, setPickText] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const active = proposal.active;

  const uploadMaterial = async (files: FileList | null) => {
    const file = files?.[0];
    if (materialRef.current) materialRef.current.value = "";
    if (!file) return;
    try {
      const prepared = await prepareImageFile(file);
      proposal.addImage(createImageItem(prepared.dataUrl, prepared.name));
      if (prepared.note) showToast?.(prepared.note);
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : "素材讀取失敗", { tone: "error" });
    }
  };

  return (
    <section className="proposal-controls">
      <div className="proposal-controls-head">
        <div>
          <strong>視覺提案</strong>
          <p>只做模擬，不會修改原始文宣。</p>
        </div>
        {active && (
          <div className="proposal-view-switch" aria-label="原稿與提案切換">
            <button type="button" className={!proposal.visible ? "is-on" : ""} onClick={() => proposal.setVisible(false)}>
              原稿
            </button>
            <button type="button" className={proposal.visible ? "is-on" : ""} onClick={() => proposal.setVisible(true)}>
              提案
            </button>
          </div>
        )}
      </div>

      {proposal.error && (
        <div className="proposal-error" role="alert">
          <span>{proposal.error}</span>
          <button type="button" onClick={proposal.dismissError} aria-label="關閉錯誤訊息">
            ×
          </button>
        </div>
      )}

      {!proposal.hydrated && <p className="proposal-muted">正在載入這台裝置的提案…</p>}

      {proposal.hydrated && !active && (
        <button type="button" className="proposal-primary" onClick={proposal.create}>
          ＋ 建立這一版的視覺提案
        </button>
      )}

      {active && (
        <>
          <div className="proposal-doc-row">
            <div className="proposal-docs" aria-label="提案版本">
              {proposal.docs.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className={doc.id === active.id ? "is-on" : ""}
                  aria-pressed={doc.id === active.id}
                  onClick={() => proposal.selectProposal(doc.id)}
                >
                  {doc.name}
                </button>
              ))}
            </div>
            <button type="button" className="proposal-icon-action" onClick={proposal.create} title="新增另一個提案" aria-label="新增另一個提案">
              ＋
            </button>
          </div>

          {pref && (
            <ProposalPreference
              versionId={versionId}
              proposals={proposal.docs.map((d) => ({ id: d.id, name: d.name }))}
              prefs={pref.prefs}
              userId={pref.userId}
              onChoose={pref.onChoose}
            />
          )}

          <div className="proposal-manage">
            {renaming ? (
              <form
                className="proposal-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  proposal.renameProposal(active.id, renameValue);
                  setRenaming(false);
                }}
              >
                <input
                  className="proposal-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  aria-label="提案名稱"
                  autoFocus
                />
                <button type="submit" className="proposal-quiet">
                  儲存
                </button>
                <button type="button" className="proposal-quiet" onClick={() => setRenaming(false)}>
                  取消
                </button>
              </form>
            ) : confirmDelete ? (
              <div className="proposal-confirm" role="alertdialog" aria-label="刪除提案確認">
                <span>確定刪除「{active.name}」？原稿不會受到影響。</span>
                <button
                  type="button"
                  className="proposal-danger"
                  onClick={() => {
                    proposal.deleteProposal(active.id);
                    setConfirmDelete(false);
                    showToast?.("已刪除提案", { action: { label: "復原", onClick: () => proposal.undo() } });
                  }}
                >
                  刪除
                </button>
                <button type="button" className="proposal-quiet" onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="proposal-quiet"
                  onClick={() => {
                    setRenameValue(active.name);
                    setRenaming(true);
                  }}
                >
                  重新命名
                </button>
                <button type="button" className="proposal-quiet" onClick={() => proposal.duplicateProposal(active.id)}>
                  複製提案
                </button>
                <button type="button" className="proposal-quiet" onClick={() => setConfirmDelete(true)}>
                  刪除提案
                </button>
              </>
            )}
          </div>

          <div className="proposal-action-row">
            <button type="button" className={`proposal-action ${pickText ? "is-on" : ""}`} onClick={() => setPickText((v) => !v)}>
              Aa 文字
            </button>
            <button type="button" className="proposal-action" onClick={() => materialRef.current?.click()}>
              ＋ 素材
            </button>
            <input
              ref={materialRef}
              className="proposal-file"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(e) => void uploadMaterial(e.target.files)}
            />
            <button
              type="button"
              className={`proposal-action ${proposal.editing ? "is-on" : ""}`}
              onClick={() => proposal.setEditing(!proposal.editing)}
            >
              {proposal.editing ? "完成擺放" : "移動元素"}
            </button>
          </div>

          {pickText && (
            <div className="proposal-role-pick" role="group" aria-label="選擇文字類型">
              {TEXT_ROLES.map((role) => (
                <button
                  key={role.key}
                  type="button"
                  className="proposal-chip"
                  onClick={() => {
                    proposal.addText(createTextItem(role.key));
                    setPickText(false);
                  }}
                >
                  {role.label}
                </button>
              ))}
            </div>
          )}

          <details className="proposal-section">
            <summary>背景模擬</summary>
            <div className="proposal-section-body">
              <ProposalBackgroundControls roomId={roomId} versionId={versionId} authorName={authorName} showToast={showToast} />
            </div>
          </details>

          <div className="proposal-selected">
            <ProposalElementControls roomId={roomId} versionId={versionId} authorName={authorName} showToast={showToast} />
          </div>

          <details className="proposal-section">
            <summary>提案摘要 / 轉成修改建議</summary>
            <div className="proposal-section-body">
              <ProposalSummary roomId={roomId} versionId={versionId} authorName={authorName} showToast={showToast} />
            </div>
          </details>

          <div className="proposal-history">
            <button type="button" className="proposal-quiet" onClick={proposal.undo} disabled={!proposal.canUndo}>
              復原
            </button>
            <button type="button" className="proposal-quiet" onClick={proposal.redo} disabled={!proposal.canRedo}>
              重做
            </button>
          </div>

          <p className="proposal-local-note">目前提案只保存在這台裝置。</p>
        </>
      )}
    </section>
  );
}
