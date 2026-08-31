import { useEffect, useRef, useState } from "react";
import type { ColorMode, CompareMode } from "../../lib/types";
import type { CollabStatus } from "../../lib/peer";
import { useViewport } from "../../hooks/useViewport";
import { loadFlag, saveFlag } from "../../lib/store";
import { ProposalDock, type ProposalIntent } from "../visual-proposal/ProposalDock";
import { pruneProposalVersions, startComposeEditing, useProposalStore, useRoomProposals } from "../visual-proposal/store";
import { DragSheet, ModalSheet, type SheetSnap } from "../../components/BottomSheet";
import { CommentCard } from "../discussion/CommentCard";
import { PinFields } from "../discussion/PinFields";
import { UniversalIntake } from "../../components/UniversalIntake";
import { Viewer } from "./Stage";
import { ImmersiveViewer } from "./ImmersiveViewer";
import { EditScopeBar } from "./EditScopeBar";
import { useEditScope } from "./useEditScope";
import { IconChat, IconEye, IconMore, IconPen, IconPin } from "../../components/icons";
import { nextPinNumber, pinNumber, versionLabel, type WorkspaceApi } from "../../components/api";
import { canShowCanvaSync } from "../../lib/canvaContract";
import { BrandMark } from "../../components/BrandMark";

const COLOR_MODES: { id: ColorMode; label: string }[] = [
  { id: "color", label: "彩色" },
  { id: "gray", label: "黑白" },
  { id: "split", label: "對切" },
];

const COMPARE_MODES: { id: CompareMode; label: string }[] = [
  { id: "single", label: "單張" },
  { id: "side", label: "並排" },
  { id: "wipe", label: "滑動" },
];

type Props = {
  api: WorkspaceApi;
  presence: { status: CollabStatus | null; peers: number };
};

