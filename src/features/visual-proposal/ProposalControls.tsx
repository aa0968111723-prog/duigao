import { UniversalIntake } from "../../components/UniversalIntake";
import { useEffect, useState } from "react";
import { useProposalStore, type ProposalAuthor } from "./store";
import { ProposalElementControls } from "./ProposalElementControls";
import { ProposalBackgroundControls } from "./ProposalBackgroundControls";
import { ProposalSummary } from "./ProposalSummary";
import { ProposalPreference } from "./ProposalPreference";
import {
  PROPOSAL_STATUSES,
  PROPOSAL_TYPES,
  TEXT_ROLES,
  createImageItem,
  createShapeItem,
  createTextItem,
  prepareImageFile,
} from "./helpers";
import type { ShowToast } from "../../toast";
import type { ProposalPrefBinding } from "./ProposalDock";
import { imageItemFromCatalogHit } from "./openCatalog";
import { OpenStickerPicker } from "./OpenStickerPicker";
import { ensureComposeFonts } from "./composeFonts";
import "./proposal.css";

type Props = {
  roomId: string;
  versionId: string;
  author: ProposalAuthor;
  showToast?: ShowToast;
  pref?: ProposalPrefBinding;
  canManage?: boolean;
  onSaveVersion?: () => Promise<void>;
};

export function ProposalControls({ roomId, versionId, author, showToast, pref, canManage = false, onSaveVersion }: Props) {
  const proposal = useProposalStore(roomId, versionId, author);
  const [pickText, setPickText] = useState(false);
  const [pickCatalog, setPickCatalog] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const active = proposal.active;
  useEffect(() => { ensureComposeFonts(); }, []);

  const uploadMaterial = async (files: FileList | null) => {
    if (!canManage || !files?.length) return;
    for (const file of Array.from(files)) {
      try {
        const prepared = await prepareImageFile(file);
        proposal.addImage(createImageItem(prepared.dataUrl, prepared.name));
        if (prepared.note) showToast?.(prepared.note);
      } catch (err) {
        showToast?.(err instanceof Error ? err.message : "素材讀取失敗", { tone: "error" });
      }
    }
  };

  const saveVersion = async () => {
    if (!canManage || !onSaveVersion || saving) return;
    setSaving(true);
    try {
      await onSaveVersion();
    } finally {
      setSaving(false);
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
          <div className="proposal-view-switch" aria-label="原稿 / 提案 / 對照">
            <button type="button" className={proposal.viewMode === "original" ? "is-on" : ""} onClick={() => proposal.setViewMode("original")}>
              原稿
            </button>
            <button type="button" className={proposal.viewMode === "proposal" ? "is-on" : ""} onClick={() => proposal.setViewMode("proposal")}>
              工作層
            </button>
            <button type="button" className={proposal.viewMode === "compare" ? "is-on" : ""} onClick={() => proposal.setViewMode("compare")}>
              對照
            </button>
          </div>
        )}
      </div>

      {proposal.viewMode === "compare" && (
        <label className="proposal-field">
          <span>對照位置</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={proposal.compareSplit}
            aria-label="對照位置"
            onChange={(e) => proposal.setCompareSplit(Number(e.target.value))}
          />
        </label>
      )}

      {proposal.error && (
        <div className="proposal-error" role="alert">
          <span>{proposal.error}</span>
          <button type="button" onClick={proposal.dismissError} aria-label="關閉錯誤訊息">
            ×
          </button>
        </div>
      )}

      {!proposal.hydrated && <p className="proposal-muted">正在載入這台裝置的提案…</p>}

      {proposal.hydrated && !active && canManage && (
        <button type="button" className="proposal-primary" onClick={() => proposal.create()}>
          ＋ 建立這一版的工作層
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
                  {doc.title}
                </button>
              ))}
            </div>
            <button type="button" className="proposal-icon-action" onClick={() => proposal.create()} title="新增另一個提案" aria-label="新增另一個提案">
              ＋
            </button>
          </div>

          <div className="proposal-field">
            <span>提案類型</span>
            <div className="proposal-chiprow" role="group" aria-label="提案類型">
              {PROPOSAL_TYPES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`proposal-chip ${active.type === t.key ? "is-on" : ""}`}
                  aria-pressed={active.type === t.key}
                  onClick={() => proposal.setType(active.id, t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="proposal-field">
            <span>狀態</span>
            <div className="proposal-chiprow" role="group" aria-label="提案狀態">
              {PROPOSAL_STATUSES.map((st) => (
                <button
                  key={st.key}
                  type="button"
                  className={`proposal-chip ${active.status === st.key ? "is-on" : ""}`}
                  aria-pressed={active.status === st.key}
                  onClick={() => proposal.setStatus(active.id, st.key)}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          <label className="proposal-field">
            <span>說明</span>
            <textarea
              rows={2}
              value={active.description}
              aria-label="提案說明"
              onChange={(e) => proposal.setDescription(active.id, e.target.value)}
            />
          </label>

          {pref && (
            <ProposalPreference
              versionId={versionId}
              proposals={proposal.docs.map((d) => ({ id: d.id, name: d.title }))}
              prefs={pref.prefs}
              userId={pref.userId}
              onChoose={pref.onChoose}
            />
          )}

          {canManage && <div className="proposal-manage">
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
                <span>確定刪除「{active.title}」？原稿不會受到影響。</span>
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
                    setRenameValue(active.title);
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
          </div>}

          {canManage && (
          <div className="proposal-action-row">
            <button type="button" className={`proposal-action ${pickText ? "is-on" : ""}`} onClick={() => setPickText((v) => !v)}>
              Aa 文字
            </button>
            <UniversalIntake profile="proposal" mode="zone" className="proposal-action poster-add-asset" onFiles={(picked) => void uploadMaterial(picked)} onReject={(reason) => showToast?.(reason, { tone: "error" })}>
              <span data-testid="poster-add-asset">＋ 素材</span>
            </UniversalIntake>
            <button
              type="button"
              className={`proposal-action ${pickCatalog ? "is-on" : ""}`}
              data-testid="poster-catalog-open"
              onClick={() => setPickCatalog((current) => !current)}
            >
              開源圖庫
            </button>
            <button type="button" className="proposal-action" onClick={() => proposal.addShape(createShapeItem())}>
              ＋ 色塊
            </button>
            <button
              type="button"
              className={`proposal-action ${proposal.editing ? "is-on" : ""}`}
              onClick={() => proposal.setEditing(!proposal.editing)}
            >
              {proposal.editing ? "完成擺放" : "編輯這張"}
            </button>
            <button
              type="button"
              className="poster-save-version"
              data-testid="poster-save-version"
              disabled={saving}
              onClick={() => void saveVersion()}
            >
              {saving ? "存檔中…" : "存成新版本"}
            </button>
          </div>
          )}
          {canManage && pickCatalog && (
            <OpenStickerPicker
              onPick={(hit) => {
                proposal.addImage(imageItemFromCatalogHit(hit));
                setPickCatalog(false);
                showToast?.("已加入開源貼圖，拖到想要的位置");
              }}
            />
          )}

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
              <ProposalBackgroundControls roomId={roomId} versionId={versionId} author={author} showToast={showToast} />
            </div>
          </details>

          <div className="proposal-selected">
            <ProposalElementControls roomId={roomId} versionId={versionId} author={author} showToast={showToast} />
          </div>

          <details className="proposal-section">
            <summary>提案摘要 / 轉成修改建議</summary>
            <div className="proposal-section-body">
              <ProposalSummary roomId={roomId} versionId={versionId} author={author} showToast={showToast} />
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
