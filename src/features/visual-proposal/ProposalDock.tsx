import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useProposalStore } from "./store";
import { ProposalElementControls } from "./ProposalElementControls";
import { ProposalBackgroundControls } from "./ProposalBackgroundControls";
import { ProposalSummary } from "./ProposalSummary";
import { TEXT_ROLES, createImageItem, createTextItem, prepareImageFile } from "./helpers";
import type { ShowToast } from "../../toast";
import "./proposal.css";

type Props = {
  roomId: string;
  versionId: string;
  authorName: string;
  showToast: ShowToast;
  onExit: () => void;
  onHeight?: (px: number) => void;
};

type Panel = "actions" | "element" | "background" | "summary";

/**
 * Mobile proposal editing surface. Unlike a modal sheet it has no scrim, so the
 * poster above stays draggable while these controls are visible — you can move
 * an element and tune it at the same time.
 */
export function ProposalDock({ roomId, versionId, authorName, showToast, onExit, onHeight }: Props) {
  const proposal = useProposalStore(roomId, versionId, authorName);
  const materialRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<Panel>("actions");
  const [pickText, setPickText] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeight) return;
    const report = () => onHeight(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => {
      ro.disconnect();
      onHeight(0);
    };
  }, [onHeight]);

  // Enter edit mode on mount; return to a clean original poster on exit.
  useEffect(() => {
    proposal.setVisible(true);
    proposal.setEditing(true);
    return () => {
      proposal.setEditing(false);
      proposal.setVisible(false);
      proposal.selectItem(null);
      proposal.setCompareOriginal(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When an element is picked on the canvas, jump straight to its settings.
  useEffect(() => {
    if (proposal.selectedItem) setPanel("element");
  }, [proposal.selectedItem]);

  const active = proposal.active;

  const uploadMaterial = async (files: FileList | null) => {
    const file = files?.[0];
    if (materialRef.current) materialRef.current.value = "";
    if (!file) return;
    try {
      const prepared = await prepareImageFile(file);
      proposal.addImage(createImageItem(prepared.dataUrl, prepared.name));
      setPanel("element");
      showToast(prepared.note ?? "已加入素材，拖到想要的位置");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "素材讀取失敗", { tone: "error" });
    }
  };

  const holdOriginal = {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      proposal.setCompareOriginal(true);
    },
    onPointerUp: () => proposal.setCompareOriginal(false),
    onPointerCancel: () => proposal.setCompareOriginal(false),
  };

  return (
    <section className="pdock" aria-label="視覺提案編輯" ref={rootRef}>
      <div className="pdock-top">
        <div className="pdock-docs" aria-label="提案版本">
          {proposal.docs.map((doc) => (
            <button
              key={doc.id}
              type="button"
              className={`pdock-tab ${doc.id === active?.id ? "is-on" : ""}`}
              aria-pressed={doc.id === active?.id}
              onClick={() => proposal.selectProposal(doc.id)}
            >
              {doc.name}
            </button>
          ))}
          <button type="button" className="pdock-tab pdock-tab-add" onClick={proposal.create} aria-label="新增提案">
            ＋
          </button>
        </div>
        <button type="button" className="pdock-hold" aria-label="按住看原稿" {...holdOriginal}>
          按住原稿
        </button>
        <button type="button" className="pdock-done" onClick={onExit}>
          完成
        </button>
      </div>

      {proposal.error && (
        <div className="proposal-error" role="alert">
          <span>{proposal.error}</span>
          <button type="button" onClick={proposal.dismissError} aria-label="關閉錯誤訊息">
            ×
          </button>
        </div>
      )}

      {!active ? (
        <button type="button" className="proposal-primary pdock-create" onClick={proposal.create}>
          ＋ 建立這一版的視覺提案
        </button>
      ) : (
        <>
          <div className="pdock-actions">
            <button type="button" className={`pdock-act ${pickText ? "is-on" : ""}`} onClick={() => { setPickText((v) => !v); setPanel("actions"); }}>
              ＋文字
            </button>
            <button type="button" className="pdock-act" onClick={() => materialRef.current?.click()}>
              ＋素材
            </button>
            <button type="button" className={`pdock-act ${panel === "background" ? "is-on" : ""}`} onClick={() => setPanel(panel === "background" ? "actions" : "background")}>
              背景
            </button>
            <button type="button" className={`pdock-act ${panel === "summary" ? "is-on" : ""}`} onClick={() => setPanel(panel === "summary" ? "actions" : "summary")}>
              摘要
            </button>
            <input
              ref={materialRef}
              className="proposal-file"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(e) => void uploadMaterial(e.target.files)}
            />
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
                    setPanel("element");
                  }}
                >
                  {role.label}
                </button>
              ))}
            </div>
          )}

          <div className="pdock-body">
            {panel === "background" && (
              <ProposalBackgroundControls roomId={roomId} versionId={versionId} authorName={authorName} showToast={showToast} />
            )}
            {panel === "summary" && (
              <ProposalSummary roomId={roomId} versionId={versionId} authorName={authorName} showToast={showToast} />
            )}
            {(panel === "element" || panel === "actions") && (
              <ProposalElementControls roomId={roomId} versionId={versionId} authorName={authorName} showToast={showToast} />
            )}
          </div>

          <div className="pdock-foot">
            <button type="button" className="proposal-quiet" onClick={proposal.undo} disabled={!proposal.canUndo}>
              復原
            </button>
            <button type="button" className="proposal-quiet" onClick={proposal.redo} disabled={!proposal.canRedo}>
              重做
            </button>
            {confirmDelete ? (
              <span className="pdock-confirm">
                刪除「{active.name}」？
                <button
                  type="button"
                  className="proposal-danger"
                  onClick={() => {
                    proposal.deleteProposal(active.id);
                    setConfirmDelete(false);
                    showToast("已刪除提案", { action: { label: "復原", onClick: () => proposal.undo() } });
                  }}
                >
                  刪除
                </button>
                <button type="button" className="proposal-quiet" onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
              </span>
            ) : (
              <>
                <button type="button" className="proposal-quiet" onClick={() => proposal.duplicateProposal(active.id)}>
                  複製提案
                </button>
                <button type="button" className="proposal-quiet" onClick={() => setConfirmDelete(true)}>
                  刪除提案
                </button>
              </>
            )}
          </div>
          <p className="proposal-local-note">目前提案只保存在這台裝置。</p>
        </>
      )}
    </section>
  );
}