export function MobileWorkspace({ api, presence }: Props) {
  const { room, view, draftPin, selectedPinId, tool } = api;
  const aiFocusTarget = api.ai?.focusTarget;
  const viewportHeight = useViewport();
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [tab, setTab] = useState<"items" | "chat">("items");
  const [more, setMore] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  /** null = not in 視覺提案 mode. The intent says how the mode was entered. */
  const [proposalSession, setProposalSession] = useState<{ intent: ProposalIntent | null } | null>(null);
  const [dockHeight, setDockHeight] = useState(0);
  const [composeInset, setComposeInset] = useState(0);
  const [nudge, setNudge] = useState(false);
  const [immersiveOpen, setImmersiveOpen] = useState(false);
  const chatRef = useRef<HTMLInputElement>(null);
  const proposalMode = proposalSession != null;
  const visibleVersionId = room.versions.some((version) => version.id === view.versionId)
    ? view.versionId
    : room.versions[0]?.id ?? view.versionId;
  const editScope = useEditScope(api, visibleVersionId, room.id);

  // Read-only view of every proposal in the room, so 修改點卡 can show its own.
  const roomProposals = useRoomProposals(room.id);
  const proposalStore = useProposalStore(room.id, visibleVersionId, api.guest);

  // Viewer already falls back to the first real version when a cloud refresh
  // replaces an optimistic id. Keep every adjacent surface on that same id so
  // the compose layer cannot be created for an invisible/stale version.
  useEffect(() => {
    if (visibleVersionId !== view.versionId) {
      api.setView({ ...view, versionId: visibleVersionId, compareMode: "single" });
    }
  }, [api, view, visibleVersionId]);

  /** 修改點 → 提案: open the dock with a proposal already bound to that pin. */
  const proposeFromPin = (commentId: string) => {
    const target = room.comments.find((c) => c.id === commentId);
    if (!target) return;
    api.setTool("pan");
    api.selectPin(null);
    // The proposal belongs to the poster version the 修改點 lives on.
    if (target.versionId !== view.versionId) {
      api.setView({ ...view, versionId: target.versionId, compareMode: "single" });
    }
    setProposalSession({ intent: { kind: "create", linkedCommentId: commentId } });
  };

  /** 修改點卡的「相關提案」→ open that exact proposal, switching version if needed. */
  const openProposal = (proposalId: string) => {
    const doc = roomProposals.docs.find((d) => d.id === proposalId);
    if (!doc) return;
    api.setTool("pan");
    api.selectPin(null);
    if (doc.versionId !== view.versionId) api.setView({ ...view, versionId: doc.versionId, compareMode: "single" });
    proposalStore.selectProposal(proposalId);
    setProposalSession({ intent: { kind: "open", proposalId } });
  };

  /** 提案卡的「來自修改點 N」→ leave the dock and select that pin in the discussion. */
  const proposalPinBinding = {
    labelFor: (commentId: string) => {
      const n = pinNumber(room, commentId);
      return n > 0 ? `修改點 ${n}` : null;
    },
    onOpen: (commentId: string) => {
      const target = room.comments.find((c) => c.id === commentId);
      setProposalSession(null);
      if (!target) return;
      api.setTool("pan");
      api.setView({ ...view, versionId: target.versionId, compareMode: "single" });
      api.selectPin(commentId);
      setImmersiveOpen(true);
      setTab("items");
      setSnap("half");
    },
  };

  useEffect(() => {
    pruneProposalVersions(
      room.id,
      room.versions.map((v) => v.id),
    );
  }, [room.id, room.versions]);

  useEffect(() => {
    if (proposalStore.layerEditing && !proposalSession) {
      setProposalSession({ intent: null });
    }
  }, [proposalStore.layerEditing, proposalSession]);

  useEffect(() => {
    if (proposalMode && view.compareMode !== "single") {
      api.setView({ ...view, compareMode: "single" });
    }
  }, [api, proposalMode, view]);

  // A cloud room may finish replacing its local id while the compose overlay is
  // opening. Re-assert the plain「編輯這張」session against the room/version now
  // on screen; linked proposal intents still own their own create/select flow.
  useEffect(() => {
    if (proposalSession?.intent === null && api.canManage && !proposalStore.active) {
      startComposeEditing(room.id, visibleVersionId, api.guest);
    }
  }, [api.canManage, api.guest, proposalSession, proposalStore.active, room.id, visibleVersionId]);

  const gaveFeedback =
    room.comments.some((c) => c.authorId === api.guest.id) ||
    (room.supports ?? []).some((s) => s.userId === api.guest.id) ||
    (room.replies ?? []).some((r) => r.authorId === api.guest.id);

  const versionProposalCount = roomProposals.docs.filter((d) => d.versionId === visibleVersionId).length;

  // A single, gentle nudge — only if the viewer has been around a while without
  // leaving any feedback, and never more than once per room.
  const nudgeState = useRef({ gaveFeedback, draftPin, proposalMode });
  nudgeState.current = { gaveFeedback, draftPin, proposalMode };
  useEffect(() => {
    if (loadFlag(`nudge.${room.id}`)) return;
    const t = window.setTimeout(() => {
      const s = nudgeState.current;
      if (!s.gaveFeedback && !s.draftPin && !s.proposalMode) {
        setNudge(true);
        saveFlag(`nudge.${room.id}`);
      }
    }, 25000);
    return () => window.clearTimeout(t);
  }, [room.id]);

  const sendChat = () => {
    api.sendChat();
    chatRef.current?.focus();
  };

  const open = room.comments.filter((c) => !c.resolved).length;
  const hasThread = room.comments.length > 0 || room.messages.length > 0;
  // The discussion is a place, not a byproduct: it opens even in an empty room.
  const sheetVisible = hasThread || snap !== "peek";

  /** The one-shot task bar sits above the toolbar, never over the poster. */
  const task = !draftPin && (tool === "pin" || tool === "region") ? tool : null;

  /** Exit any一次性任務 and clear every locator: back to the clean poster. */
  const backToViewing = () => {
    if (draftPin) api.cancelPin();
    api.setTool("pan");
    api.selectPin(null);
    api.setPreviewStroke(null);
  };

  const startPinTask = () => {
    setActionOpen(false);
    setNudge(false);
    api.selectPin(null);
    api.setTool("pin");
    setSnap("peek");
  };

  const startRegionTask = () => {
    setActionOpen(false);
    setNudge(false);
    api.selectPin(null);
    api.setTool("region");
    setSnap("peek");
  };

  const closeImmersive = () => {
    if (api.draftPin) api.cancelPin();
    api.setTool("pan");
    api.selectPin(null);
    api.setPreviewStroke(null);
    setImmersiveOpen(false);
  };

  const focusComment = (commentId: string) => {
    const target = room.comments.find((comment) => comment.id === commentId);
    if (!target) return;
    api.setTool("pan");
    api.selectPin(commentId);
    api.setView({ ...view, versionId: target.versionId, compareMode: "single" });
    setNudge(false);
    setImmersiveOpen(true);
  };

  /** 重新圈選: drop the draft and immediately arm the circle gesture again. */
  const recircle = () => {
    api.cancelPin();
    api.setTool("region");
  };

  // Tapping a pin opens that item, it never resolves it.
  useEffect(() => {
    if (!selectedPinId) return;
    setTab("items");
    setSnap((s) => (s === "peek" ? "half" : s));
    const id = window.setTimeout(() => {
      document.getElementById(`pin-card-${selectedPinId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 220);
    return () => window.clearTimeout(id);
  }, [selectedPinId]);

  // A citation tapped in the room AI sheet can first hydrate a branch/version.
  // Once that version is on screen, open the same immersive viewer used by a
  // normal poster tap; Stage then applies the normalized AI region focus.
  useEffect(() => {
    if (!aiFocusTarget?.versionId || aiFocusTarget.versionId !== view.versionId) return;
    setImmersiveOpen(true);
  }, [aiFocusTarget, view.versionId]);

  useEffect(() => {
    if (draftPin) setSnap("peek");
    else setComposeInset(0);
  }, [draftPin]);

  return (
    <div
      className={`m-app ${proposalMode ? "is-proposal" : ""}`}
      style={{
        ["--m-peek" as string]: sheetVisible && hasThread ? "52px" : "0px",
        ["--m-status" as string]: task ? "44px" : "0px",
        ["--m-compose" as string]: `${composeInset}px`,
        ["--m-proposal" as string]: `${dockHeight}px`,
      }}
    >
      <header className="m-top">
        <button type="button" className="m-home" onClick={api.goHome} aria-label="回到文宣列表">
          <BrandMark compact />
        </button>
        <input
          className="m-title"
          value={room.title}
          onChange={(e) => api.setTitle(e.target.value)}
          aria-label="文宣名稱"
        />
        {api.saveState !== "idle" && (
          <span className={`save-status save-${api.saveState}`} title="資料自動保存在這台裝置">
            {api.saveState === "saving" ? "儲存中…" : api.saveState === "saved" ? "已儲存" : "儲存失敗"}
          </span>
        )}
        {presence.status && (
          <span
            className={`m-presence is-${presence.status}`}
            title={presence.status === "online" ? `${presence.peers} 人同時在線` : "本機模式"}
          />
        )}
        <button type="button" className="m-share" onClick={api.openShare}>
          分享
        </button>
      </header>

      <div className="m-versions">
        {room.versions.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`m-vchip ${v.id === view.versionId ? "is-on" : ""}`}
            onClick={() => {
              api.selectPin(null);
              api.setView({ ...view, versionId: v.id, compareMode: "single" });
            }}
          >
            {v.label}
          </button>
        ))}
        {api.canManage && (
          <UniversalIntake profile="poster" mode="zone" onFiles={api.addFiles} className="m-vchip m-vchip-add">
            <span aria-hidden>＋</span>
          </UniversalIntake>
        )}
        {canShowCanvaSync(room.versions.find((item) => item.id === view.versionId), api.canManage) && (
          <button
            type="button"
            className="m-vchip"
            data-testid="canva-sync-version"
            onClick={() => { void api.syncCanvaVersion?.(view.versionId); }}
          >
            同步這一版
          </button>
        )}
        {api.canManage && !proposalMode && (
          <button
            type="button"
            className="m-vchip poster-edit-toggle"
            data-testid="poster-edit-toggle"
            onClick={() => {
              api.setTool("pan");
              api.selectPin(null);
              startComposeEditing(room.id, visibleVersionId, api.guest);
              setProposalSession({ intent: null });
            }}
          >
            編輯這張
          </button>
        )}
        {api.boardRefs && (
          <button type="button" className="m-vchip m-vchip-board" data-testid="board-refs-chip" onClick={api.boardRefs.open}>
            ⊞ 白板 {api.boardRefs.count}
          </button>
        )}
      </div>

      <div className="m-stage-area">
        <Viewer api={api} compact onOpenImmersive={() => setImmersiveOpen(true)} />
        <EditScopeBar
          inferred={editScope.inferred}
          override={editScope.override}
          onOverride={editScope.setOverride}
          onGenerate={(forced) => { void editScope.generate(forced); }}
          busy={editScope.busy}
          hint={editScope.hint}
          caption={editScope.caption}
        />
        {nudge && !task && !draftPin && (
          <div className="m-nudge" role="note">
            <span>還有哪一個地方最需要調整？</span>
            <button
              type="button"
              className="m-nudge-cta"
              onClick={() => {
                setNudge(false);
                setActionOpen(true);
              }}
            >
              ＋ 新增修改
            </button>
            <button type="button" className="m-nudge-x" aria-label="關閉提示" onClick={() => setNudge(false)}>
              ×
            </button>
          </div>
        )}
      </div>

      {immersiveOpen && <ImmersiveViewer api={api} onClose={closeImmersive} />}

      <div className="m-bottom">
        {proposalSession ? (
          <ProposalDock
            roomId={room.id}
            versionId={visibleVersionId}
            author={api.guest}
            showToast={api.showToast}
            onExit={() => setProposalSession(null)}
            onHeight={setDockHeight}
            intent={proposalSession.intent}
            pin={proposalPinBinding}
            canManage={api.canManage}
            onSaveVersion={api.saveComposeVersion}
            onGenerateSecondVersion={() => { void editScope.generate("full"); }}
            onGenerateVisualProposal={() => { void editScope.generate("single"); }}
            versions={api.composeVersions ?? room.versions}
            branches={room.branches}
            listLibrary={api.listComposeLibrary}
            resolveMaterial={api.resolveComposeMaterial}
            pref={{
              prefs: room.proposalPrefs ?? [],
              userId: api.guest.id,
              onChoose: (choice) => api.setProposalPref(visibleVersionId, choice),
            }}
          />
        ) : (
          <>
        {sheetVisible && (
          <DragSheet
            snap={snap}
            onSnap={setSnap}
            viewportHeight={viewportHeight}
            handle={
              hasThread ? (
                <span className="m-sheet-summary">
                  修改建議 {room.comments.length}
                  <em>·</em>
                  待處理 {open}
                </span>
              ) : (
                <span className="m-sheet-summary">還沒有討論</span>
              )
            }
          >
            <div className="m-sheet-tabs">
              <button type="button" className={tab === "items" ? "is-on" : ""} onClick={() => setTab("items")}>
                修改建議
              </button>
              <button type="button" className={tab === "chat" ? "is-on" : ""} onClick={() => setTab("chat")}>
                聊天
              </button>
            </div>

            {tab === "items" ? (
              <div className="m-list">
                {room.comments.length === 0 && (
                  <div className="m-discuss-empty">
                    <p className="m-discuss-empty-title">還沒有討論</p>
                    <p className="m-discuss-empty-sub">
                      點文宣留下第一個修改建議，
                      <br />
                      或直接在這裡說一句。
                    </p>
                    <button
                      type="button"
                      className="m-btn m-btn-primary"
                      onClick={() => {
                        setSnap("peek");
                        setActionOpen(true);
                      }}
                    >
                      ＋ 新增修改
                    </button>
                  </div>
                )}
                {room.comments.map((c) => (
                  <CommentCard
                    key={c.id}
                    api={api}
                    pin={c}
                    compact
                    selected={c.id === selectedPinId}
                    onSelect={() => focusComment(c.id)}
                    onToggleResolve={() => api.toggleResolve(c.id)}
                    relatedProposals={roomProposals.docs.filter((d) => d.linkedCommentId === c.id)}
                    onCreateProposal={() => proposeFromPin(c.id)}
                    onOpenProposal={openProposal}
                  />
                ))}
              </div>
            ) : api.discussionDrawer ? (
              api.discussionDrawer
            ) : (
              <>
                <div className="m-list">
                  {room.messages.length === 0 && <p className="m-empty">還沒有訊息，說一句就開始。</p>}
                  {room.messages.map((m) => (
                    <div key={m.id} className="m-msg">
                      <span className="m-msg-who" style={{ color: m.authorColor }}>
                        {m.authorName}
                      </span>
                      <p>{m.body}</p>
                    </div>
                  ))}
                </div>
                <div className="m-chatbar">
                  <input
                    ref={chatRef}
                    className="m-input"
                    placeholder="說點什麼…"
                    value={api.chatInput}
                    onChange={(e) => api.setChatInput(e.target.value)}
                    onFocus={() => setSnap("full")}
                    enterKeyHint="send"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        sendChat();
                      }
                    }}
                  />
                  <button type="button" className="m-btn m-btn-primary" onClick={sendChat} disabled={!api.chatInput.trim()}>
                    送出
                  </button>
                </div>
              </>
            )}
          </DragSheet>
        )}

        {task && (
          <div className="m-status" role="status">
            <span className="m-status-text">
              {task === "region" ? "圈出要調整的範圍" : "點一下需要調整的位置"}
            </span>
            <button type="button" className="m-status-cancel" onClick={backToViewing}>
              取消
            </button>
          </div>
        )}

        <nav className="m-toolbar m-toolbar-4" aria-label="主要操作">
          <button
            type="button"
            className={`m-tool ${tool === "pan" && !draftPin ? "is-on" : ""}`}
            onClick={backToViewing}
            aria-pressed={tool === "pan"}
          >
            <IconEye />
            <span>看</span>
          </button>
          <button
            type="button"
            className={`m-tool is-primary ${task || draftPin ? "is-on" : ""}`}
            onClick={() => setActionOpen(true)}
            aria-haspopup="dialog"
          >
            <IconPen />
            <span>修改</span>
          </button>
          <button
            type="button"
            className="m-tool"
            onClick={() => {
              api.setTool("pan");
              setTab("items");
              setSnap((s) => (s === "peek" ? "half" : "peek"));
            }}
          >
            <span className="m-tool-badge-wrap">
              <IconChat />
              {open > 0 && <span className="m-tool-badge">{open}</span>}
            </span>
            <span>討論</span>
          </button>
          <button type="button" className="m-tool" onClick={() => setMore(true)} aria-haspopup="dialog">
            <IconMore />
            <span>更多</span>
          </button>
        </nav>
          </>
        )}
      </div>

      {actionOpen && (
        <ModalSheet title="新增修改" onClose={() => setActionOpen(false)}>
          <div className="m-action">
            <button type="button" className="m-action-btn" onClick={startPinTask}>
              <IconPin />
              <span className="m-action-copy">
                <b>點位置留意見</b>
                <small>點一下文宣上要調整的位置</small>
              </span>
            </button>
            <button type="button" className="m-action-btn" onClick={startRegionTask}>
              <IconPen />
              <span className="m-action-copy">
                <b>圈出要調整的範圍</b>
                <small>手指圈一圈，放手後留意見</small>
              </span>
            </button>
          </div>
        </ModalSheet>
      )}

      {draftPin && (
        <ModalSheet
          title={draftPin.region ? "已圈選這個範圍" : `修改點 ${nextPinNumber(room, draftPin.versionId)}`}
          onClose={api.cancelPin}
          dismissible={!api.form.body.trim()}
          onHeight={setComposeInset}
          action={
            <div className="m-compose-actions">
              {draftPin.region && (
                <button type="button" className="m-btn" onClick={recircle}>
                  重新圈選
                </button>
              )}
              <button
                type="button"
                className="m-btn m-btn-primary m-btn-block"
                onClick={api.commitPin}
                disabled={!api.form.body.trim()}
              >
                送出
              </button>
            </div>
          }
        >
          <PinFields api={api} autoFocus />
        </ModalSheet>
      )}

      {more && (
        <ModalSheet title="更多" onClose={() => setMore(false)}>
          <div className="m-more">
            <button
              type="button"
              className="m-row"
              onClick={() => {
                api.setTool("pan");
                api.selectPin(null);
                setMore(false);
                setProposalSession({ intent: null });
              }}
            >
              視覺提案{versionProposalCount > 0 ? ` · 這一版 ${versionProposalCount} 個` : " · 覆蓋在原稿上試看"}
            </button>

            <div className="m-more-group">
              <span className="m-more-label">顯示</span>
              <div className="m-chiprow">
                {COLOR_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`m-chip ${view.colorMode === m.id ? "is-on" : ""}`}
                    onClick={() => api.setView({ ...view, colorMode: m.id })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="m-more-group">
              <span className="m-more-label">比較</span>
              <div className="m-chiprow">
                {COMPARE_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`m-chip ${view.compareMode === m.id ? "is-on" : ""}`}
                    disabled={m.id !== "single" && room.versions.length < 2}
                    onClick={() => api.setView({ ...view, compareMode: m.id })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {view.compareMode !== "single" && room.versions.length >= 2 && (
                <div className="m-chiprow">
                  {room.versions
                    .filter((v) => v.id !== view.versionId)
                    .map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className={`m-chip ${view.compareId === v.id ? "is-on" : ""}`}
                        onClick={() => api.setView({ ...view, compareId: v.id })}
                      >
                        對照 {v.label}
                      </button>
                    ))}
                </div>
              )}
              {view.compareMode === "wipe" && room.versions.length >= 2 && (
                <input
                  className="m-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={view.wipe}
                  onChange={(e) => api.setView({ ...view, wipe: Number(e.target.value) })}
                  aria-label="滑動比較位置"
                />
              )}
            </div>

            <UniversalIntake profile="poster" mode="zone" onFiles={api.addFiles} className="m-row">
              加一個版本
            </UniversalIntake>
            {room.strokes.length > 0 && (
              <button
                type="button"
                className="m-row"
                onClick={() => {
                  setMore(false);
                  setLegacyOpen(true);
                }}
              >
                舊圈畫（{room.strokes.length}）· 已不在看稿顯示
              </button>
            )}
            <button type="button" className="m-row" onClick={api.undo} disabled={!api.canUndo}>
              復原上一個操作
            </button>
            {room.comments.length > 0 && (
              <button type="button" className="m-row" onClick={api.copySummary}>
                複製修改清單
              </button>
            )}
          </div>
        </ModalSheet>
      )}

      {legacyOpen && (
        <ModalSheet title="舊圈畫" onClose={() => setLegacyOpen(false)}>
          <div className="m-more">
            <p className="m-legacy-hint">
              舊版的自由圈畫不再蓋在文宣上。可以逐筆查看，或刪除不需要的圈畫（可復原）。
            </p>
            {room.strokes.length === 0 && <p className="m-empty">沒有舊圈畫了。</p>}
            {room.strokes.map((s) => (
              <div key={s.id} className="m-legacy-row">
                <span className="m-legacy-dot" style={{ background: s.color }} aria-hidden />
                <span className="m-legacy-meta">
                  {versionLabel(room, s.versionId) || "文宣"}
                  <small>{new Date(s.createdAt).toLocaleDateString()}</small>
                </span>
                <button
                  type="button"
                  className="m-btn"
                  onClick={() => {
                    // Show just this one stroke on the poster, then leave view mode clean again.
                    api.setTool("pan");
                    api.selectPin(null);
                    api.setView({ ...view, versionId: s.versionId, compareMode: "single" });
                    api.setPreviewStroke(s.id);
                    setLegacyOpen(false);
                  }}
                >
                  查看
                </button>
                <button type="button" className="m-btn m-btn-danger" onClick={() => api.eraseStroke(s.id)}>
                  刪除
                </button>
              </div>
            ))}
          </div>
        </ModalSheet>
      )}
    </div>
  );
}
